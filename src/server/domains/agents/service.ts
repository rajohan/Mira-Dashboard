import { addMilliseconds, getTime, max as maximumDate, toDate } from "date-fns";
import { Context, Data, Effect, Layer } from "effect";
import * as v from "valibot";

import {
    type AgentConfiguration,
    type AgentStatus,
    type AgentStatusProjection,
    type AgentTaskRun,
    agentStatusSchema,
    agentTaskRunSchema,
} from "../../../contracts/agentModel.ts";
import {
    agentChangePayloadSchema,
    agentRealtimeRoutingSchema,
    agentRealtimeTopic,
} from "../../../contracts/agentRealtime.ts";
import {
    type GetAgentStatusInput,
    type ListAgentStatusesResult,
    type ListAgentTaskHistoryInput,
    type ListAgentTaskHistoryResult,
    type UpdateAgentMetadataInput,
    listAgentStatusesResultSchema,
    listAgentTaskHistoryResultSchema,
} from "../../../contracts/agents.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { isDatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";
import { GatewaySessionsUnavailableError } from "../gatewaySessions/errors.ts";
import type { GatewaySessionsService } from "../gatewaySessions/service.ts";
import { defaultRealtimeRetentionMilliseconds } from "../realtime/retention.ts";
import { dashboardAgentConfiguration, findDashboardAgent } from "./directory.ts";
import { AgentNotFoundError, type AgentOperationError } from "./errors.ts";
import { projectAgentGatewayAvailability } from "./gatewayAvailability.ts";
import type {
    AgentRepository,
    AgentRepositoryUnitOfWork,
    AgentRunActor,
    AgentTaskRunRecord,
} from "./repository.ts";

const clockSchema = timestampMillisecondsSchema("Agent clock is invalid");
const realtimeRetentionSchema = positiveSafeIntegerSchema(
    "Agent realtime retention must be a positive integer"
);
const gatewaySessionFallbackActor: AgentRunActor = Object.freeze({
    id: "gateway-session-fallback",
    kind: "automation",
});

class AgentUnexpectedOperationError extends Data.TaggedError(
    "AgentUnexpectedOperationError"
)<{ readonly cause: unknown }> {}

interface AgentServiceShape {
    readonly getConfiguration: () => Effect.Effect<AgentConfiguration>;
    readonly getStatus: (
        input: GetAgentStatusInput,
        signal?: AbortSignal
    ) => Effect.Effect<AgentStatusProjection, AgentNotFoundError>;
    readonly listStatuses: (
        signal?: AbortSignal
    ) => Effect.Effect<ListAgentStatusesResult>;
    readonly listTaskHistory: (
        input: ListAgentTaskHistoryInput
    ) => Effect.Effect<ListAgentTaskHistoryResult, AgentNotFoundError>;
    readonly updateMetadata: (
        principal: AuthenticatedPrincipal,
        input: UpdateAgentMetadataInput
    ) => Effect.Effect<AgentStatus, AgentOperationError>;
}

/** Effect service for Dashboard-owned agent configuration, status, and history. */
export class AgentService extends Context.Service<AgentService, AgentServiceShape>()(
    "mira-dashboard/server/domains/agents/AgentService"
) {}

export interface AgentServiceDependencies {
    readonly generateId?: () => string;
    readonly gatewaySessionsService: GatewaySessionsService;
    readonly nowMs?: () => number;
    readonly realtimeRetentionMs?: number;
    readonly repository: AgentRepository;
    readonly wakeEventPump?: () => Promise<void> | void;
}

function requireConfiguredAgent(agentId: string): void {
    if (findDashboardAgent(agentId) === undefined) {
        throw new AgentNotFoundError({
            agentId,
            message: "Agent was not found",
        });
    }
}

function operationActor(principal: AuthenticatedPrincipal): AgentRunActor {
    return principal.kind === "automation"
        ? { id: principal.id, kind: "automation" }
        : { id: principal.id, kind: "user" };
}

