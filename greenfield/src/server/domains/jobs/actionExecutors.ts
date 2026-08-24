import { Effect } from "effect";
import * as v from "valibot";

import {
    logMaintenanceJobResultSchema,
    type LogMaintenancePolicyId,
    type LogMaintenanceExecutionSummary,
    logMaintenancePolicyIdSchema,
} from "../../../contracts/logs.ts";
import type { JsonObject } from "../../../shared/json.ts";
import { collectSystemHostPayload } from "../cache/systemHostProvider.ts";
import { parseWorkspaceFileJobPayload } from "../files/jobPayload.ts";
import type { MoltbookDashboardCollector } from "../moltbook/provider.ts";
import {
    type JobActionExecutor,
    type JobExecutableActionDefinition,
    type JobActionRegistration,
    type JobActionSuccessfulSettlementHandler,
    JobActionRetryableError,
    jobActionDefinitions,
    logMaintenanceJobActionKey,
    validateJobActionRegistration,
    workspaceFileReplaceJobActionDefinition,
    workspaceFileReplaceJobActionKey,
    workspaceFileWriteJobActionDefinition,
    workspaceFileWriteJobActionKey,
} from "./actionRegistry.ts";

const emptyPayloadSchema = v.strictObject({});
const systemHostActionPayloadSchema = v.strictObject({ key: v.literal("system.host") });
const moltbookDashboardActionPayloadSchema = v.strictObject({
    key: v.literal("moltbook.dashboard"),
});
const logMaintenanceActionPayloadSchema = v.pipe(
    v.strictObject({
        dryRun: v.optional(v.boolean("Log maintenance mode is invalid"), false),
        policyId: logMaintenancePolicyIdSchema,
    }),
    v.check(
        ({ dryRun, policyId }) => !dryRun || policyId === "docker-managed",
        "Dry-run is available only for managed application and container logs"
    )
);
const smokeResultSchema = v.strictObject({
    checkedAtMs: v.pipe(
        v.number("Worker smoke timestamp is invalid"),
        v.safeInteger("Worker smoke timestamp is invalid"),
        v.minValue(0, "Worker smoke timestamp is invalid")
    ),
    databaseReleaseId: v.pipe(
        v.string("Worker smoke release is invalid"),
        v.length(40, "Worker smoke release is invalid"),
        v.regex(/^[0-9a-f]{40}$/u, "Worker smoke release is invalid")
    ),
    status: v.literal("ok"),
    workerInstanceId: v.pipe(
        v.string("Worker smoke identity is invalid"),
        v.uuid("Worker smoke identity is invalid")
    ),
});
const workspaceFileWriteResultSchema = v.strictObject({
    modifiedAtMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    revision: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    sizeBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    status: v.literal("completed"),
    ticketId: v.pipe(v.string(), v.uuid()),
});

interface JobActionExecutorEntry {
    readonly actionKey: string;
    readonly afterSuccessfulSettlement?: JobActionSuccessfulSettlementHandler;
    readonly execute: JobActionExecutor;
}

/** Narrow worker-owned authority consumed by the durable action adapter. */
export interface LogMaintenanceExecutionPort {
    readonly run: (
        policyId: LogMaintenancePolicyId,
        dryRun: boolean,
        signal?: AbortSignal
    ) => Promise<LogMaintenanceExecutionSummary | undefined>;
}

/** Worker-only structural authority; web composition receives only its durable queue. */
export interface WorkspaceFileWriteExecutionPort {
    readonly apply: (
        command: ReturnType<typeof parseWorkspaceFileJobPayload>["command"],
        signal?: AbortSignal
    ) => Promise<{
        readonly modifiedAtMs: number;
        readonly revision: string;
        readonly sizeBytes: number;
    }>;
    readonly removeSettledReplacementIntent: (
        command: ReturnType<typeof parseWorkspaceFileJobPayload>["command"]
    ) => Promise<void>;
}

export type JobWorkerActionResolver = (
    actionKey: string
) => JobActionRegistration | undefined;

const workerSmokeExecutor: JobActionExecutor = (context, payload: JsonObject) =>
    Effect.sync(() => {
        v.parse(emptyPayloadSchema, payload);
        return v.parse(smokeResultSchema, {
            checkedAtMs: context.nowMs(),
            databaseReleaseId: context.databaseReleaseId,
            status: "ok",
            workerInstanceId: context.workerInstanceId,
        });
    });

export interface SystemHostExecutorDependencies {
    readonly collect?: typeof collectSystemHostPayload;
    readonly monotonicNowMs?: () => number;
}

interface CacheRefreshExecutorSpec<TPayload extends JsonObject> {
    readonly collect: (signal: AbortSignal) => Promise<TPayload>;
    readonly failureCode: string;
    readonly failureMessage: string;
    readonly key: string;
    readonly metadata: JsonObject;
    readonly monotonicNowMs: () => number;
    readonly schemaId: string;
    readonly source: string;
    readonly ttlMs: number;
    readonly validatePayload: (payload: JsonObject) => void;
}

