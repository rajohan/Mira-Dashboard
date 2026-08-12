import { realpath } from "node:fs/promises";
import path from "node:path";

import {
    createDashboardWorkerRuntime,
    createSystemJobWorkerSideEffects,
} from "../server/domains/jobs/workerRuntime.ts";
import {
    createMoltbookDashboardCollector,
    type MoltbookDashboardCollector,
} from "../server/domains/moltbook/provider.ts";
import {
    parseWorkerConfiguration,
    type WorkerConfiguration,
} from "../server/platform/configuration/workerConfiguration.ts";
import {
    type DashboardProjectLayout,
    resolveDashboardProjectLayout,
} from "../server/platform/filesystem/projectLayout.ts";
import { createPersistentGatewayOpenClawServiceActionsProvider } from "../server/platform/gateway/persistentGatewayOpenClawServiceActionsProvider.ts";
import {
    createPersistentGatewayTaskNotificationTransport,
    type PersistentGatewayTaskNotificationTransport,
    type PersistentGatewayTransportOptions,
} from "../server/platform/gateway/persistentGatewayTransport.ts";
import {
    createProjectFileLogDestination,
    type ProjectFileLogDestination,
} from "../server/platform/observability/projectFileLogSink.ts";
import {
    createStructuredLogger,
    type StructuredLogger,
} from "../server/platform/observability/structuredLogger.ts";
import {
    loadRuntimeRelease,
    type RuntimeRelease,
} from "../server/platform/release/runtimeRelease.ts";
import {
    createProcessTerminationController,
    type ProcessTerminationController,
} from "../server/platform/runtime/processSignals.ts";
import type { FixedHostOperationsExecutionPort } from "../shared/hostOperations.ts";
import type { OpenClawGatewayLifecycleExecutionPort } from "../shared/openClawGatewayLifecycle.ts";
import type { OpenClawServiceActionsExecutionPort } from "../shared/openClawServiceActions.ts";
import {
    createDescriptorWorkspaceFileStructuralWriter,
    type WorkerWorkspaceFileRootConfiguration,
} from "../worker/files/descriptorWorkspaceFileStructuralWriter.ts";
import { resolveReviewedWorkerOpenClawFileRoot } from "../worker/files/openClawFileRootConfiguration.ts";
import { resolveReviewedWorkerWorkspaceFileRoot } from "../worker/files/workspaceFileRootConfiguration.ts";
import {
    createFixedSystemLogrotateBroker,
    type FixedSystemLogrotateBroker,
} from "../worker/logs/fixedSystemLogrotateBroker.ts";
import {
    startLogMaintenanceAvailabilityPublisher,
    type LogMaintenanceAvailabilityPublisher,
} from "../worker/logs/logMaintenanceAvailabilityPublisher.ts";
import {
    createLogMaintenanceExecutor,
    type LogMaintenanceExecutor,
} from "../worker/logs/logMaintenanceExecutor.ts";
import {
    managedLogManifest,
    type ManagedLogManifest,
} from "../worker/logs/managedLogManifest.ts";
import {
    createManagedLogRotationEngine,
    type ManagedLogRotationEngine,
} from "../worker/logs/managedLogRotation.ts";
import { createFixedOpenClawGatewayLifecycle } from "../worker/openClaw/gatewayLifecycle.ts";
import { type DashboardWorkerRuntime } from "../worker/runtime.ts";
import { taskNotificationWorkerLoop } from "../worker/taskNotifications.ts";
import {
    startWorkerTerminalBrokerLifecycle,
    type WorkerTerminalBrokerLifecycle,
    type WorkerTerminalBrokerLifecycleOptions,
} from "../worker/terminal/workerTerminalBrokerLifecycle.ts";
import { environmentSource } from "./environmentSource.ts";

/** Explicit inputs owned by the executable worker composition root. */
export interface DashboardWorkerProcessOptions {
    readonly configurationSource: Readonly<Record<string, unknown>>;
    readonly releaseRoot: string;
}