function toTaskRun(record: AgentTaskRunRecord): AgentTaskRun {
    if (findDashboardAgent(record.agentId) === undefined) {
        throw new Error("Persisted agent task run references an unknown agent");
    }
    return v.parse(agentTaskRunSchema, {
        agentId: record.agentId,
        ...(record.completedAt === null
            ? { status: "active" }
            : { completedAtMs: getTime(record.completedAt), status: "completed" }),
        id: record.id,
        lastActivityAtMs: getTime(record.lastActivityAt),
        startedAtMs: getTime(record.startedAt),
        task: record.task,
    });
}

function statusFromRecord(agentId: string, record?: AgentTaskRunRecord): AgentStatus {
    if (record?.completedAt === null) {
        return v.parse(agentStatusSchema, {
            agentId,
            currentTask: record.task,
            lastActivityAtMs: getTime(record.lastActivityAt),
            startedAtMs: getTime(record.startedAt),
            state: "working",
        });
    }
    return v.parse(agentStatusSchema, {
        agentId,
        ...(record === undefined
            ? {}
            : {
                  lastActivityAtMs: getTime(record.completedAt ?? record.lastActivityAt),
              }),
        state: "idle",
    });
}

function listTaskStatuses(repository: AgentRepository): AgentStatus[] {
    return repository.withReadTransaction((reader) => {
        const agentIds = dashboardAgentConfiguration.agents
            .map(({ id }) => id)
            .toSorted();
        const activeRuns = reader.listActiveRuns(agentIds);
        if (activeRuns.length > agentIds.length) {
            throw new Error("Agent active-run count is outside its budget");
        }
        const activeByAgent = new Map(activeRuns.map((run) => [run.agentId, run]));
        return agentIds.map((agentId) =>
            statusFromRecord(
                agentId,
                activeByAgent.get(agentId) ?? reader.findLatestRun(agentId)
            )
        );
    });
}

function listTaskHistory(
    repository: AgentRepository,
    input: ListAgentTaskHistoryInput
): ListAgentTaskHistoryResult {
    if (input.agentId !== undefined) requireConfiguredAgent(input.agentId);
    const records = repository.listTaskRuns(input);
    const hasNextPage = records.length > input.limit;
    const page = records.slice(0, input.limit).map((record) => toTaskRun(record));
    const last = page.at(-1);
    return v.parse(listAgentTaskHistoryResultSchema, {
        ...(hasNextPage && last !== undefined
            ? {
                  nextCursor: {
                      id: last.id,
                      startedAtMs: last.startedAtMs,
                  },
              }
            : {}),
        runs: page,
    });
}

function appendRealtimeEvent(
    unit: AgentRepositoryUnitOfWork,
    agentId: string,
    occurredAt: Date,
    retentionMs: number
): void {
    v.parse(agentRealtimeRoutingSchema, {
        entityType: "agent",
        operation: "updated",
        topic: agentRealtimeTopic,
    });
    const payload = v.parse(agentChangePayloadSchema, { id: agentId });
    unit.insertRealtimeEvent({
        entityId: agentId,
        entityType: "agent",
        expiresAt: addMilliseconds(occurredAt, retentionMs),
        occurredAt,
        operation: "updated",
        payloadJson: JSON.stringify(payload),
        topic: agentRealtimeTopic,
    });
}

function requiredWrite(
    record: AgentTaskRunRecord | undefined,
    operation: string
): AgentTaskRunRecord {
    if (record === undefined) {
        throw new Error(`Agent ${operation} changed unexpectedly`);
    }
    return record;
}

function insertRun(
    unit: AgentRepositoryUnitOfWork,
    input: UpdateAgentMetadataInput & { readonly currentTask: string },
    actor: AgentRunActor,
    occurredAt: Date,
    generateId: () => string
): AgentTaskRunRecord {
    return requiredWrite(
        unit.insertRun({
            agentId: input.agentId,
            completedAt: null,
            completedById: null,
            completedByKind: null,
            id: generateId(),
            lastActivityAt: occurredAt,
            lastUpdatedById: actor.id,
            lastUpdatedByKind: actor.kind,
            startedAt: occurredAt,
            startedById: actor.id,
            startedByKind: actor.kind,
            task: input.currentTask,
        }),
        "task-run insert"
    );
}

interface MutationResult {
    readonly changed: boolean;
    readonly status: AgentStatus;
}