function createCacheRefreshExecutor<TPayload extends JsonObject>(
    spec: CacheRefreshExecutorSpec<TPayload>
): JobActionExecutor {
    return (context, payload) =>
        Effect.suspend(() => {
            spec.validatePayload(payload);
            const startedAt = spec.monotonicNowMs();
            const durationMs = (): number =>
                Math.max(0, Math.floor(spec.monotonicNowMs() - startedAt));
            const collected = Effect.tryPromise({
                catch: (error) => new JobActionRetryableError(error),
                try: (signal) => spec.collect(signal),
            }).pipe(
                Effect.catch((error) =>
                    Effect.tryPromise(() =>
                        context.commitCacheAttempt({
                            durationMs: durationMs(),
                            failureCode: spec.failureCode,
                            failureMessage: spec.failureMessage,
                            key: spec.key,
                            kind: "failed",
                        })
                    ).pipe(Effect.andThen(Effect.fail(error)))
                )
            );
            return collected.pipe(
                Effect.flatMap((cachePayload) =>
                    Effect.tryPromise(() =>
                        context.commitCacheAttempt({
                            durationMs: durationMs(),
                            entries: [
                                {
                                    key: spec.key,
                                    metadata: spec.metadata,
                                    payload: cachePayload,
                                    schemaId: spec.schemaId,
                                    source: spec.source,
                                    ttlMs: spec.ttlMs,
                                },
                            ],
                            kind: "succeeded",
                        })
                    ).pipe(
                        Effect.as({
                            cacheKeys: [spec.key],
                            completedAtMs: context.nowMs(),
                        })
                    )
                )
            );
        });
}

/**
 * Creates the worker-only system.host executor with injectable host boundaries.
 * @param dependencies Optional host collector and monotonic clock overrides.
 * @returns A worker action executor for the system.host cache provider.
 */
export function createSystemHostExecutor(
    dependencies: SystemHostExecutorDependencies = {}
): JobActionExecutor {
    const collect = dependencies.collect ?? collectSystemHostPayload;
    const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
    return createCacheRefreshExecutor({
        collect: () => collect(),
        failureCode: "provider/system-host-unavailable",
        failureMessage: "System host projection could not be collected.",
        key: "system.host",
        metadata: { kind: "host" },
        monotonicNowMs,
        schemaId: "system.host.v1",
        source: "system.host",
        ttlMs: 86_400_000,
        validatePayload: (payload) => {
            v.parse(systemHostActionPayloadSchema, payload);
        },
    });
}

export interface MoltbookDashboardExecutorDependencies {
    readonly collector: MoltbookDashboardCollector;
    readonly monotonicNowMs?: () => number;
}

/**
 * Creates the worker-only all-or-nothing Moltbook cache refresh executor.
 * @param dependencies Fixed collector and optional monotonic test clock.
 * @returns Claim-fenced cache job executor.
 */
export function createMoltbookDashboardExecutor(
    dependencies: MoltbookDashboardExecutorDependencies
): JobActionExecutor {
    const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
    return createCacheRefreshExecutor({
        collect: (signal) => dependencies.collector.collect(signal),
        failureCode: "provider/moltbook-unavailable",
        failureMessage: "Moltbook dashboard projection could not be collected.",
        key: "moltbook.dashboard",
        metadata: { kind: "dashboard" },
        monotonicNowMs,
        schemaId: "moltbook.dashboard.v1",
        source: "moltbook.api",
        ttlMs: 30 * 60_000,
        validatePayload: (payload) => {
            v.parse(moltbookDashboardActionPayloadSchema, payload);
        },
    });
}

/**
 * Adapts the fixed worker log-maintenance port to one schema-validated durable action.
 * The payload can select only a reviewed policy identity and never carries host paths.
 * @returns A cancellable durable job executor for one fixed policy id.
 */
export function createLogMaintenanceJobExecutor(
    maintenance: LogMaintenanceExecutionPort
): JobActionExecutor {
    return (context, payload) =>
        Effect.tryPromise({
            catch: () => new Error("Log maintenance action failed"),
            try: async (signal) => {
                const { dryRun, policyId } = v.parse(
                    logMaintenanceActionPayloadSchema,
                    payload
                );
                const summary = await maintenance.run(policyId, dryRun, signal);
                return v.parse(logMaintenanceJobResultSchema, {
                    completedAtMs: context.nowMs(),
                    dryRun,
                    policyId,
                    status: "completed",
                    ...(summary === undefined ? {} : { summary }),
                });
            },
        });
}

/**
 * Adapts one schema-validated spooled command to the worker-only structural writer.
 * @param writer Worker-owned descriptor writer.
 * @returns Durable action executor without web-process filesystem authority.
 */
