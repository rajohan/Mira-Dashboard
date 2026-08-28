import { getTime, toDate } from "date-fns";
import { Context, Data, Effect } from "effect";
import * as v from "valibot";

import {
    type CacheEntry,
    type CacheHeartbeatResult,
    type CacheStatusResult,
    type GetCacheEntryInput,
    type RefreshCacheEntryInput,
    cacheHeartbeatBackupSignalSchema,
    cacheHeartbeatDashboardJobsAreConsistent,
    cacheHeartbeatDashboardJobsSchema,
    cacheHeartbeatDatabaseMaintenanceSignalSchema,
    cacheHeartbeatDockerHealthSignalSchema,
    cacheHeartbeatDockerUpdatesSignalSchema,
    cacheHeartbeatGitSignalSchema,
    cacheHeartbeatHostCapacitySignalSchema,
    cacheHeartbeatLogsSignalSchema,
    cacheHeartbeatQuotaSignalSchema,
    cacheHeartbeatResultSchema,
    cacheHeartbeatSchemaVersion,
    cacheHeartbeatTasksSchema,
    cacheHeartbeatWeatherSignalSchema,
    cacheStatusResultSchema,
} from "../../../contracts/cache.ts";
import { type JobRunSummary, jobTimestampSchema } from "../../../contracts/jobModel.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { isDatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    findJobActionDefinition,
    isRegisteredJobSchedule,
} from "../jobs/actionRegistry.ts";
import { preflightManualEnqueue } from "../jobs/manualEnqueue.ts";
import { toJobRunSummary } from "../jobs/records.ts";
import type { JobRepository } from "../jobs/repository.ts";
import {
    createJobMutationSideEffects,
    createJobRealtimeSideEffects,
    type JobAuditActor,
} from "../jobs/sideEffects.ts";
import {
    CacheConflictError,
    CacheNotFoundError,
    type CacheOperationError,
} from "./errors.ts";
import type { CacheHeartbeatDashboardJobsRead } from "./heartbeatProjection.ts";
import { findCacheProviderDefinition } from "./providerRegistry.ts";
import { toCacheEntry, toCacheEntryStatus } from "./records.ts";
import type { CacheRepository } from "./repository.ts";

interface AuthenticatedCacheActor {
    readonly id: string;
    readonly kind: "automation" | "user";
}

function principalActor(principal: AuthenticatedPrincipal): AuthenticatedCacheActor {
    return {
        id: principal.id,
        kind: principal.kind === "session" ? "user" : "automation",
    };
}

function principalAuditActor(principal: AuthenticatedPrincipal): JobAuditActor {
    return {
        authenticatorId: principal.authenticatorId,
        id: principal.id,
        kind: principal.kind === "session" ? "user" : "automation",
    };
}

class CacheUnexpectedOperationError extends Data.TaggedError(
    "CacheUnexpectedOperationError"
)<{ readonly cause: unknown }> {}

