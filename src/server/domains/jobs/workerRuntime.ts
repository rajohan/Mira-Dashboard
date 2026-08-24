import { Cause, Effect, Exit, Fiber, ManagedRuntime } from "effect";

import type { BackupJobExecutionPort } from "../../../contracts/backupsWorker.ts";
import type { SqliteMaintenanceExecutionPort } from "../../../contracts/database.ts";
import type { DatabaseObservabilityCollector } from "../../../contracts/databaseObservabilityCollector.ts";
import {
    deliveryOverviewSectionKeys,
    type DeliveryOverviewSectionId,
} from "../../../contracts/delivery.ts";
import {
    deliveryGitHubActionKey,
    type DeliveryJobExecutionPort,
    type DeliveryOperationJobPayload,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
    parseDeliveryOperationJobPayload,
} from "../../../contracts/deliveryWorker.ts";
import {
    dockerOverviewCacheKey,
    type DockerUpdaterEvent,
} from "../../../contracts/docker.ts";
import type { DatabaseObservabilityReconciliationPort } from "../../../shared/databaseObservabilityReconciliation.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { LinuxBootIdentity } from "../../../shared/linuxBootIdentity.ts";
import type { OpenClawGatewayLifecycleExecutionPort } from "../../../shared/openClawGatewayLifecycle.ts";
import type { OpenClawServiceActionsExecutionPort } from "../../../shared/openClawServiceActions.ts";
import type {
    TaskNotificationChatSender,
    TaskNotificationQueue,
} from "../../../shared/taskNotifications.ts";
import type { DashboardWorkerRuntime } from "../../../shared/workerRuntime.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import {
    databaseRuntimeLayer,
    DatabaseRuntimeService,
    type DatabaseRuntimeLayerOptions,
    type RuntimeOwnedDatabase,
} from "../../database/runtime/databaseService.ts";
import type { PersistentGatewayTaskNotificationTransport } from "../../platform/gateway/persistentGatewayTransport.ts";
import { createBackupActivityRepository } from "../backups/activityRepository.ts";
import { createCacheRepository, type CacheRepository } from "../cache/repository.ts";
import type { MoltbookDashboardCollector } from "../moltbook/provider.ts";
import { createMonitoringCatalogService } from "../monitoring/catalogService.ts";
import { createMonitoringRepository } from "../monitoring/repository.ts";
import { createTaskNotificationQueue } from "../tasks/taskNotificationQueue.ts";
import {
    createJobWorkerActionResolver,
    hostOperationIds,
    type FixedHostOperationsExecutionPort,
    type LogMaintenanceExecutionPort,
    type OverviewProviderCollectors,
    type WorkspaceFileWriteExecutionPort,
} from "./actionExecutors.ts";
import {
    dockerFreeJobActionDefinitions,
    dockerOperationJobActionDefinition,
    backupClearAttentionJobActionDefinition,
    backupScheduledJobActionKeys,
    deliveryOverviewCacheJobActionKey,
    deliveryOverviewCacheJobActionDefinition,
    deliveryGitHubJobActionDefinition,
    deliveryPreviewJobActionDefinition,
    deliveryProductionJobActionDefinition,
    jobActionDefinitions,
    hostSystemCleanupJobActionDefinition,
    hostSystemRestartJobActionDefinition,
    hostSystemUpdateJobActionDefinition,
    openClawGatewayRestartJobActionDefinition,
    openClawInstallationUpdateJobActionDefinition,
    openClawSessionsCleanupJobActionDefinition,
    overviewProviderJobActionKeys,
    workspaceFileReplaceJobActionDefinition,
    workspaceFileWriteJobActionDefinition,
    type JobExecutableActionDefinition,
} from "./actionRegistry.ts";
import {
    createJobWorkerCoordinator,
    type JobWorkerCoordinator,
    type JobWorkerSideEffectFactory,
    type JobWorkerSideEffectInput,
} from "./coordinator.ts";
import {
    dockerUpdaterEventNotification,
    type DockerJobExecutionPort,
} from "./dockerActionExecutors.ts";
import { createJobRepository, type JobRepository } from "./repository.ts";
import {
    createJobMutationSideEffects,
    createJobRealtimeSideEffects,
} from "./sideEffects.ts";

