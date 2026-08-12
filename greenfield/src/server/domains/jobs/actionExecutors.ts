import { Effect } from "effect";
import * as v from "valibot";

import {
    logMaintenanceJobResultSchema,
    type LogMaintenancePolicyId,
    type LogMaintenanceExecutionSummary,
    logMaintenancePolicyIdSchema,
} from "../../../contracts/logs.ts";
import type { JsonObject } from "../../../shared/json.ts";
import type { OpenClawGatewayLifecycleExecutionPort } from "../../../shared/openClawGatewayLifecycle.ts";
import {
    OpenClawServiceActionsExecutionError,
    type OpenClawServiceActionsExecutionPort,
} from "../../../shared/openClawServiceActions.ts";
import { collectSystemHostPayload } from "../cache/systemHostProvider.ts";
import { parseWorkspaceFileJobPayload } from "../files/jobPayload.ts";
import type { MoltbookDashboardCollector } from "../moltbook/provider.ts";
import {
    type JobActionExecutor,
    type JobExecutableActionDefinition,
    type JobActionRegistration,
    type JobActionSuccessfulSettlementHandler,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
    hostSystemRestartJobActionDefinition,
    hostSystemRestartJobActionKey,
    hostSystemRestartJobResultSchema,
    hostSystemUpdateJobActionDefinition,
    hostSystemUpdateJobActionKey,
    hostSystemUpdateJobResultSchema,
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
    validateJobActionRegistration,
    workspaceFileReplaceJobActionDefinition,
    workspaceFileReplaceJobActionKey,
    workspaceFileWriteJobActionDefinition,
    workspaceFileWriteJobActionKey,
} from "./actionRegistry.ts";

/** Complete contract-ordered inventory of reviewed privileged host operations. */
export const hostOperationIds = Object.freeze([
    "system-restart",
    "system-update",
] as const);

/** One exact reviewed privileged host operation. */
export type HostOperationId = (typeof hostOperationIds)[number];

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
    operationId: "system-restart" | "system-update"
): JobActionExecutor {
    return (context, payload) =>
        Effect.tryPromise({
            catch: () => new Error("Fixed host operation failed"),
            try: async (signal) => {
                v.parse(emptyPayloadSchema, payload);
                const result = await hostOperations.request(operationId, signal);
                if (operationId === "system-restart") {
                    return v.parse(hostSystemRestartJobResultSchema, {
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
    readonly logMaintenance: LogMaintenanceExecutionPort;
    readonly hostOperations?: FixedHostOperationsExecutionPort;
    readonly moltbook: MoltbookDashboardCollector;
    readonly openClawGateway?: OpenClawGatewayLifecycleExecutionPort;
    readonly openClawServiceActions?: OpenClawServiceActionsExecutionPort;
    readonly workspaceFiles?: WorkspaceFileWriteExecutionPort;
}

export function createJobWorkerActionResolver(
    dependencies: JobWorkerActionResolverDependencies
): JobWorkerActionResolver {
    const workspaceFiles = dependencies.workspaceFiles;
    const definitions =
        dependencies.actionDefinitions ??
        Object.freeze([
            ...jobActionDefinitions,
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
                      hostSystemRestartJobActionDefinition,
                      hostSystemUpdateJobActionDefinition,
                  ]),
            ...(workspaceFiles === undefined
                ? []
                : [
                      workspaceFileWriteJobActionDefinition,
                      workspaceFileReplaceJobActionDefinition,
                  ]),
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
        ...(dependencies.openClawGateway === undefined
            ? []
            : [
                  Object.freeze({
                      actionKey: openClawGatewayRestartJobActionKey,
                      execute: createOpenClawGatewayRestartJobExecutor(
                          dependencies.openClawGateway
                      ),
                  }),
              ]),
        ...(dependencies.openClawServiceActions === undefined ||
        !definitions.some(
            ({ actionKey }) => actionKey === openClawSessionsCleanupJobActionKey
        )
            ? []
            : [
                  Object.freeze({
                      actionKey: openClawSessionsCleanupJobActionKey,
                      execute: createOpenClawServiceActionJobExecutor(
                          dependencies.openClawServiceActions,
                          "openclaw-cleanup"
                      ),
                  }),
              ]),
        ...(dependencies.openClawServiceActions === undefined ||
        !definitions.some(
            ({ actionKey }) => actionKey === openClawInstallationUpdateJobActionKey
        )
            ? []
            : [
                  Object.freeze({
                      actionKey: openClawInstallationUpdateJobActionKey,
                      execute: createOpenClawServiceActionJobExecutor(
                          dependencies.openClawServiceActions,
                          "openclaw-update"
                      ),
                  }),
              ]),
        ...(dependencies.hostOperations === undefined ||
        !definitions.some(({ actionKey }) => actionKey === hostSystemRestartJobActionKey)
            ? []
            : [
                  Object.freeze({
                      actionKey: hostSystemRestartJobActionKey,
                      execute: createHostOperationJobExecutor(
                          dependencies.hostOperations,
                          "system-restart"
                      ),
                  }),
              ]),
        ...(dependencies.hostOperations === undefined ||
        !definitions.some(({ actionKey }) => actionKey === hostSystemUpdateJobActionKey)
            ? []
            : [
                  Object.freeze({
                      actionKey: hostSystemUpdateJobActionKey,
                      execute: createHostOperationJobExecutor(
                          dependencies.hostOperations,
                          "system-update"
                      ),
                  }),
              ]),
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
