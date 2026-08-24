import { Effect } from "effect";
import * as v from "valibot";

import type { BackupJobExecutionPort } from "../../../contracts/backupsWorker.ts";
import {
    databaseObservabilityCacheKey,
    databaseObservabilityCacheSchemaId,
    databaseObservabilityCacheSource,
    type SqliteMaintenanceExecutionPort,
    sqliteMaintenanceJobResultSchema,
} from "../../../contracts/database.ts";
import type { DatabaseObservabilityCollector } from "../../../contracts/databaseObservabilityCollector.ts";
import {
    gitWorkspaceCacheKey,
    gitWorkspaceCacheSchemaId,
    gitWorkspaceCacheSource,
    gitWorkspaceCacheTtlMs,
    type GitWorkspaceCachePayload,
} from "../../../contracts/gitWorkspace.ts";
import {
    logMaintenanceJobResultSchema,
    type LogMaintenancePolicyId,
    type LogMaintenanceExecutionSummary,
    logMaintenancePolicyIdSchema,
} from "../../../contracts/logs.ts";
import {
    quotaCacheKey,
    quotaCacheSchemaId,
    quotaCacheSource,
    quotaCacheTtlMs,
    type QuotaCachePayload,
} from "../../../contracts/quota.ts";
import {
    weatherCacheKey,
    weatherCacheSchemaId,
    weatherCacheSource,
    weatherCacheTtlMs,
    type WeatherCachePayload,
} from "../../../contracts/weather.ts";
import {
    DatabaseObservabilityCollectionLeaseError,
    databaseObservabilityReconciliationStatuses,
    type DatabaseObservabilityReconciliationPort,
} from "../../../shared/databaseObservabilityReconciliation.ts";
import type { HostOperationId } from "../../../shared/hostOperations.ts";
import type { JsonObject } from "../../../shared/json.ts";
import type { OpenClawGatewayLifecycleExecutionPort } from "../../../shared/openClawGatewayLifecycle.ts";
import {
    OpenClawServiceActionsExecutionError,
    type OpenClawServiceActionsExecutionPort,
} from "../../../shared/openClawServiceActions.ts";
import type { BackupActivityRepository } from "../backups/activityRepository.ts";
import { collectSystemHostPayload } from "../cache/systemHostProvider.ts";
import { parseWorkspaceFileJobPayload } from "../files/jobPayload.ts";
import type { MoltbookDashboardCollector } from "../moltbook/provider.ts";
import {
    type JobActionExecutionContext,
    type JobActionDefinition,
    type JobActionExecutor,
    type JobExecutableActionDefinition,
    type JobActionRegistration,
    type JobActionSuccessfulSettlementHandler,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
    backupClearAttentionJobActionDefinition,
    backupKopiaRunJobActionKey,
    backupStatusJobActionKey,
    backupScheduledJobActionKeys,
    backupWalgRunJobActionKey,
    databaseObservabilityCacheJobActionKey,
    deliveryGitHubJobActionDefinition,
    deliveryOverviewCacheJobActionKey,
    deliveryPreviewJobActionDefinition,
    deliveryProductionJobActionDefinition,
    dockerFreeJobActionDefinitions,
    dockerOperationJobActionDefinition,
    deliveryOverviewCacheJobActionDefinition,
    dockerOperationJobActionKey,
    dockerOverviewCacheJobActionKey,
    dockerUpdaterJobActionKey,
    hostDashboardRestartJobActionDefinition,
    hostDashboardRestartJobActionKey,
    hostDashboardStackRestartJobActionDefinition,
    hostDashboardStackRestartJobActionKey,
    hostDashboardServiceRestartJobResultSchema,
    hostSystemCleanupJobActionDefinition,
    hostSystemCleanupJobActionKey,
    hostSystemCleanupJobResultSchema,
    hostSystemRestartJobActionDefinition,
    hostSystemRestartJobActionKey,
    hostSystemRestartJobResultSchema,
    hostSystemUpdateJobActionDefinition,
    hostSystemUpdateJobActionKey,
    hostSystemUpdateJobResultSchema,
    hostWorkerRestartJobActionDefinition,
    hostWorkerRestartJobActionKey,
    gitWorkspaceCacheJobActionKey,
    jobActionDefinitions,
    logMaintenanceJobActionKey,
    openClawGatewayRestartJobActionDefinition,
    openClawGatewayRestartJobActionKey,
    openClawGatewayRestartJobResultSchema,
    openClawInstallationUpdateJobActionDefinition,
    openClawInstallationUpdateJobActionKey,
    openClawInstallationUpdateJobResultSchema,
    openClawSessionsCleanupJobActionDefinition,
    openClawSessionsCleanupJobActionKey,
    openClawSessionsCleanupJobResultSchema,
    overviewProviderJobActionKeys,
    quotaCacheJobActionKey,
    sqliteMaintenanceJobActionKey,
    validateJobActionRegistration,
    weatherCacheJobActionKey,
    workspaceFileReplaceJobActionDefinition,
    workspaceFileReplaceJobActionKey,
    workspaceFileWriteJobActionDefinition,
    workspaceFileWriteJobActionKey,
} from "./actionRegistry.ts";
import {
    createBackupClearAttentionJobExecutor,
    createBackupRunJobExecutor,
    createBackupStatusJobExecutor,
} from "./backupActionExecutors.ts";
import {
    createDeliveryGitHubJobExecutor,
    createDeliveryOverviewJobExecutor,
    createDeliveryPreviewJobExecutor,
    createDeliveryProductionJobExecutor,
    type DeliveryJobExecutionPort,
} from "./deliveryActionExecutors.ts";
import {
    createDockerOperationJobExecutor,
    createDockerOverviewJobExecutor,
    createDockerUpdaterJobExecutor,
    type DockerJobExecutionPort,
} from "./dockerActionExecutors.ts";