function updateInsideTransaction(
    unit: AgentRepositoryUnitOfWork,
    input: UpdateAgentMetadataInput,
    actor: AgentRunActor,
    now: Date,
    generateId: () => string,
    retentionMs: number
): MutationResult {
    const active = unit.findActiveRun(input.agentId);
    const latest = active ?? unit.findLatestRun(input.agentId);
    const latestActivityAt = latest?.completedAt ?? latest?.lastActivityAt;
    const occurredAt = maximumDate([
        now,
        ...(latestActivityAt === undefined ? [] : [latestActivityAt]),
    ]);

    if (input.currentTask === null) {
        if (active === undefined) {
            return {
                changed: false,
                status: statusFromRecord(input.agentId, latest),
            };
        }
        const completed = requiredWrite(
            unit.completeRun(active.id, occurredAt, actor),
            "task-run completion"
        );
        appendRealtimeEvent(unit, input.agentId, occurredAt, retentionMs);
        return { changed: true, status: statusFromRecord(input.agentId, completed) };
    }

    if (active?.task === input.currentTask) {
        const touched = requiredWrite(
            unit.touchRun(active.id, occurredAt, actor),
            "task-run touch"
        );
        return { changed: false, status: statusFromRecord(input.agentId, touched) };
    }

    if (active !== undefined) {
        requiredWrite(
            unit.completeRun(active.id, occurredAt, actor),
            "task-run replacement"
        );
    }
    const startedAt =
        latestActivityAt === undefined
            ? occurredAt
            : maximumDate([now, addMilliseconds(latestActivityAt, 1)]);
    const inserted = insertRun(
        unit,
        { ...input, currentTask: input.currentTask },
        actor,
        startedAt,
        generateId
    );
    appendRealtimeEvent(unit, input.agentId, startedAt, retentionMs);
    return { changed: true, status: statusFromRecord(input.agentId, inserted) };
}

function unexpected(error: unknown): AgentNotFoundError | AgentUnexpectedOperationError {
    return error instanceof AgentNotFoundError
        ? error
        : new AgentUnexpectedOperationError({ cause: error });
}