export function createWorkspaceFileWriteJobExecutor(
    writer: WorkspaceFileWriteExecutionPort
): JobActionExecutor {
    return (_context, payload) =>
        Effect.suspend(() => {
            const parsed = parseWorkspaceFileJobPayload(payload);
            return Effect.tryPromise({
                catch: (error) =>
                    parsed.command.operation === "replace"
                        ? new JobActionRetryableError(error)
                        : new Error("Workspace file write action failed", {
                              cause: error,
                          }),
                try: async (signal) => {
                    const result = await writer.apply(parsed.command, signal);
                    return v.parse(workspaceFileWriteResultSchema, {
                        ...result,
                        status: "completed",
                        ticketId: parsed.command.ticketId,
                    });
                },
            });
        });
}

function createWorkspaceFileReplacementSettlementHandler(
    writer: WorkspaceFileWriteExecutionPort
): JobActionSuccessfulSettlementHandler {
    return async (payload) => {
        const parsed = parseWorkspaceFileJobPayload(payload);
        if (parsed.command.operation !== "replace") {
            throw new TypeError("Workspace replacement settlement payload is invalid");
        }
        await writer.removeSettledReplacementIntent(parsed.command);
    };
}

const systemHostExecutor = createSystemHostExecutor();

/**
 * Builds a fail-closed worker registry whose executors exactly match release definitions.
 * @param definitions Release-owned pure action definitions.
 * @param executors Worker-only executors keyed by action identity.
 * @returns A validated worker registry indexed by action key.
 */
export function createJobWorkerActionRegistry(
    definitions: readonly JobExecutableActionDefinition[],
    executors: readonly JobActionExecutorEntry[]
): ReadonlyMap<string, JobActionRegistration> {
    const definitionByKey = new Map(
        definitions.map((definition) => [definition.actionKey, definition])
    );
    const executorByKey = new Map(executors.map((entry) => [entry.actionKey, entry]));
    if (
        definitionByKey.size !== definitions.length ||
        executorByKey.size !== executors.length ||
        definitionByKey.size !== executorByKey.size ||
        [...definitionByKey.keys()].some((key) => !executorByKey.has(key))
    ) {
        throw new Error(
            "Job worker executor keys do not exactly match action definitions"
        );
    }
    return new Map(
        definitions.map((definition) => {
            const executor = executorByKey.get(definition.actionKey);
            if (executor === undefined) {
                throw new Error("Job worker executor registry is incomplete");
            }
            return [
                definition.actionKey,
                validateJobActionRegistration({
                    ...definition,
                    ...(executor.afterSuccessfulSettlement === undefined
                        ? {}
                        : {
                              afterSuccessfulSettlement:
                                  executor.afterSuccessfulSettlement,
                          }),
                    execute: executor.execute,
                }),
            ];
        })
    );
}

/**
 * Creates the worker-only resolver after privileged adapters are composed.
 * Web code can import pure definitions without gaining log-maintenance authority.
 * @returns A fail-closed resolver containing every reviewed worker action.
 */
export interface JobWorkerActionResolverDependencies {
    readonly logMaintenance: LogMaintenanceExecutionPort;
    readonly moltbook: MoltbookDashboardCollector;
    readonly workspaceFiles?: WorkspaceFileWriteExecutionPort;
}

export function createJobWorkerActionResolver(
    dependencies: JobWorkerActionResolverDependencies
): JobWorkerActionResolver {
    const workspaceFiles = dependencies.workspaceFiles;
    const definitions =
        workspaceFiles === undefined
            ? jobActionDefinitions
            : Object.freeze([
                  ...jobActionDefinitions,
                  workspaceFileWriteJobActionDefinition,
                  workspaceFileReplaceJobActionDefinition,
              ]);
    const executors = [
        Object.freeze({
            actionKey: "cache.refresh.system-host",
            execute: systemHostExecutor,
        }),
        Object.freeze({
            actionKey: "cache.refresh.moltbook-dashboard",
            execute: createMoltbookDashboardExecutor({
                collector: dependencies.moltbook,
            }),
        }),
        Object.freeze({
            actionKey: logMaintenanceJobActionKey,
            execute: createLogMaintenanceJobExecutor(dependencies.logMaintenance),
        }),
        Object.freeze({
            actionKey: "system.worker-smoke",
            execute: workerSmokeExecutor,
        }),
        ...(workspaceFiles === undefined
            ? []
            : [
                  Object.freeze({
                      actionKey: workspaceFileWriteJobActionKey,
                      execute: createWorkspaceFileWriteJobExecutor(workspaceFiles),
                  }),
                  Object.freeze({
                      actionKey: workspaceFileReplaceJobActionKey,
                      afterSuccessfulSettlement:
                          createWorkspaceFileReplacementSettlementHandler(workspaceFiles),
                      execute: createWorkspaceFileWriteJobExecutor(workspaceFiles),
                  }),
              ]),
    ];
    const registry = createJobWorkerActionRegistry(definitions, Object.freeze(executors));
    return (actionKey) => registry.get(actionKey);
}