export { hostOperationIds } from "../../../shared/hostOperations.ts";

/** Secret-free result returned by one future, separately privileged host adapter. */
export type FixedHostOperationResult =
    | Readonly<{ status: "accepted" }>
    | Readonly<{ status: "completed" }>;

/** Worker-only fixed-operation authority; no command or path crosses this port. */
export interface FixedHostOperationsExecutionPort {
    readonly availableOperations: (
        signal?: AbortSignal
    ) => Promise<readonly HostOperationId[]>;
    readonly request: (
        operationId: HostOperationId,
        signal?: AbortSignal
    ) => Promise<FixedHostOperationResult>;
}

const emptyPayloadSchema = v.strictObject({});
const systemHostActionPayloadSchema = v.strictObject({ key: v.literal("system.host") });
const moltbookDashboardActionPayloadSchema = v.strictObject({
    key: v.literal("moltbook.dashboard"),
});
const databaseObservabilityActionPayloadSchema = v.strictObject({
    key: v.literal(databaseObservabilityCacheKey),
});
const gitWorkspaceActionPayloadSchema = v.strictObject({
    key: v.literal(gitWorkspaceCacheKey),
});
const quotaActionPayloadSchema = v.strictObject({ key: v.literal(quotaCacheKey) });
const weatherActionPayloadSchema = v.strictObject({ key: v.literal(weatherCacheKey) });
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
    readonly collect: (
        signal: AbortSignal,
        context: JobActionExecutionContext
    ) => Promise<TPayload>;
    readonly failureCode: string;
    readonly failureMessage: string;
    readonly key: string;
    readonly metadata: JsonObject;
    readonly monotonicNowMs: () => number;
    readonly schemaId: string;
    readonly source: string;
    readonly ttlMs: number;
    readonly validatePayload: (payload: JsonObject) => void;
    readonly waitForCancellationSettlement?: boolean;
}