/** Injectable process boundaries used by deterministic composition tests. */
export interface DashboardWorkerProcessDependencies {
    readonly createGatewayTransport: (
        options: PersistentGatewayTransportOptions
    ) => PersistentGatewayTaskNotificationTransport;
    readonly createLogDestination: (
        logsDirectory: string,
        processRole: "worker"
    ) => ProjectFileLogDestination;
    readonly createLogMaintenanceExecutor: (
        layout: DashboardProjectLayout
    ) => LogMaintenanceExecutor;
    readonly createHostOperations?: () => FixedHostOperationsExecutionPort | undefined;
    readonly createOpenClawGatewayLifecycle: (
        openClawRoot: string
    ) => OpenClawGatewayLifecycleExecutionPort | undefined;
    readonly createOpenClawServiceActions: (
        transport: PersistentGatewayTaskNotificationTransport
    ) => OpenClawServiceActionsExecutionPort | undefined;
    readonly createRuntime: (
        layout: DashboardProjectLayout,
        release: RuntimeRelease,
        logger: StructuredLogger,
        persistentGatewayTransport: PersistentGatewayTaskNotificationTransport,
        openClawGateway: OpenClawGatewayLifecycleExecutionPort | undefined,
        openClawServiceActions: OpenClawServiceActionsExecutionPort | undefined,
        workspaceRoot: WorkerWorkspaceFileRootConfiguration,
        openClawRoot: WorkerWorkspaceFileRootConfiguration,
        logMaintenance: LogMaintenanceExecutor,
        moltbook: MoltbookDashboardCollector,
        hostOperations: FixedHostOperationsExecutionPort | undefined
    ) => DashboardWorkerRuntime;
    readonly createTerminationController: () => ProcessTerminationController;
    readonly loadRelease: (
        releasesDirectory: string,
        releaseRoot: string,
        processRole: "worker"
    ) => Promise<RuntimeRelease>;
    readonly resolveProjectLayout: (
        projectRoot: string
    ) => Promise<DashboardProjectLayout>;
    readonly resolveOpenClawFileRoot: typeof resolveReviewedWorkerOpenClawFileRoot;
    readonly resolveWorkspaceFileRoot: typeof resolveReviewedWorkerWorkspaceFileRoot;
    readonly startTerminalBroker: (
        options: WorkerTerminalBrokerLifecycleOptions
    ) => Promise<WorkerTerminalBrokerLifecycle>;
    readonly startLogMaintenanceAvailability: (options: {
        readonly availablePolicies: LogMaintenanceExecutor["availablePolicies"];
        readonly logMaintenanceRoot: string;
    }) => Promise<LogMaintenanceAvailabilityPublisher>;
}

function runtimeManagedLogManifest(layout: DashboardProjectLayout): ManagedLogManifest {
    return Object.freeze({
        ...managedLogManifest,
        fileTargets: Object.freeze(
            managedLogManifest.fileTargets.map((target) =>
                target.id.startsWith("dashboard.")
                    ? Object.freeze({
                          ...target,
                          filePath: path.join(
                              layout.production.state.logs,
                              path.basename(target.filePath)
                          ),
                      })
                    : target
            )
        ),
        lockPath: path.join(layout.production.state.logMaintenance, "managed.lock"),
        statePath: path.join(
            layout.production.state.logMaintenance,
            "managed-state.json"
        ),
    });
}

export interface WorkerLogMaintenanceCompositionDependencies {
    readonly createManaged?: (manifest: ManagedLogManifest) => ManagedLogRotationEngine;
    readonly createSystem?: () => FixedSystemLogrotateBroker;
}

/**
 * Composes worker-only custom and fixed-host log maintenance authorities.
 * @returns The single fixed-policy executor injected into durable jobs.
 */
export function createWorkerLogMaintenanceExecutor(
    layout: DashboardProjectLayout,
    dependencies: WorkerLogMaintenanceCompositionDependencies = {}
): LogMaintenanceExecutor {
    const manifest = runtimeManagedLogManifest(layout);
    return createLogMaintenanceExecutor({
        managed:
            dependencies.createManaged?.(manifest) ??
            createManagedLogRotationEngine({ manifest }),
        system: dependencies.createSystem?.() ?? createFixedSystemLogrotateBroker(),
    });
}