export interface DashboardWorkerRuntimeOptions {
    /** Exact executable inventory override used by isolated managed-preview runtimes. */
    readonly actionDefinitions?: readonly JobExecutableActionDefinition[];
    readonly bootIdentity: LinuxBootIdentity;
    readonly backups?: BackupJobExecutionPort;
    readonly database: DatabaseRuntimeLayerOptions;
    readonly databaseObservability: DatabaseObservabilityCollector;
    readonly databaseObservabilityReconciler?: DatabaseObservabilityReconciliationPort;
    readonly docker?: Omit<
        DockerJobExecutionPort,
        "publishEvents" | "readPrevious" | "readPreviousAttemptStatus"
    >;
    readonly createDelivery?: DeliveryWorkerCompositionFactory;
    /** Receipt-backed recovery that must finish before schedules or ordinary claims start. */
    readonly reconcileDeliveryProductionBeforeClaims?: (
        repository: JobRepository,
        signal?: AbortSignal
    ) => Promise<void>;
    readonly logMaintenance: LogMaintenanceExecutionPort;
    readonly hostOperations?: FixedHostOperationsExecutionPort;
    readonly moltbook: MoltbookDashboardCollector;
    readonly openClawGateway?: OpenClawGatewayLifecycleExecutionPort;
    readonly openClawServiceActions?: OpenClawServiceActionsExecutionPort;
    readonly overviewProviders?: OverviewProviderCollectors;
    readonly workspaceFiles?: WorkspaceFileWriteExecutionPort & {
        readonly dispose: () => Promise<void> | void;
    };
    readonly persistentGatewayTransport: PersistentGatewayTaskNotificationTransport;
    readonly pid: number;
    readonly releaseId: string;
    readonly sideEffects: JobWorkerSideEffectFactory;
    readonly sqliteMaintenance?: SqliteMaintenanceExecutionPort;
    /** Internal bounded wait for an interrupted notification claim to settle durably. */
    readonly taskNotificationShutdownTimeoutMs?: number;
    readonly taskNotificationLoop: (
        dependencies: TaskNotificationLoopDependencies
    ) => Effect.Effect<never, unknown>;
    readonly workerInstanceId: string;
}

/** Repository-backed authorities exposed only while composing Delivery in the worker. */
export interface DeliveryWorkerCompositionAuthority {
    readonly readActionActive: (input?: {
        readonly excludeRunId?: string;
        readonly signal?: AbortSignal;
    }) => Promise<boolean>;
    readonly readActivePreviewOperation: (
        signal?: AbortSignal
    ) => Promise<
        | Extract<
              DeliveryOperationJobPayload,
              { operation: "start-preview" | "stop-preview" }
          >
        | undefined
    >;
    readonly readPrevious: (section: DeliveryOverviewSectionId) => unknown;
}

/** Late factory used because Delivery's active-action authority lives in the Job repository. */
export type DeliveryWorkerCompositionFactory = (
    authority: DeliveryWorkerCompositionAuthority
) => DeliveryJobExecutionPort;

const deliveryMutationActionKeys = Object.freeze([
    deliveryGitHubActionKey,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
]);

const defaultTaskNotificationShutdownTimeoutMs = 5000;

/** Narrow loop inputs kept shared between the server runtime and worker implementation. */
export interface TaskNotificationLoopDependencies {
    readonly queue: TaskNotificationQueue;
    readonly sender: TaskNotificationChatSender;
    readonly workerId: string;
}

