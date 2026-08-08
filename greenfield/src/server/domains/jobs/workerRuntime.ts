import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { ManagedRuntime } from "effect";

import type { DashboardWorkerRuntime } from "../../../shared/workerRuntime.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import {
    databaseRuntimeLayer,
    DatabaseRuntimeService,
    type DatabaseRuntimeLayerOptions,
} from "../../database/runtime/databaseService.ts";
import {
    createJobWorkerCoordinator,
    type JobWorkerCoordinator,
    type JobWorkerSideEffectFactory,
    type JobWorkerSideEffectInput,
} from "./coordinator.ts";
import { createJobRepository, type JobRepository } from "./repository.ts";
import {
    createJobMutationSideEffects,
    createJobRealtimeSideEffects,
} from "./sideEffects.ts";

export interface DashboardWorkerRuntimeOptions {
    readonly database: DatabaseRuntimeLayerOptions;
    readonly pid: number;
    readonly releaseId: string;
    readonly sideEffects: JobWorkerSideEffectFactory;
    readonly workerInstanceId: string;
}

interface WorkerDatabaseRuntimeContext {
    readonly database: SQLiteBunDatabase;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

interface WorkerDatabaseRuntime {
    dispose(): Promise<void>;
    initialize(): Promise<WorkerDatabaseRuntimeContext>;
}

export interface DashboardWorkerRuntimeDependencies {
    readonly createCoordinator: typeof createJobWorkerCoordinator;
    readonly createDatabaseRuntime: (
        options: DatabaseRuntimeLayerOptions
    ) => WorkerDatabaseRuntime;
    readonly createRepository: (
        database: SQLiteBunDatabase,
        writeAdmission: ImmediateDatabaseWriteAdmission
    ) => JobRepository;
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
    createCoordinator: createJobWorkerCoordinator,
    createDatabaseRuntime: createWorkerDatabaseRuntime,
    createRepository: createJobRepository,
});

function normalizeWorkerRuntimeFailure(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error("Dashboard worker runtime failed", { cause: error });
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
 * Creates the worker's ordered database and durable-coordinator ownership scope.
 * @param options Exact release/database identity and required atomic side effects.
 * @param dependencies Injectable construction boundaries for focused lifecycle tests.
 * @returns One idempotent runtime whose completion rejects on loop failure.
 */
export function createDashboardWorkerRuntime(
    options: DashboardWorkerRuntimeOptions,
    dependencies: DashboardWorkerRuntimeDependencies = defaultDependencies
): DashboardWorkerRuntime {
    const databaseRuntime = dependencies.createDatabaseRuntime(options.database);
    let coordinator: JobWorkerCoordinator | undefined;
    let initializePromise: Promise<void> | undefined;
    let disposePromise: Promise<void> | undefined;
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: unknown) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });

    const initialize = async (): Promise<void> => {
        try {
            const database = await databaseRuntime.initialize();
            const repository = dependencies.createRepository(
                database.database,
                database.writeAdmission
            );
            coordinator = dependencies.createCoordinator({
                databaseReleaseId: options.releaseId,
                pid: options.pid,
                repository,
                sideEffects: options.sideEffects,
                workerInstanceId: options.workerInstanceId,
            });
            void coordinator.completion.then(resolveCompletion, rejectCompletion);
            await coordinator.initialize();
        } catch (error) {
            rejectCompletion?.(error);
            return preservePrimaryFailure(error, () => databaseRuntime.dispose());
        }
    };

    const dispose = async (forceSignal?: AbortSignal): Promise<void> => {
        let failure: unknown;
        if (initializePromise !== undefined) {
            try {
                await initializePromise;
                await coordinator?.dispose(forceSignal);
            } catch (error) {
                failure = error;
            }
        }
        try {
            await databaseRuntime.dispose();
        } catch (error) {
            failure ??= error;
        }
        if (failure !== undefined) throw normalizeWorkerRuntimeFailure(failure);
        resolveCompletion?.();
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