const defaultDependencies = Object.freeze({
    createGatewayTransport: createPersistentGatewayTaskNotificationTransport,
    createLogDestination: (logsDirectory, processRole) =>
        createProjectFileLogDestination(logsDirectory, processRole),
    createLogMaintenanceExecutor: createWorkerLogMaintenanceExecutor,
    createOpenClawGatewayLifecycle: (openClawRoot) =>
        createFixedOpenClawGatewayLifecycle({ openClawRoot }),
    createOpenClawServiceActions: createPersistentGatewayOpenClawServiceActionsProvider,
    createRuntime: (
        layout,
        release,
        _logger,
        gatewayTransport,
        openClawGateway,
        openClawServiceActions,
        workspaceRoot,
        openClawRoot,
        logMaintenance,
        moltbook,
        hostOperations
    ) => {
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            roots: [workspaceRoot, openClawRoot],
            spoolRoot: layout.production.state.workspaceFileUploads,
        });
        return createDashboardWorkerRuntime({
            database: {
                migrationsDirectory: path.join(release.releaseRoot, "migrations"),
                releaseId: release.manifest.source.commitSha,
                startupMode: "validate-only",
                stateDirectory: layout.production.state.root,
            },
            logMaintenance,
            moltbook,
            ...(openClawGateway === undefined ? {} : { openClawGateway }),
            ...(openClawServiceActions === undefined ? {} : { openClawServiceActions }),
            ...(hostOperations === undefined ? {} : { hostOperations }),
            persistentGatewayTransport: gatewayTransport,
            pid: process.pid,
            releaseId: release.manifest.source.commitSha,
            sideEffects: createSystemJobWorkerSideEffects(),
            taskNotificationLoop: taskNotificationWorkerLoop,
            workerInstanceId: Bun.randomUUIDv7(),
            workspaceFiles: writer,
        });
    },
    createTerminationController: createProcessTerminationController,
    loadRelease: (releasesDirectory, releaseRoot, processRole) =>
        loadRuntimeRelease(releasesDirectory, releaseRoot, processRole),
    resolveProjectLayout: resolveDashboardProjectLayout,
    resolveOpenClawFileRoot: resolveReviewedWorkerOpenClawFileRoot,
    resolveWorkspaceFileRoot: resolveReviewedWorkerWorkspaceFileRoot,
    startLogMaintenanceAvailability: startLogMaintenanceAvailabilityPublisher,
    startTerminalBroker: startWorkerTerminalBrokerLifecycle,
} satisfies DashboardWorkerProcessDependencies);

/**
 * Returns the reviewed production worker dependency set for narrow composition overrides.
 * Development replaces only release loading, database startup, and host-capability adapters;
 * production callers continue to use this exact frozen object unchanged.
 * @returns The frozen default worker-process dependencies.
 */
export function createDefaultDashboardWorkerProcessDependencies(): DashboardWorkerProcessDependencies {
    return defaultDependencies;
}

function createWorkerLogger(
    configuration: WorkerConfiguration,
    release: RuntimeRelease,
    destination: ProjectFileLogDestination
): StructuredLogger {
    const runtime = release.manifest.runtime;
    return createStructuredLogger({
        fallbackWrite: destination.fallbackWrite,
        identity: {
            bun: `${runtime.version}+${runtime.revision.slice(0, 9)}`,
            pid: process.pid,
            processRole: "worker",
            release: release.manifest.source.commitSha,
            service: "mira-dashboard",
        },
        minimumLevel: configuration.logLevel,
        sink: destination.sink,
    });
}

function normalizeWorkerProcessFailure(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error("Dashboard worker process failed", { cause: error });
}

/**
 * Runs durable schedule and job execution until a signal or coordinator defect wins.
 * @param options Typed environment source and exact immutable release root.
 * @param dependencies Injectable host/runtime boundaries.
 */