interface WorkerDatabaseRuntimeContext {
    readonly database: RuntimeOwnedDatabase;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

interface WorkerDatabaseRuntime {
    dispose(): Promise<void>;
    initialize(): Promise<WorkerDatabaseRuntimeContext>;
}

export interface DashboardWorkerRuntimeDependencies {
    readonly createCacheRepository: (
        database: RuntimeOwnedDatabase,
        writeAdmission: ImmediateDatabaseWriteAdmission
    ) => CacheRepository;
    readonly createCoordinator: typeof createJobWorkerCoordinator;
    readonly createDatabaseRuntime: (
        options: DatabaseRuntimeLayerOptions
    ) => WorkerDatabaseRuntime;
    readonly createRepository: (
        database: RuntimeOwnedDatabase,
        writeAdmission: ImmediateDatabaseWriteAdmission
    ) => JobRepository;
    readonly createTaskNotificationQueue: typeof createTaskNotificationQueue;
}

function createWorkerDatabaseRuntime(
    options: DatabaseRuntimeLayerOptions
): WorkerDatabaseRuntime {
    const runtime = ManagedRuntime.make(databaseRuntimeLayer(options));
    let initialization: Promise<WorkerDatabaseRuntimeContext> | undefined;
    let disposal: Promise<void> | undefined;
    const initialize = async (): Promise<WorkerDatabaseRuntimeContext> => {
        const service = await runtime.runPromise(DatabaseRuntimeService);
        const writeAdmission: ImmediateDatabaseWriteAdmission = Object.freeze({
            run<T>(operation: (markTransactionStarted: () => void) => T): Promise<T> {
                return runtime.runPromise(service.runImmediateWrite(operation));
            },
        });
        return Object.freeze({ database: service.orm, writeAdmission });
    };
    return Object.freeze({
        dispose() {
            disposal ??= runtime.dispose();
            return disposal;
        },
        initialize() {
            if (disposal !== undefined) {
                return Promise.reject(new Error("Worker database runtime is disposed"));
            }
            initialization ??= initialize();
            return initialization;
        },
    });
}

const defaultDependencies: DashboardWorkerRuntimeDependencies = Object.freeze({
    createCacheRepository,
    createCoordinator: createJobWorkerCoordinator,
    createDatabaseRuntime: createWorkerDatabaseRuntime,
    createRepository: createJobRepository,
    createTaskNotificationQueue,
});

function normalizeWorkerRuntimeFailure(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error("Dashboard worker runtime failed", { cause: error });
}

function requiredTaskNotificationShutdownTimeoutMs(value: number | undefined): number {
    const resolved = value ?? defaultTaskNotificationShutdownTimeoutMs;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new RangeError("Task notification shutdown timeout is invalid");
    }
    return resolved;
}