function readEffect<T, E>(
    operation: () => T,
    isExpected: (error: unknown) => error is E
): Effect.Effect<T, E> {
    return Effect.try({
        catch: (error) =>
            isExpected(error)
                ? error
                : new CacheUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchIf(
            (error): error is CacheUnexpectedOperationError =>
                error instanceof CacheUnexpectedOperationError,
            (error) => Effect.die(error.cause)
        )
    );
}

function asyncReadEffect<T>(operation: () => Promise<T>): Effect.Effect<T> {
    return Effect.tryPromise({
        catch: (cause) => new CacheUnexpectedOperationError({ cause }),
        try: operation,
    }).pipe(
        Effect.catchTag("CacheUnexpectedOperationError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function asUnknownRecord(value: unknown): Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null
        ? (value as Readonly<Record<string, unknown>>)
        : {};
}

function mutationEffect<T>(
    operation: () => Promise<T>
): Effect.Effect<T, CacheOperationError> {
    return Effect.tryPromise({
        catch: (error) =>
            error instanceof CacheConflictError ||
            error instanceof CacheNotFoundError ||
            isDatabaseRuntimeWriteUnavailableError(error)
                ? error
                : new CacheUnexpectedOperationError({ cause: error }),
        try: operation,
    }).pipe(
        Effect.catchTag("CacheUnexpectedOperationError", (error) =>
            Effect.die(error.cause)
        )
    );
}

function demoteSessionsWhenDisconnected(
    projection: CacheHeartbeatResult["gateway"]["sessions"],
    connection: CacheHeartbeatResult["gateway"]["connection"]
): CacheHeartbeatResult["gateway"]["sessions"] {
    if (connection.freshness === "fresh" || projection.state !== "fresh") {
        return projection;
    }
    return {
        count: projection.count,
        observedAtMs: projection.observedAtMs,
        staleSinceMs: Math.max(connection.checkedAtMs, projection.observedAtMs),
        state: "last-known-good",
        truncated: projection.truncated,
    };
}

function demoteCronWhenDisconnected(
    projection: CacheHeartbeatResult["openClawCron"],
    connection: CacheHeartbeatResult["gateway"]["connection"]
): CacheHeartbeatResult["openClawCron"] {
    if (connection.freshness === "fresh" || projection.state !== "fresh") {
        return projection;
    }
    return {
        count: projection.count,
        health: projection.health,
        observedAtMs: projection.observedAtMs,
        pendingSync: projection.pendingSync,
        staleSinceMs: Math.max(connection.checkedAtMs, projection.observedAtMs),
        state: "last-known-good",
    };
}

function demoteTaskCronWhenGlobalCronIsNotFresh(
    tasks: CacheHeartbeatResult["tasks"],
    openClawCron: CacheHeartbeatResult["openClawCron"]
): CacheHeartbeatResult["tasks"] {
    if (tasks.state === "unavailable" || openClawCron.state === "fresh") {
        return tasks;
    }
    return {
        ...tasks,
        items: tasks.items.map((task) =>
            task.automation === undefined
                ? task
                : {
                      ...task,
                      automation: {
                          ...task.automation,
                          cron: { state: "unavailable" },
                      },
                  }
        ),
    };
}

export interface CacheServiceShape {
    readonly getEntry: (
        input: GetCacheEntryInput
    ) => Effect.Effect<CacheEntry, CacheNotFoundError>;
    readonly getHeartbeat: () => Effect.Effect<CacheHeartbeatResult>;
    readonly getStatus: () => Effect.Effect<CacheStatusResult>;
    readonly refreshEntry: (
        principal: AuthenticatedPrincipal,
        input: RefreshCacheEntryInput
    ) => Effect.Effect<JobRunSummary, CacheOperationError>;
}

export class CacheService extends Context.Service<CacheService, CacheServiceShape>()(
    "mira-dashboard/server/domains/cache/CacheService"
) {}

export interface CacheServiceDependencies {
    readonly cacheRepository: CacheRepository;
    readonly generateId?: () => string;
    readonly jobRepository: JobRepository;
    readonly nowMs?: () => number;
    readonly readGatewayConnection?: () => CacheHeartbeatResult["gateway"]["connection"];
    readonly readGatewaySessionsProjection?: () => CacheHeartbeatResult["gateway"]["sessions"];
    readonly refreshGatewaySessionsProjection?: () => Promise<void>;
    readonly readHeartbeatDashboardJobs?: (
        generatedAtMs: number
    ) => CacheHeartbeatDashboardJobsRead;
    readonly readHeartbeatTasks?: () =>
        | CacheHeartbeatResult["tasks"]
        | Promise<CacheHeartbeatResult["tasks"]>;
    readonly readOpenClawCronProjection?: () => CacheHeartbeatResult["openClawCron"];
    readonly readOperationalSignals?: () =>
        | CacheHeartbeatResult["operationalSignals"]
        | Promise<CacheHeartbeatResult["operationalSignals"]>;
    readonly wakeEventPump?: () => Promise<void> | void;
}

/**
 * Creates the cache read and durable manual-refresh service.
 * @param dependencies Repository, clock, identity, and event-pump boundaries.
 * @returns The cache service implementation.
 */
export function createCacheService(
    dependencies: CacheServiceDependencies
): CacheService["Service"] {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;

    function readCacheStatus(candidateNowMs = nowMs()): CacheStatusResult {
        const snapshot = dependencies.cacheRepository.readStatus();
        const generatedAtMs = v.parse(
            jobTimestampSchema,
            Math.max(
                candidateNowMs,
                ...snapshot.entries.map((entry) => getTime(entry.updatedAt))
            )
        );
        return v.parse(cacheStatusResultSchema, {
            entries: snapshot.entries.map((entry) =>
                toCacheEntryStatus(entry, generatedAtMs)
            ),
            generatedAtMs,
            totalCount: snapshot.totalCount,
            truncated: snapshot.totalCount > snapshot.entries.length,
        });
    }

    function readConnection(
        checkedAtMs: number
    ): CacheHeartbeatResult["gateway"]["connection"] {
        try {
            const connection = dependencies.readGatewayConnection?.();
            if (connection !== undefined) {
                return {
                    checkedAtMs: connection.checkedAtMs,
                    freshness: connection.freshness,
                    phase: connection.phase,
                };
            }
        } catch {
            // Heartbeat reports the projection as unavailable without raw failure data.
        }
        return { checkedAtMs, freshness: "unavailable", phase: "stopped" };
    }

    function readSessionsProjection(): CacheHeartbeatResult["gateway"]["sessions"] {
        try {
            return (
                dependencies.readGatewaySessionsProjection?.() ?? {
                    state: "unavailable",
                }
            );
        } catch {
            return { state: "unavailable" };
        }
    }

    function readCronProjection(): CacheHeartbeatResult["openClawCron"] {
        try {
            return (
                dependencies.readOpenClawCronProjection?.() ?? {
                    pendingSync: "unknown",
                    state: "unavailable",
                }
            );
        } catch {
            return { pendingSync: "unknown", state: "unavailable" };
        }
    }

    async function readTasksProjection(): Promise<CacheHeartbeatResult["tasks"]> {
        try {
            return v.parse(
                cacheHeartbeatTasksSchema,
                (await dependencies.readHeartbeatTasks?.()) ?? {
                    state: "unavailable",
                }
            );
        } catch {
            return { state: "unavailable" };
        }
    }

    async function readOperationalSignals(): Promise<
        CacheHeartbeatResult["operationalSignals"]
    > {
        const unavailable = { state: "unavailable" as const };
        const unavailableSignals = (): CacheHeartbeatResult["operationalSignals"] => ({
            backups: { kopia: unavailable, walg: unavailable },
            database: {
                postgresqlMaintenance: unavailable,
                sqliteMaintenance: unavailable,
            },
            docker: { health: unavailable, updates: unavailable },
            git: unavailable,
            hostCapacity: unavailable,
            logs: unavailable,
            quota: unavailable,
            weather: unavailable,
        });
        const parseSignal = <T>(
            schema: v.GenericSchema<unknown, T>,
            value: unknown
        ): T => {
            const parsed = v.safeParse(schema, value);
            return parsed.success ? parsed.output : (unavailable as T);
        };
        try {
            const candidate = await dependencies.readOperationalSignals?.();
            if (candidate === undefined) return unavailableSignals();
            const signals = asUnknownRecord(candidate);
            const backups = asUnknownRecord(signals.backups);
            const database = asUnknownRecord(signals.database);
            const docker = asUnknownRecord(signals.docker);
            return {
                backups: {
                    kopia: parseSignal(cacheHeartbeatBackupSignalSchema, backups.kopia),
                    walg: parseSignal(cacheHeartbeatBackupSignalSchema, backups.walg),
                },
                database: {
                    postgresqlMaintenance: parseSignal(
                        cacheHeartbeatDatabaseMaintenanceSignalSchema,
                        database.postgresqlMaintenance
                    ),
                    sqliteMaintenance: parseSignal(
                        cacheHeartbeatDatabaseMaintenanceSignalSchema,
                        database.sqliteMaintenance
                    ),
                },
                docker: {
                    health: parseSignal(
                        cacheHeartbeatDockerHealthSignalSchema,
                        docker.health
                    ),
                    updates: parseSignal(
                        cacheHeartbeatDockerUpdatesSignalSchema,
                        docker.updates
                    ),
                },
                git: parseSignal(cacheHeartbeatGitSignalSchema, signals.git),
                hostCapacity: parseSignal(
                    cacheHeartbeatHostCapacitySignalSchema,
                    signals.hostCapacity
                ),
                logs: parseSignal(cacheHeartbeatLogsSignalSchema, signals.logs),
                quota: parseSignal(cacheHeartbeatQuotaSignalSchema, signals.quota),
                weather: parseSignal(cacheHeartbeatWeatherSignalSchema, signals.weather),
            };
        } catch {
            return unavailableSignals();
        }
    }

    function readDashboardJobsProjection(
        generatedAtMs: number
    ): CacheHeartbeatDashboardJobsRead {
        try {
            const read = dependencies.readHeartbeatDashboardJobs?.(generatedAtMs) ?? {
                dashboardJobs: { state: "unavailable" },
                generatedAtMs,
            };
            const clampedGeneratedAtMs = v.parse(
                jobTimestampSchema,
                Math.max(generatedAtMs, read.generatedAtMs)
            );
            const dashboardJobs = v.parse(
                cacheHeartbeatDashboardJobsSchema,
                read.dashboardJobs
            );
            if (
                !cacheHeartbeatDashboardJobsAreConsistent(
                    dashboardJobs,
                    clampedGeneratedAtMs
                )
            ) {
                throw new Error("Heartbeat Dashboard-job reader is inconsistent");
            }
            return { dashboardJobs, generatedAtMs: clampedGeneratedAtMs };
        } catch {
            return {
                dashboardJobs: { state: "unavailable" },
                generatedAtMs,
            };
        }
    }

    async function wake(): Promise<void> {
        if (dependencies.wakeEventPump === undefined) return;
        try {
            await dependencies.wakeEventPump();
        } catch {
            // Durable outbox state is authoritative.
        }
    }

    return {
        getEntry: (input) =>
            readEffect(
                () => {
                    const provider = findCacheProviderDefinition(input.key);
                    if (provider === undefined) {
                        throw new CacheNotFoundError({ key: input.key });
                    }
                    const record = dependencies.cacheRepository.findEntry(input.key);
                    if (record === undefined) {
                        throw new CacheNotFoundError({ key: input.key });
                    }
                    const readAtMs = v.parse(
                        jobTimestampSchema,
                        Math.max(
                            v.parse(jobTimestampSchema, nowMs()),
                            getTime(record.updatedAt)
                        )
                    );
                    return toCacheEntry(record, readAtMs);
                },
                (error): error is CacheNotFoundError =>
                    error instanceof CacheNotFoundError
            ),
        getHeartbeat: () =>
            asyncReadEffect(async () => {
                const requestedAtMs = v.parse(jobTimestampSchema, nowMs());
                const cache = readCacheStatus(requestedAtMs);
                const connection = readConnection(requestedAtMs);
                if (connection.phase === "connected") {
                    await dependencies.refreshGatewaySessionsProjection?.();
                }
                const sessions = demoteSessionsWhenDisconnected(
                    readSessionsProjection(),
                    connection
                );
                const taskProjection = await readTasksProjection();
                const operationalSignals = await readOperationalSignals();
                const openClawCron = demoteCronWhenDisconnected(
                    readCronProjection(),
                    connection
                );
                const heartbeatTasks = demoteTaskCronWhenGlobalCronIsNotFresh(
                    taskProjection,
                    openClawCron
                );
                const projectionTimestamps = [
                    cache.generatedAtMs,
                    connection.checkedAtMs,
                    ...(sessions.state === "unavailable"
                        ? []
                        : [
                              sessions.observedAtMs,
                              ...(sessions.state === "last-known-good"
                                  ? [sessions.staleSinceMs]
                                  : []),
                          ]),
                    ...(openClawCron.state === "unavailable"
                        ? []
                        : [
                              openClawCron.observedAtMs,
                              ...(openClawCron.state === "last-known-good"
                                  ? [openClawCron.staleSinceMs]
                                  : []),
                          ]),
                    ...(heartbeatTasks.state === "unavailable"
                        ? []
                        : heartbeatTasks.items.flatMap((task) => {
                              const cron = task.automation?.cron;
                              return cron?.state === "present"
                                  ? [
                                        ...(cron.lastRunAtMs === undefined
                                            ? []
                                            : [cron.lastRunAtMs]),
                                        ...(cron.runningAtMs === undefined
                                            ? []
                                            : [cron.runningAtMs]),
                                    ]
                                  : [];
                          })),
                    ...Object.values({
                        ...operationalSignals.backups,
                        ...operationalSignals.database,
                        ...operationalSignals.docker,
                        git: operationalSignals.git,
                        hostCapacity: operationalSignals.hostCapacity,
                        logs: operationalSignals.logs,
                        quota: operationalSignals.quota,
                        weather: operationalSignals.weather,
                    }).flatMap((signal) =>
                        signal.state === "unavailable"
                            ? []
                            : [
                                  signal.observedAtMs,
                                  ...(signal.state === "last-known-good"
                                      ? [signal.staleSinceMs]
                                      : []),
                              ]
                    ),
                ];
                const initialGeneratedAtMs = Math.max(
                    requestedAtMs,
                    ...projectionTimestamps
                );
                const dashboardJobRead =
                    readDashboardJobsProjection(initialGeneratedAtMs);
                return v.parse(cacheHeartbeatResultSchema, {
                    cache,
                    dashboardJobs: dashboardJobRead.dashboardJobs,
                    gateway: { connection, sessions },
                    generatedAtMs: Math.max(
                        initialGeneratedAtMs,
                        dashboardJobRead.generatedAtMs
                    ),
                    openClawCron,
                    operationalSignals,
                    schemaVersion: cacheHeartbeatSchemaVersion,
                    tasks: heartbeatTasks,
                });
            }),
        getStatus: () =>
            readEffect(
                () => readCacheStatus(),
                (_error): _error is never => false
            ),
        refreshEntry: (principal, input) =>
            mutationEffect(async () => {
                const actor = principalActor(principal);
                const enqueueSha256 = sha256Hex(
                    JSON.stringify({
                        key: input.key,
                        procedure: "cache.refreshEntry",
                        triggerType: input.triggerType,
                        version: 1,
                    })
                );
                const replay = preflightManualEnqueue(dependencies.jobRepository, {
                    enqueueSha256,
                    idempotencyKey: input.idempotencyKey,
                    requestedById: actor.id,
                    requestedByKind: actor.kind,
                });
                if (replay.kind === "idempotency-mismatch") {
                    throw new CacheConflictError({
                        key: input.key,
                        reason: "idempotency-mismatch",
                    });
                }
                if (replay.kind === "replayed") return toJobRunSummary(replay.run);

                const provider = findCacheProviderDefinition(input.key);
                if (provider === undefined) {
                    throw new CacheNotFoundError({ key: input.key });
                }
                const action = findJobActionDefinition(provider.actionKey);
                const relation = dependencies.jobRepository.findSchedule(
                    provider.scheduleId
                );
                if (
                    action?.manualExposure !== "cache-write" ||
                    relation === undefined ||
                    !isRegisteredJobSchedule(
                        relation.schedule.id,
                        relation.schedule.actionKey
                    ) ||
                    relation.schedule.actionKey !== provider.actionKey
                ) {
                    throw new CacheConflictError({
                        key: input.key,
                        reason: "action-unavailable",
                    });
                }
                const schedule = relation.schedule;
                const at = toDate(
                    Math.max(
                        v.parse(jobTimestampSchema, nowMs()),
                        getTime(schedule.updatedAt)
                    )
                );
                const runId = generateId();
                const runEffects = createJobMutationSideEffects({
                    action: "cache.refresh.enqueue",
                    actor: principalAuditActor(principal),
                    auditId: generateId(),
                    occurredAt: at,
                    outcome: "accepted",
                    realtime: { id: runId, kind: "run", operation: "created" },
                    targetId: runId,
                    targetType: "job-run",
                });
                const scheduleEffects = createJobRealtimeSideEffects({
                    occurredAt: at,
                    realtime: {
                        id: schedule.id,
                        kind: "schedule",
                        operation: "updated",
                    },
                });
                const result = await dependencies.jobRepository.enqueueManualRun({
                    auditEvents: runEffects.auditEvents,
                    queuedEvent: {
                        attempt: 0,
                        jobRunId: runId,
                        kind: "queued",
                        message: null,
                        occurredAt: at,
                        progressJson: null,
                        sequence: 1,
                        workerInstanceId: null,
                    },
                    realtimeEvents: Object.freeze([
                        ...runEffects.realtimeEvents,
                        ...scheduleEffects.realtimeEvents,
                    ]),
                    rejectWhenAnyActionActive: [schedule.actionKey],
                    run: {
                        actionKey: schedule.actionKey,
                        attemptLimit: schedule.attemptLimit,
                        availableAt: at,
                        cancellationPolicy: schedule.cancellationPolicy,
                        cancelRequestedAt: null,
                        cancelRequestedById: null,
                        cancelRequestedByKind: null,
                        displayName: schedule.name,
                        enqueueSha256,
                        finishedAt: null,
                        firstStartedAt: null,
                        heartbeatAt: null,
                        id: runId,
                        idempotencyKey: input.idempotencyKey,
                        lastAttemptStartedAt: null,
                        leaseExpiresAt: null,
                        leaseOwnerId: null,
                        leaseToken: null,
                        payloadJson: schedule.actionPayloadJson,
                        priority: schedule.priority,
                        queuedAt: at,
                        requestedById: actor.id,
                        requestedByKind: actor.kind,
                        resourceClass: schedule.resourceClass,
                        resourceKeysJson: schedule.resourceKeysJson,
                        resultJson: null,
                        retrySafe: schedule.retrySafe,
                        scheduledForAt: null,
                        scheduledJobId: null,
                        scheduledJobVersion: null,
                        state: "queued",
                        terminalCode: null,
                        terminalMessage: null,
                        timeoutMs: schedule.timeoutMs,
                        triggerType: input.triggerType,
                        updatedAt: at,
                    },
                });
                if (result.kind === "idempotency-mismatch") {
                    throw new CacheConflictError({
                        key: input.key,
                        reason: "idempotency-mismatch",
                    });
                }
                if (result.kind === "action-unavailable") {
                    throw new CacheConflictError({
                        key: input.key,
                        reason: "action-unavailable",
                    });
                }
                if (result.kind === "active") {
                    throw new CacheConflictError({
                        key: input.key,
                        reason: "run-already-active",
                    });
                }
                if (result.kind === "inserted") await wake();
                return toJobRunSummary(result.run);
            }),
    };
}