function readEffect<T>(operation: () => T): Effect.Effect<T, AgentNotFoundError> {
    return Effect.try({ catch: unexpected, try: operation }).pipe(
        Effect.catchTag("AgentUnexpectedOperationError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function mutationEffect<T>(
    operation: () => Promise<T>
): Effect.Effect<T, AgentOperationError> {
    return Effect.tryPromise({
        catch: (error) =>
            error instanceof AgentNotFoundError ||
            isDatabaseRuntimeWriteUnavailableError(error)
                ? error
                : new AgentUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("AgentUnexpectedOperationError", (error) =>
            Effect.die(error.cause)
        )
    );
}

/**
 * Creates the agent application service over validated admitted persistence.
 * @param dependencies Repository, Gateway sessions, clock, IDs, and realtime wakeup.
 * @returns Effect service with typed expected agent-domain failures.
 */
export function createAgentService(
    dependencies: AgentServiceDependencies
): AgentService["Service"] {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const retentionMs = parseSchemaWithRangeError(
        realtimeRetentionSchema,
        dependencies.realtimeRetentionMs ?? defaultRealtimeRetentionMilliseconds
    );
    const now = () => toDate(v.parse(clockSchema, nowMs()));
    const observedGatewayAvailability = new Map<string, "active" | "idle">();

    async function statusesWithGatewayAvailability(
        statuses: readonly AgentStatus[],
        signal?: AbortSignal
    ): Promise<AgentStatusProjection[]> {
        let snapshot;
        try {
            snapshot = await dependencies.gatewaySessionsService.list(
                { filter: "ALL" },
                signal
            );
        } catch (error) {
            if (error instanceof GatewaySessionsUnavailableError) {
                return projectAgentGatewayAvailability(statuses);
            }
            throw error;
        }

        const projections = projectAgentGatewayAvailability(statuses, snapshot);
        const transitionedToIdle = projections.filter((projection) => {
            if (
                projection.freshness !== "fresh" ||
                (projection.gatewayAvailability !== "active" &&
                    projection.gatewayAvailability !== "idle")
            ) {
                return false;
            }
            const previous = observedGatewayAvailability.get(projection.agentId);
            observedGatewayAvailability.set(
                projection.agentId,
                projection.gatewayAvailability
            );
            return (
                previous === "active" &&
                projection.gatewayAvailability === "idle" &&
                projection.state === "working"
            );
        });
        if (transitionedToIdle.length === 0) return projections;

        const fallbackCompleted = await dependencies.repository.withImmediateTransaction(
            (unit) => {
                let changed = false;
                for (const transition of transitionedToIdle) {
                    if (transition.state !== "working") continue;
                    const active = unit.findActiveRun(transition.agentId);
                    if (
                        active === undefined ||
                        active.task !== transition.currentTask ||
                        getTime(active.startedAt) !== transition.startedAtMs ||
                        getTime(active.lastActivityAt) !== transition.lastActivityAtMs
                    ) {
                        continue;
                    }
                    const occurredAt = maximumDate([
                        now(),
                        active.lastActivityAt,
                        ...(transition.observedAtMs === undefined
                            ? []
                            : [toDate(transition.observedAtMs)]),
                    ]);
                    requiredWrite(
                        unit.completeRun(
                            active.id,
                            occurredAt,
                            gatewaySessionFallbackActor
                        ),
                        "Gateway-idle task-run completion"
                    );
                    appendRealtimeEvent(
                        unit,
                        transition.agentId,
                        occurredAt,
                        retentionMs
                    );
                    changed = true;
                }
                return changed;
            }
        );
        if (!fallbackCompleted) return projections;
        if (dependencies.wakeEventPump !== undefined) {
            try {
                await dependencies.wakeEventPump();
            } catch {
                // SQLite remains authoritative; adaptive polling recovers the wakeup.
            }
        }
        const requestedAgentIds = new Set(statuses.map(({ agentId }) => agentId));
        return projectAgentGatewayAvailability(
            listTaskStatuses(dependencies.repository).filter(({ agentId }) =>
                requestedAgentIds.has(agentId)
            ),
            snapshot
        );
    }

    return AgentService.of({
        getConfiguration: () => Effect.succeed(dashboardAgentConfiguration),
        getStatus: (input, signal) =>
            readEffect(() => {
                requireConfiguredAgent(input.id);
                return dependencies.repository.withReadTransaction((reader) =>
                    statusFromRecord(
                        input.id,
                        reader.findActiveRun(input.id) ?? reader.findLatestRun(input.id)
                    )
                );
            }).pipe(
                Effect.flatMap((status) =>
                    Effect.promise(async () => {
                        const [projection] = await statusesWithGatewayAvailability(
                            [status],
                            signal
                        );
                        if (projection === undefined) {
                            throw new Error("Agent status projection is missing");
                        }
                        return projection;
                    })
                )
            ),
        listStatuses: (signal) =>
            Effect.sync(() => listTaskStatuses(dependencies.repository)).pipe(
                Effect.flatMap((statuses) =>
                    Effect.promise(async () =>
                        v.parse(listAgentStatusesResultSchema, {
                            statuses: await statusesWithGatewayAvailability(
                                statuses,
                                signal
                            ),
                        })
                    )
                )
            ),
        listTaskHistory: (input) =>
            readEffect(() => listTaskHistory(dependencies.repository, input)),
        updateMetadata: (principal, input) =>
            mutationEffect(async () => {
                requireConfiguredAgent(input.agentId);
                const result = await dependencies.repository.withImmediateTransaction(
                    (unit) =>
                        updateInsideTransaction(
                            unit,
                            input,
                            operationActor(principal),
                            now(),
                            generateId,
                            retentionMs
                        )
                );
                if (result.changed && dependencies.wakeEventPump !== undefined) {
                    try {
                        await dependencies.wakeEventPump();
                    } catch {
                        // SQLite remains authoritative; adaptive polling recovers the wakeup.
                    }
                }
                return result.status;
            }),
    });
}

/**
 * Provides the agent service as an Effect layer.
 * @param dependencies Repository, Gateway sessions, clock, IDs, and realtime wakeup.
 * @returns Layer containing one agent service.
 */
export function agentServiceLayer(
    dependencies: AgentServiceDependencies
): Layer.Layer<AgentService> {
    return Layer.succeed(AgentService, createAgentService(dependencies));
}