async function waitForBoundedNotificationStop(
    stop: Promise<void>,
    forceSignal: AbortSignal | undefined,
    timeoutMs: number
): Promise<"forced" | "settled" | "timed-out"> {
    let onForce: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const forced = new Promise<"forced">((resolve) => {
        if (forceSignal === undefined) return;
        if (forceSignal.aborted) {
            resolve("forced");
            return;
        }
        onForce = () => resolve("forced");
        forceSignal.addEventListener("abort", onForce, { once: true });
    });
    const timedOut = new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
    });
    try {
        return await Promise.race([
            stop.then(() => "settled" as const),
            forced,
            timedOut,
        ]);
    } finally {
        if (onForce !== undefined) {
            forceSignal?.removeEventListener("abort", onForce);
        }
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

async function preservePrimaryFailure(
    primary: unknown,
    cleanup: () => Promise<void>
): Promise<never> {
    const failure = normalizeWorkerRuntimeFailure(primary);
    try {
        await cleanup();
    } catch {
        // The initiating defect is the actionable process failure.
    }
    throw failure;
}

const runCreatingActions: ReadonlySet<string> = new Set([
    "jobs.run.enqueue",
    "jobs.run.enqueue-scheduled",
]);

/**
 * Builds required system audit and realtime rows without granting action authority.
 * @param generateId UUIDv7 generator for append-only audit identities.
 * @returns Worker-scoped side-effect factory for queue, run, and schedule transitions.
 */
export function createSystemJobWorkerSideEffects(
    generateId: () => string = () => Bun.randomUUIDv7()
): JobWorkerSideEffectFactory {
    const actor = Object.freeze({
        authenticatorId: null,
        id: "system.jobs-worker",
        kind: "system" as const,
    });
    return Object.freeze({
        forQueue(input: JobWorkerSideEffectInput) {
            return createJobMutationSideEffects({
                action: input.action,
                actor,
                auditId: generateId(),
                occurredAt: input.at,
                outcome: input.outcome,
                realtime: { id: "jobs.queue", kind: "queue" },
                targetId: input.targetId,
                targetType: "job-worker",
            });
        },
        forRun(input: JobWorkerSideEffectInput) {
            return createJobMutationSideEffects({
                action: input.action,
                actor,
                auditId: generateId(),
                occurredAt: input.at,
                outcome: input.outcome,
                realtime: {
                    id: input.targetId,
                    kind: "run",
                    operation: runCreatingActions.has(input.action)
                        ? "created"
                        : "updated",
                },
                targetId: input.targetId,
                targetType: "job-run",
            });
        },
        forRunEvent(input: JobWorkerSideEffectInput) {
            return createJobRealtimeSideEffects({
                occurredAt: input.at,
                realtime: {
                    id: input.targetId,
                    kind: "run",
                    operation: "updated",
                },
            });
        },
        forSchedule(input: JobWorkerSideEffectInput) {
            return createJobMutationSideEffects({
                action: input.action,
                actor,
                auditId: generateId(),
                occurredAt: input.at,
                outcome: input.outcome,
                realtime: {
                    id: input.targetId,
                    kind: "schedule",
                    operation: "updated",
                },
                targetId: input.targetId,
                targetType: "schedule",
            });
        },
        forScheduleEvent(input: JobWorkerSideEffectInput) {
            return createJobRealtimeSideEffects({
                occurredAt: input.at,
                realtime: {
                    id: input.targetId,
                    kind: "schedule",
                    operation: "updated",
                },
            });
        },
    });
}

/**
 * Creates the worker's ordered database, Gateway, durable-job, and notification scope.
 * @param options Exact release/database identity and required atomic side effects.
 * @param dependencies Injectable construction boundaries for focused lifecycle tests.
 * @returns One idempotent runtime whose completion rejects on loop failure.
 */
export function createDashboardWorkerRuntime(
    options: DashboardWorkerRuntimeOptions,
    dependencies: DashboardWorkerRuntimeDependencies = defaultDependencies
): DashboardWorkerRuntime {
    const taskNotificationShutdownTimeoutMs = requiredTaskNotificationShutdownTimeoutMs(
        options.taskNotificationShutdownTimeoutMs
    );
    const databaseRuntime = dependencies.createDatabaseRuntime(options.database);
    let coordinator: JobWorkerCoordinator | undefined;
    let notificationFiber: Fiber.Fiber<never, unknown> | undefined;
    let notificationExitPromise: Promise<Exit.Exit<never, unknown>> | undefined;
    let initializePromise: Promise<void> | undefined;
    let disposePromise: Promise<void> | undefined;
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: unknown) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });

    const observeOwnedCompletion = (
        ownedCompletion: Promise<void>,
        stoppedMessage: string
    ): void => {
        void ownedCompletion.then(
            () => {
                if (disposePromise === undefined) {
                    rejectCompletion?.(new Error(stoppedMessage));
                }
                return;
            },
            (error: unknown) => {
                if (disposePromise === undefined) rejectCompletion?.(error);
                return;
            }
        );
    };

    const stopNotificationLoop = async (forceSignal?: AbortSignal): Promise<void> => {
        const fiber = notificationFiber;
        const exitPromise = notificationExitPromise;
        if (fiber === undefined || exitPromise === undefined) return;
        const gracefulStop = (async () => {
            await Effect.runPromise(Fiber.interrupt(fiber));
            const exit = await exitPromise;
            if (
                Exit.isFailure(exit) &&
                (Cause.hasFails(exit.cause) || Cause.hasDies(exit.cause))
            ) {
                throw normalizeWorkerRuntimeFailure(Cause.squash(exit.cause));
            }
        })();
        const outcome = await waitForBoundedNotificationStop(
            gracefulStop,
            forceSignal,
            taskNotificationShutdownTimeoutMs
        );
        if (outcome === "settled") return;

        // Effect interruption has already requested a durable retry. If that
        // admitted write itself stalls, teardown proceeds and the unacknowledged
        // claim becomes recoverable when its existing lease expires.
        void gracefulStop.catch(() => {});
        if (outcome === "timed-out") {
            throw new Error("Task notification shutdown exceeded its bounded wait");
        }
    };

    const disposeOwnedResources = async (
        forceSignal?: AbortSignal
    ): Promise<Error | undefined> => {
        let failure: Error | undefined;
        // Interruption aborts any send and durably retries its claim while both
        // the Gateway sender and admitted database runtime are still available.
        try {
            await stopNotificationLoop(forceSignal);
        } catch (error) {
            failure = normalizeWorkerRuntimeFailure(error);
        }
        if (coordinator !== undefined) {
            try {
                await coordinator.dispose(forceSignal);
            } catch (error) {
                failure ??= normalizeWorkerRuntimeFailure(error);
            }
        }
        if (options.workspaceFiles !== undefined) {
            try {
                await options.workspaceFiles.dispose();
            } catch (error) {
                failure ??= normalizeWorkerRuntimeFailure(error);
            }
        }
        try {
            await options.persistentGatewayTransport.stop();
        } catch (error) {
            failure ??= normalizeWorkerRuntimeFailure(error);
        }
        try {
            await databaseRuntime.dispose();
        } catch (error) {
            failure ??= normalizeWorkerRuntimeFailure(error);
        }
        return failure;
    };

    const initialize = async (): Promise<void> => {
        try {
            const database = await databaseRuntime.initialize();
            const repository = dependencies.createRepository(
                database.database,
                database.writeAdmission
            );
            const cacheRepository = dependencies.createCacheRepository(
                database.database,
                database.writeAdmission
            );
            const delivery = options.createDelivery?.(
                Object.freeze({
                    readActionActive(
                        input: {
                            readonly excludeRunId?: string;
                            readonly signal?: AbortSignal;
                        } = {}
                    ) {
                        return Promise.resolve().then(() => {
                            input.signal?.throwIfAborted();
                            const active = repository.readAnyActionActive({
                                actionKeys: deliveryMutationActionKeys,
                                ...(input.excludeRunId === undefined
                                    ? {}
                                    : { excludeRunId: input.excludeRunId }),
                            });
                            input.signal?.throwIfAborted();
                            return active;
                        });
                    },
                    readActivePreviewOperation(
                        signal?: AbortSignal
                    ): Promise<
                        | Extract<
                              DeliveryOperationJobPayload,
                              { operation: "start-preview" | "stop-preview" }
                          >
                        | undefined
                    > {
                        return Promise.resolve().then(() => {
                            signal?.throwIfAborted();
                            const page = repository.listActiveActionPayloads({
                                actionKey: deliveryPreviewActionKey,
                                limit: 2,
                            });
                            if (page.truncated || page.payloads.length > 1) {
                                throw new Error(
                                    "Delivery preview operation authority is ambiguous"
                                );
                            }
                            const raw = page.payloads[0];
                            if (raw === undefined) return;
                            const payload = parseDeliveryOperationJobPayload(
                                parseJsonText(raw)
                            );
                            if (
                                payload.operation !== "start-preview" &&
                                payload.operation !== "stop-preview"
                            ) {
                                throw new Error(
                                    "Delivery preview operation authority is invalid"
                                );
                            }
                            signal?.throwIfAborted();
                            return payload;
                        });
                    },
                    readPrevious(section: DeliveryOverviewSectionId) {
                        const record = cacheRepository.findEntry(
                            deliveryOverviewSectionKeys[section]
                        );
                        return record?.payloadJson === null ||
                            record?.payloadJson === undefined
                            ? undefined
                            : parseJsonText(record.payloadJson);
                    },
                })
            );
            const availableHostOperations =
                (await options.hostOperations?.availableOperations()) ?? [];
            if (
                availableHostOperations.length > hostOperationIds.length ||
                new Set(availableHostOperations).size !==
                    availableHostOperations.length ||
                availableHostOperations.some(
                    (operationId) => !hostOperationIds.includes(operationId)
                )
            ) {
                throw new Error("Fixed host operation availability is invalid");
            }
            const availableHostOperationSet = new Set(availableHostOperations);
            let baseActionDefinitions: readonly JobExecutableActionDefinition[];
            if (options.actionDefinitions !== undefined) {
                baseActionDefinitions = options.actionDefinitions;
            } else if (options.docker === undefined) {
                baseActionDefinitions = Object.freeze([
                    ...dockerFreeJobActionDefinitions,
                    ...(delivery === undefined
                        ? []
                        : [deliveryOverviewCacheJobActionDefinition]),
                ]);
            } else if (delivery === undefined) {
                baseActionDefinitions = Object.freeze(
                    jobActionDefinitions.filter(
                        ({ actionKey }) => actionKey !== deliveryOverviewCacheJobActionKey
                    )
                );
            } else {
                baseActionDefinitions = jobActionDefinitions;
            }
            if (options.backups === undefined) {
                baseActionDefinitions = baseActionDefinitions.filter(
                    ({ actionKey }) =>
                        !backupScheduledJobActionKeys.some(
                            (backupActionKey) => backupActionKey === actionKey
                        )
                );
            }
            if (options.overviewProviders === undefined) {
                baseActionDefinitions = baseActionDefinitions.filter(
                    ({ actionKey }) =>
                        !overviewProviderJobActionKeys.some(
                            (providerActionKey) => providerActionKey === actionKey
                        )
                );
            }
            const optionalActionDefinitions: JobExecutableActionDefinition[] = [];
            if (options.actionDefinitions === undefined) {
                if (options.openClawGateway !== undefined) {
                    optionalActionDefinitions.push(
                        openClawGatewayRestartJobActionDefinition
                    );
                }
                if (options.openClawServiceActions !== undefined) {
                    optionalActionDefinitions.push(
                        openClawSessionsCleanupJobActionDefinition,
                        openClawInstallationUpdateJobActionDefinition
                    );
                }
                if (availableHostOperationSet.has("system-cleanup")) {
                    optionalActionDefinitions.push(hostSystemCleanupJobActionDefinition);
                }
                if (availableHostOperationSet.has("system-restart")) {
                    optionalActionDefinitions.push(hostSystemRestartJobActionDefinition);
                }
                if (availableHostOperationSet.has("system-update")) {
                    optionalActionDefinitions.push(hostSystemUpdateJobActionDefinition);
                }
                if (options.workspaceFiles !== undefined) {
                    optionalActionDefinitions.push(
                        workspaceFileWriteJobActionDefinition,
                        workspaceFileReplaceJobActionDefinition
                    );
                }
                if (options.docker !== undefined) {
                    optionalActionDefinitions.push(dockerOperationJobActionDefinition);
                }
                if (options.backups !== undefined) {
                    optionalActionDefinitions.push(
                        backupClearAttentionJobActionDefinition
                    );
                }
                if (delivery !== undefined) {
                    optionalActionDefinitions.push(
                        deliveryGitHubJobActionDefinition,
                        deliveryPreviewJobActionDefinition,
                        deliveryProductionJobActionDefinition
                    );
                }
            }
            const actionDefinitions = Object.freeze([
                ...baseActionDefinitions,
                ...optionalActionDefinitions,
            ]);
            const monitoringCatalog =
                options.docker === undefined
                    ? undefined
                    : createMonitoringCatalogService({
                          repository: createMonitoringRepository(
                              database.database,
                              database.writeAdmission
                          ),
                      });
            const docker: DockerJobExecutionPort | undefined =
                options.docker === undefined
                    ? undefined
                    : Object.freeze({
                          ...options.docker,
                          async publishEvents(events: readonly DockerUpdaterEvent[]) {
                              if (monitoringCatalog === undefined) return;
                              for (const event of events) {
                                  const notification =
                                      dockerUpdaterEventNotification(event);
                                  if (notification === undefined) continue;
                                  await Effect.runPromise(
                                      monitoringCatalog.upsertNotification(notification)
                                  );
                              }
                          },
                          readPrevious() {
                              const record =
                                  cacheRepository.findEntry(dockerOverviewCacheKey);
                              return record?.payloadJson === null ||
                                  record?.payloadJson === undefined
                                  ? undefined
                                  : parseJsonText(record.payloadJson);
                          },
                          readPreviousAttemptStatus() {
                              return cacheRepository.findEntry(dockerOverviewCacheKey)
                                  ?.lastAttemptStatus;
                          },
                      });
            const findAction = createJobWorkerActionResolver({
                actionDefinitions,
                ...(options.backups === undefined
                    ? {}
                    : {
                          backups: {
                              activityRepository: createBackupActivityRepository(
                                  database.database,
                                  repository
                              ),
                              executionPort: options.backups,
                          },
                      }),
                databaseObservability: options.databaseObservability,
                ...(options.databaseObservabilityReconciler === undefined
                    ? {}
                    : {
                          databaseObservabilityReconciler:
                              options.databaseObservabilityReconciler,
                      }),
                ...(docker === undefined ? {} : { docker }),
                ...(delivery === undefined ? {} : { delivery }),
                ...(availableHostOperations.length === 0 ||
                options.hostOperations === undefined
                    ? {}
                    : { hostOperations: options.hostOperations }),
                logMaintenance: options.logMaintenance,
                moltbook: options.moltbook,
                ...(options.overviewProviders === undefined
                    ? {}
                    : { overviewProviders: options.overviewProviders }),
                ...(options.sqliteMaintenance === undefined
                    ? {}
                    : { sqliteMaintenance: options.sqliteMaintenance }),
                ...(options.openClawGateway === undefined
                    ? {}
                    : { openClawGateway: options.openClawGateway }),
                ...(options.openClawServiceActions === undefined
                    ? {}
                    : { openClawServiceActions: options.openClawServiceActions }),
                ...(options.workspaceFiles === undefined
                    ? {}
                    : { workspaceFiles: options.workspaceFiles }),
            });
            coordinator = dependencies.createCoordinator({
                actionDefinitions,
                bootIdentity: options.bootIdentity,
                commitCacheAttempt: (input) => cacheRepository.commitAttempt(input),
                databaseReleaseId: options.releaseId,
                findAction,
                pid: options.pid,
                repository,
                sideEffects: options.sideEffects,
                workerInstanceId: options.workerInstanceId,
            });
            const notificationQueue = dependencies.createTaskNotificationQueue(
                database.database,
                database.writeAdmission
            );
            observeOwnedCompletion(
                coordinator.completion,
                "Durable job coordinator stopped unexpectedly"
            );
            await options.reconcileDeliveryProductionBeforeClaims?.(repository);
            await coordinator.initialize();
            options.persistentGatewayTransport.start();
            notificationFiber = Effect.runFork(
                options.taskNotificationLoop({
                    queue: notificationQueue,
                    sender: options.persistentGatewayTransport.taskNotificationSender,
                    workerId: options.workerInstanceId,
                })
            );
            notificationExitPromise = Effect.runPromise(Fiber.await(notificationFiber));
            observeOwnedCompletion(
                notificationExitPromise.then((exit) => {
                    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
                    return;
                }),
                "Task notification worker loop stopped unexpectedly"
            );
        } catch (error) {
            rejectCompletion?.(error);
            return preservePrimaryFailure(error, async () => {
                await disposeOwnedResources();
            });
        }
    };

    const dispose = async (forceSignal?: AbortSignal): Promise<void> => {
        let failure: Error | undefined;
        if (initializePromise !== undefined) {
            try {
                await initializePromise;
            } catch (error) {
                failure = normalizeWorkerRuntimeFailure(error);
            }
        }
        failure ??= await disposeOwnedResources(forceSignal);
        resolveCompletion?.();
        if (failure !== undefined) throw failure;
    };

    return Object.freeze({
        completion,
        dispose(forceSignal?: AbortSignal) {
            disposePromise ??= dispose(forceSignal);
            return disposePromise;
        },
        initialize() {
            if (disposePromise !== undefined) {
                return Promise.reject(new Error("Dashboard worker runtime is disposed"));
            }
            initializePromise ??= initialize();
            return initializePromise;
        },
    });
}