function cleanupSafePromiseEffect<T, E>(options: {
    readonly catch: (error: unknown) => E;
    readonly try: (signal: AbortSignal) => Promise<T>;
}): Effect.Effect<T, E> {
    return Effect.callback<T, E>((resume) => {
        const controller = new AbortController();
        const settlement = Promise.resolve()
            .then(() => options.try(controller.signal))
            .then(
                (value) => resume(Effect.succeed(value)),
                (error: unknown) => resume(Effect.fail(options.catch(error)))
            );
        return Effect.sync(() => {
            controller.abort(
                new DOMException("Job action was interrupted", "AbortError")
            );
        }).pipe(
            // The caller cannot settle cancellation until the promise's
            // mandatory cleanup has completed.
            Effect.andThen(Effect.promise(() => settlement))
        );
    });
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
            const collect = {
                catch: (error: unknown) => new JobActionRetryableError(error),
                try: (signal: AbortSignal) => spec.collect(signal, context),
            };
            const collected = (
                spec.waitForCancellationSettlement
                    ? cleanupSafePromiseEffect(collect)
                    : Effect.tryPromise(collect)
            ).pipe(
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

export interface DatabaseObservabilityExecutorDependencies {
    readonly collector: DatabaseObservabilityCollector;
    readonly monotonicNowMs?: () => number;
    readonly reconciler?: DatabaseObservabilityReconciliationPort;
}

export interface OverviewProviderCollectors {
    readonly git: (signal?: AbortSignal) => Promise<GitWorkspaceCachePayload>;
    readonly quota: (signal?: AbortSignal) => Promise<QuotaCachePayload>;
    readonly weather: (signal?: AbortSignal) => Promise<WeatherCachePayload>;
}

function createOverviewProviderExecutor<TPayload extends JsonObject>(input: {
    readonly collect: (signal?: AbortSignal) => Promise<TPayload>;
    readonly failureCode: string;
    readonly failureMessage: string;
    readonly key: string;
    readonly metadata: JsonObject;
    readonly schemaId: string;
    readonly source: string;
    readonly ttlMs: number;
    readonly validatePayload: (payload: JsonObject) => void;
}): JobActionExecutor {
    return createCacheRefreshExecutor({
        ...input,
        collect: (signal) => input.collect(signal),
        monotonicNowMs: () => performance.now(),
    });
}

const databaseObservabilityReconciliationStatusSchema = v.picklist(
    databaseObservabilityReconciliationStatuses,
    "Database observability reconciliation status is invalid"
);

/**
 * Adapts the fixed worker-only SQLite maintenance process to one durable action.
 * @returns A path-free durable SQLite maintenance executor.
 */
export function createSqliteMaintenanceJobExecutor(
    maintenance: SqliteMaintenanceExecutionPort
): JobActionExecutor {
    return (_context, payload) =>
        Effect.tryPromise({
            catch: () => new Error("SQLite maintenance action failed"),
            try: async (signal) => {
                v.parse(emptyPayloadSchema, payload);
                return v.parse(
                    sqliteMaintenanceJobResultSchema,
                    await maintenance.run(signal)
                );
            },
        });
}

/**
 * Creates the worker-only domain cache refresh backed by direct database protocol I/O.
 * @param dependencies Bounded collector and optional monotonic test clock.
 * @returns Claim-fenced cache job executor with no generic manual exposure.
 */
export function createDatabaseObservabilityExecutor(
    dependencies: DatabaseObservabilityExecutorDependencies
): JobActionExecutor {
    const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
    return createCacheRefreshExecutor({
        collect: async (signal, context) => {
            const reconciler = dependencies.reconciler;
            if (reconciler === undefined) {
                return dependencies.collector.collect(signal);
            }
            const approved = await reconciler.withApprovedCollection(
                async (reconciliationStatus, collectionSignal) => {
                    const parsedStatus = v.safeParse(
                        databaseObservabilityReconciliationStatusSchema,
                        reconciliationStatus
                    );
                    const safeStatus = parsedStatus.success
                        ? parsedStatus.output
                        : "unavailable";
                    await Effect.runPromise(
                        // Progress is fixed and redacted. Event persistence is
                        // observational and cannot suppress mandatory cleanup.
                        context.reportProgress({
                            databaseObservabilityReconciliation: safeStatus,
                        }),
                        { signal: collectionSignal }
                    ).catch(() => {});
                    return dependencies.collector.collect(collectionSignal);
                },
                signal
            );
            if (approved.reconciliationStatus === "unavailable") {
                throw new DatabaseObservabilityCollectionLeaseError();
            }
            return approved.value;
        },
        failureCode: "provider/database-observability-unavailable",
        failureMessage: "Database observability projection could not be collected.",
        key: databaseObservabilityCacheKey,
        metadata: { kind: "database-observability" },
        monotonicNowMs,
        schemaId: databaseObservabilityCacheSchemaId,
        source: databaseObservabilityCacheSource,
        ttlMs: 90 * 60_000,
        validatePayload: (payload) => {
            v.parse(databaseObservabilityActionPayloadSchema, payload);
        },
        waitForCancellationSettlement: true,
    });
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
 * Adapts the fixed worker lifecycle port without persisting CLI output or diagnostics.
 * @returns The fixed durable restart executor.
 */
export function createOpenClawGatewayRestartJobExecutor(
    gateway: OpenClawGatewayLifecycleExecutionPort
): JobActionExecutor {
    return (context, payload) =>
        Effect.tryPromise({
            catch: () => new Error("OpenClaw Gateway restart action failed"),
            try: async (signal) => {
                v.parse(emptyPayloadSchema, payload);
                await gateway.restart(signal);
                return v.parse(openClawGatewayRestartJobResultSchema, {
                    completedAtMs: context.nowMs(),
                    status: "restarted",
                });
            },
        });
}

/**
 * Adapts a separately privileged fixed host-operation port without persisting output.
 * @param hostOperations Worker-only separately privileged fixed-operation authority.
 * @param operationId Exact reviewed host operation.
 * @returns A non-retryable empty-payload executor with a constant result surface.
 */
export function createHostOperationJobExecutor(
    hostOperations: FixedHostOperationsExecutionPort,
    operationId: HostOperationId
): JobActionExecutor {
    return (context, payload) =>
        Effect.tryPromise({
            catch: () => new Error("Fixed host operation failed"),
            try: async (signal) => {
                v.parse(emptyPayloadSchema, payload);
                if (operationId === "system-restart") {
                    await context.armHostRestartClaimFence();
                    // The fixed broker cannot prove that an error happened before
                    // `systemctl start --no-block` accepted the reboot timer. Once
                    // armed, retain the fence for new-boot reconciliation or its
                    // bounded same-boot expiry on every ambiguous dispatch outcome.
                    const result = await hostOperations.request(operationId, signal);
                    return v.parse(hostSystemRestartJobResultSchema, {
                        completedAtMs: context.nowMs(),
                        status: result.status,
                    });
                }
                const result = await hostOperations.request(operationId, signal);
                if (
                    operationId === "dashboard-restart" ||
                    operationId === "dashboard-stack-restart" ||
                    operationId === "worker-restart"
                ) {
                    return v.parse(hostDashboardServiceRestartJobResultSchema, {
                        completedAtMs: context.nowMs(),
                        status: result.status,
                    });
                }
                if (operationId === "system-cleanup") {
                    return v.parse(hostSystemCleanupJobResultSchema, {
                        completedAtMs: context.nowMs(),
                        status: result.status,
                    });
                }
                return v.parse(hostSystemUpdateJobResultSchema, {
                    completedAtMs: context.nowMs(),
                    status: result.status,
                });
            },
        });
}

/**
 * Adapts one exact worker-only OpenClaw operation to a secret-free job result.
 * @returns A non-retryable empty-payload executor for the selected operation.
 */
export function createOpenClawServiceActionJobExecutor(
    serviceActions: OpenClawServiceActionsExecutionPort,
    operationId: "openclaw-cleanup" | "openclaw-update"
): JobActionExecutor {
    return (context, payload) =>
        Effect.tryPromise({
            catch: (error) =>
                error instanceof OpenClawServiceActionsExecutionError &&
                error.reason === "unknown-outcome"
                    ? new JobActionOutcomeUnknownError()
                    : new Error("Fixed OpenClaw Service Action failed"),
            try: async (signal) => {
                v.parse(emptyPayloadSchema, payload);
                if (operationId === "openclaw-cleanup") {
                    const result = await serviceActions.cleanupSessions(signal);
                    return v.parse(openClawSessionsCleanupJobResultSchema, {
                        ...result,
                        completedAtMs: context.nowMs(),
                    });
                }
                const result = await serviceActions.updateInstallation(signal);
                return v.parse(openClawInstallationUpdateJobResultSchema, {
                    ...result,
                    completedAtMs: context.nowMs(),
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
    readonly actionDefinitions?: readonly JobExecutableActionDefinition[];
    readonly backups?: {
        readonly activityRepository: BackupActivityRepository;
        readonly executionPort: BackupJobExecutionPort;
    };
    readonly databaseObservability?: DatabaseObservabilityCollector;
    readonly databaseObservabilityReconciler?: DatabaseObservabilityReconciliationPort;
    readonly delivery?: DeliveryJobExecutionPort;
    readonly docker?: DockerJobExecutionPort;
    readonly logMaintenance: LogMaintenanceExecutionPort;
    readonly hostOperations?: FixedHostOperationsExecutionPort;
    readonly moltbook: MoltbookDashboardCollector;
    readonly openClawGateway?: OpenClawGatewayLifecycleExecutionPort;
    readonly openClawServiceActions?: OpenClawServiceActionsExecutionPort;
    readonly overviewProviders?: OverviewProviderCollectors;
    readonly sqliteMaintenance?: SqliteMaintenanceExecutionPort;
    readonly workspaceFiles?: WorkspaceFileWriteExecutionPort;
}

export function createJobWorkerActionResolver(
    dependencies: JobWorkerActionResolverDependencies
): JobWorkerActionResolver {
    const databaseObservability =
        dependencies.databaseObservability ??
        Object.freeze({
            collect: () =>
                Promise.reject(
                    new Error("Database observability collector is unavailable")
                ),
        });
    const workspaceFiles = dependencies.workspaceFiles;
    const sqliteMaintenance =
        dependencies.sqliteMaintenance ??
        Object.freeze({
            run: () => Promise.reject(new Error("SQLite maintenance is unavailable")),
        });
    let domainDefinitions: readonly JobActionDefinition[];
    if (dependencies.docker === undefined) {
        domainDefinitions = [
            ...dockerFreeJobActionDefinitions,
            ...(dependencies.delivery === undefined
                ? []
                : [deliveryOverviewCacheJobActionDefinition]),
        ];
    } else if (dependencies.delivery === undefined) {
        domainDefinitions = jobActionDefinitions.filter(
            ({ actionKey }) => actionKey !== deliveryOverviewCacheJobActionKey
        );
    } else {
        domainDefinitions = jobActionDefinitions;
    }
    if (dependencies.backups === undefined) {
        domainDefinitions = domainDefinitions.filter(
            ({ actionKey }) => !backupScheduledJobActionKeys.includes(actionKey)
        );
    }
    if (dependencies.overviewProviders === undefined) {
        domainDefinitions = domainDefinitions.filter(
            ({ actionKey }) => !overviewProviderJobActionKeys.includes(actionKey)
        );
    }
    const definitions =
        dependencies.actionDefinitions ??
        Object.freeze([
            ...domainDefinitions,
            ...(dependencies.openClawGateway === undefined
                ? []
                : [openClawGatewayRestartJobActionDefinition]),
            ...(dependencies.openClawServiceActions === undefined
                ? []
                : [
                      openClawSessionsCleanupJobActionDefinition,
                      openClawInstallationUpdateJobActionDefinition,
                  ]),
            ...(dependencies.hostOperations === undefined
                ? []
                : [
                      hostSystemCleanupJobActionDefinition,
                      hostDashboardRestartJobActionDefinition,
                      hostDashboardStackRestartJobActionDefinition,
                      hostSystemRestartJobActionDefinition,
                      hostSystemUpdateJobActionDefinition,
                      hostWorkerRestartJobActionDefinition,
                  ]),
            ...(workspaceFiles === undefined
                ? []
                : [
                      workspaceFileWriteJobActionDefinition,
                      workspaceFileReplaceJobActionDefinition,
                  ]),
            ...(dependencies.docker === undefined
                ? []
                : [dockerOperationJobActionDefinition]),
            ...(dependencies.backups === undefined
                ? []
                : [backupClearAttentionJobActionDefinition]),
            ...(dependencies.delivery === undefined
                ? []
                : [
                      deliveryGitHubJobActionDefinition,
                      deliveryPreviewJobActionDefinition,
                      deliveryProductionJobActionDefinition,
                  ]),
        ]);
    const registeredActionKeys = new Set(definitions.map(({ actionKey }) => actionKey));
    const gatedExecutor = (
        actionKey: string,
        executor:
            | JobActionExecutor
            | Readonly<{
                  readonly afterSuccessfulSettlement?: JobActionSuccessfulSettlementHandler;
                  readonly execute: JobActionExecutor;
              }>
            | undefined
    ): readonly JobActionExecutorEntry[] =>
        executor === undefined || !registeredActionKeys.has(actionKey)
            ? []
            : [
                  Object.freeze({
                      actionKey,
                      ...(typeof executor === "function"
                          ? { execute: executor }
                          : executor),
                  }),
              ];
    const executors = [
        ...gatedExecutor(
            backupStatusJobActionKey,
            dependencies.backups === undefined
                ? undefined
                : createBackupStatusJobExecutor(dependencies.backups.executionPort)
        ),
        ...gatedExecutor(
            backupKopiaRunJobActionKey,
            dependencies.backups === undefined
                ? undefined
                : createBackupRunJobExecutor("kopia", dependencies.backups)
        ),
        ...gatedExecutor(
            backupWalgRunJobActionKey,
            dependencies.backups === undefined
                ? undefined
                : createBackupRunJobExecutor("walg", dependencies.backups)
        ),
        ...gatedExecutor(
            backupClearAttentionJobActionDefinition.actionKey,
            dependencies.backups === undefined
                ? undefined
                : createBackupClearAttentionJobExecutor(dependencies.backups)
        ),
        ...gatedExecutor("cache.refresh.system-host", systemHostExecutor),
        ...gatedExecutor(
            gitWorkspaceCacheJobActionKey,
            dependencies.overviewProviders === undefined
                ? undefined
                : createOverviewProviderExecutor({
                      collect: dependencies.overviewProviders.git,
                      failureCode: "provider/git-workspace-unavailable",
                      failureMessage: "Managed Git projection could not be collected.",
                      key: gitWorkspaceCacheKey,
                      metadata: { kind: "git-workspace" },
                      schemaId: gitWorkspaceCacheSchemaId,
                      source: gitWorkspaceCacheSource,
                      ttlMs: gitWorkspaceCacheTtlMs,
                      validatePayload: (payload) => {
                          v.parse(gitWorkspaceActionPayloadSchema, payload);
                      },
                  })
        ),
        ...gatedExecutor(
            quotaCacheJobActionKey,
            dependencies.overviewProviders === undefined
                ? undefined
                : createOverviewProviderExecutor({
                      collect: dependencies.overviewProviders.quota,
                      failureCode: "provider/quota-unavailable",
                      failureMessage: "Provider quota projection could not be collected.",
                      key: quotaCacheKey,
                      metadata: { kind: "quota" },
                      schemaId: quotaCacheSchemaId,
                      source: quotaCacheSource,
                      ttlMs: quotaCacheTtlMs,
                      validatePayload: (payload) => {
                          v.parse(quotaActionPayloadSchema, payload);
                      },
                  })
        ),
        ...gatedExecutor(
            weatherCacheJobActionKey,
            dependencies.overviewProviders === undefined
                ? undefined
                : createOverviewProviderExecutor({
                      collect: dependencies.overviewProviders.weather,
                      failureCode: "provider/weather-unavailable",
                      failureMessage: "Weather projection could not be collected.",
                      key: weatherCacheKey,
                      metadata: { kind: "weather" },
                      schemaId: weatherCacheSchemaId,
                      source: weatherCacheSource,
                      ttlMs: weatherCacheTtlMs,
                      validatePayload: (payload) => {
                          v.parse(weatherActionPayloadSchema, payload);
                      },
                  })
        ),
        ...gatedExecutor(
            "cache.refresh.moltbook-dashboard",
            createMoltbookDashboardExecutor({
                collector: dependencies.moltbook,
            })
        ),
        ...gatedExecutor(
            databaseObservabilityCacheJobActionKey,
            createDatabaseObservabilityExecutor({
                collector: databaseObservability,
                reconciler: dependencies.databaseObservabilityReconciler,
            })
        ),
        ...gatedExecutor(
            dockerOverviewCacheJobActionKey,
            dependencies.docker === undefined
                ? undefined
                : createDockerOverviewJobExecutor(dependencies.docker)
        ),
        ...gatedExecutor(
            dockerUpdaterJobActionKey,
            dependencies.docker === undefined
                ? undefined
                : createDockerUpdaterJobExecutor(dependencies.docker)
        ),
        ...gatedExecutor(
            dockerOperationJobActionKey,
            dependencies.docker === undefined
                ? undefined
                : createDockerOperationJobExecutor(dependencies.docker)
        ),
        ...gatedExecutor(
            deliveryOverviewCacheJobActionKey,
            dependencies.delivery === undefined
                ? undefined
                : createDeliveryOverviewJobExecutor(dependencies.delivery)
        ),
        ...gatedExecutor(
            deliveryGitHubJobActionDefinition.actionKey,
            dependencies.delivery === undefined
                ? undefined
                : createDeliveryGitHubJobExecutor(dependencies.delivery)
        ),
        ...gatedExecutor(
            deliveryPreviewJobActionDefinition.actionKey,
            dependencies.delivery === undefined
                ? undefined
                : createDeliveryPreviewJobExecutor(dependencies.delivery)
        ),
        ...gatedExecutor(
            deliveryProductionJobActionDefinition.actionKey,
            dependencies.delivery === undefined
                ? undefined
                : createDeliveryProductionJobExecutor(dependencies.delivery)
        ),
        ...gatedExecutor(
            sqliteMaintenanceJobActionKey,
            createSqliteMaintenanceJobExecutor(sqliteMaintenance)
        ),
        ...gatedExecutor(
            logMaintenanceJobActionKey,
            createLogMaintenanceJobExecutor(dependencies.logMaintenance)
        ),
        ...gatedExecutor(
            openClawGatewayRestartJobActionKey,
            dependencies.openClawGateway === undefined
                ? undefined
                : createOpenClawGatewayRestartJobExecutor(dependencies.openClawGateway)
        ),
        ...gatedExecutor(
            openClawSessionsCleanupJobActionKey,
            dependencies.openClawServiceActions === undefined
                ? undefined
                : createOpenClawServiceActionJobExecutor(
                      dependencies.openClawServiceActions,
                      "openclaw-cleanup"
                  )
        ),
        ...gatedExecutor(
            openClawInstallationUpdateJobActionKey,
            dependencies.openClawServiceActions === undefined
                ? undefined
                : createOpenClawServiceActionJobExecutor(
                      dependencies.openClawServiceActions,
                      "openclaw-update"
                  )
        ),
        ...gatedExecutor(
            hostDashboardRestartJobActionKey,
            dependencies.hostOperations === undefined
                ? undefined
                : createHostOperationJobExecutor(
                      dependencies.hostOperations,
                      "dashboard-restart"
                  )
        ),
        ...gatedExecutor(
            hostDashboardStackRestartJobActionKey,
            dependencies.hostOperations === undefined
                ? undefined
                : createHostOperationJobExecutor(
                      dependencies.hostOperations,
                      "dashboard-stack-restart"
                  )
        ),
        ...gatedExecutor(
            hostSystemCleanupJobActionKey,
            dependencies.hostOperations === undefined
                ? undefined
                : createHostOperationJobExecutor(
                      dependencies.hostOperations,
                      "system-cleanup"
                  )
        ),
        ...gatedExecutor(
            hostSystemRestartJobActionKey,
            dependencies.hostOperations === undefined
                ? undefined
                : createHostOperationJobExecutor(
                      dependencies.hostOperations,
                      "system-restart"
                  )
        ),
        ...gatedExecutor(
            hostSystemUpdateJobActionKey,
            dependencies.hostOperations === undefined
                ? undefined
                : createHostOperationJobExecutor(
                      dependencies.hostOperations,
                      "system-update"
                  )
        ),
        ...gatedExecutor(
            hostWorkerRestartJobActionKey,
            dependencies.hostOperations === undefined
                ? undefined
                : createHostOperationJobExecutor(
                      dependencies.hostOperations,
                      "worker-restart"
                  )
        ),
        ...gatedExecutor("system.worker-smoke", workerSmokeExecutor),
        ...gatedExecutor(
            workspaceFileWriteJobActionKey,
            workspaceFiles === undefined
                ? undefined
                : createWorkspaceFileWriteJobExecutor(workspaceFiles)
        ),
        ...gatedExecutor(
            workspaceFileReplaceJobActionKey,
            workspaceFiles === undefined
                ? undefined
                : Object.freeze({
                      afterSuccessfulSettlement:
                          createWorkspaceFileReplacementSettlementHandler(workspaceFiles),
                      execute: createWorkspaceFileWriteJobExecutor(workspaceFiles),
                  })
        ),
    ];
    const registry = createJobWorkerActionRegistry(definitions, Object.freeze(executors));
    return (actionKey) => registry.get(actionKey);
}