export async function runDashboardWorkerProcess(
    options: DashboardWorkerProcessOptions,
    dependencies: DashboardWorkerProcessDependencies = defaultDependencies
): Promise<void> {
    const configuration = parseWorkerConfiguration(options.configurationSource);
    const layout = await dependencies.resolveProjectLayout(configuration.projectRoot);
    const release = await dependencies.loadRelease(
        layout.production.releases,
        options.releaseRoot,
        "worker"
    );
    const workspaceRoot = await dependencies.resolveWorkspaceFileRoot(
        configuration.workspaceRoot,
        layout.production.root
    );
    const openClawRoot = await dependencies.resolveOpenClawFileRoot(
        configuration.openClawRoot,
        layout.production.root
    );
    const destination = dependencies.createLogDestination(
        layout.production.state.logs,
        "worker"
    );
    const logger = createWorkerLogger(configuration, release, destination);
    const termination = dependencies.createTerminationController();
    let runtime: DashboardWorkerRuntime | undefined;
    let gatewayTransport: PersistentGatewayTaskNotificationTransport | undefined;
    let logMaintenanceAvailability: LogMaintenanceAvailabilityPublisher | undefined;
    let terminalBroker: WorkerTerminalBrokerLifecycle | undefined;
    let failure: Error | undefined;
    try {
        terminalBroker = await dependencies.startTerminalBroker({
            projectRoot: layout.root,
        });
        if (terminalBroker.socketPath !== layout.production.state.terminalBrokerSocket) {
            await terminalBroker.stop().catch(() => {});
            terminalBroker = undefined;
            throw new Error("Terminal broker socket identity is invalid");
        }
        gatewayTransport = dependencies.createGatewayTransport({
            clientVersion: release.manifest.source.commitSha,
            token: configuration.gatewayToken,
            url: configuration.gatewayUrl,
        });
        const logMaintenance = dependencies.createLogMaintenanceExecutor(layout);
        const openClawGateway = dependencies.createOpenClawGatewayLifecycle(
            openClawRoot.path
        );
        const openClawServiceActions =
            dependencies.createOpenClawServiceActions(gatewayTransport);
        const hostOperations = dependencies.createHostOperations?.();
        const moltbook = createMoltbookDashboardCollector({
            agentName: configuration.moltbookAgentName,
            apiKey: configuration.moltbookApiKey,
        });
        runtime = dependencies.createRuntime(
            layout,
            release,
            logger,
            gatewayTransport,
            openClawGateway,
            openClawServiceActions,
            workspaceRoot,
            openClawRoot,
            logMaintenance,
            moltbook,
            hostOperations
        );
        const runtimeCompletion = runtime.completion.then(
            () => ({ kind: "stopped" as const }),
            (error: unknown) => ({ error, kind: "failed" as const })
        );
        await runtime.initialize();
        logMaintenanceAvailability = await dependencies.startLogMaintenanceAvailability({
            availablePolicies: logMaintenance.availablePolicies,
            logMaintenanceRoot: layout.production.state.logMaintenance,
        });
        const logMaintenanceAvailabilityCompletion =
            logMaintenanceAvailability.completion.then(
                () => ({ kind: "log-maintenance-availability-stopped" as const }),
                (error: unknown) => ({
                    error,
                    kind: "log-maintenance-availability-failed" as const,
                })
            );
        logger.info({
            component: "runtime",
            event: "runtime.started",
            outcome: "success",
        });
        const exit = await Promise.race([
            termination.termination.then(() => ({ kind: "signal" as const })),
            runtimeCompletion,
            logMaintenanceAvailabilityCompletion,
        ]);
        if (exit.kind === "failed") {
            throw exit.error;
        }
        if (exit.kind === "stopped") {
            throw new Error("Dashboard worker runtime stopped unexpectedly");
        }
        if (exit.kind === "log-maintenance-availability-failed") {
            throw exit.error;
        }
        if (exit.kind === "log-maintenance-availability-stopped") {
            throw new Error(
                "Dashboard worker log-maintenance availability stopped unexpectedly"
            );
        }
        await logMaintenanceAvailability.stop();
        await terminalBroker.stop();
        await runtime.dispose(termination.forceSignal);
        await runtime.completion;
        logger.info({
            component: "runtime",
            event: "runtime.stopped",
            outcome: "success",
        });
    } catch (error) {
        failure = normalizeWorkerProcessFailure(error);
        if (logMaintenanceAvailability) {
            try {
                await logMaintenanceAvailability.stop();
            } catch {
                // Preserve the initiating process failure.
            }
        }
        if (terminalBroker) {
            try {
                await terminalBroker.stop();
            } catch {
                // Preserve the initiating process failure.
            }
        }
        if (runtime) {
            try {
                await runtime.dispose(termination.forceSignal);
            } catch {
                // Preserve the initiating process failure.
            }
        } else if (gatewayTransport) {
            try {
                await gatewayTransport.stop();
            } catch {
                // Preserve the initiating composition failure.
            }
        }
        logger.fatal({
            component: "runtime",
            event: "runtime.start_failed",
            failure,
            outcome: "server-error",
        });
    } finally {
        termination.dispose();
        logger.flush();
    }
    if (failure !== undefined) throw failure;
}

if (import.meta.main) {
    try {
        const releaseRoot = await realpath(path.resolve(import.meta.dir, ".."));
        await runDashboardWorkerProcess({
            configurationSource: environmentSource("worker"),
            releaseRoot,
        });
    } catch {
        process.stderr.write("Mira Dashboard worker startup failed\n");
        process.exitCode = 1;
    }
}
