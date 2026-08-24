import { realpath } from "node:fs/promises";
import path from "node:path";

import {
    createDashboardWorkerRuntime,
    createSystemJobWorkerSideEffects,
} from "../server/domains/jobs/workerRuntime.ts";
import {
    parseWorkerConfiguration,
    type WorkerConfiguration,
} from "../server/platform/configuration/workerConfiguration.ts";
import {
    type DashboardProjectLayout,
    resolveDashboardProjectLayout,
} from "../server/platform/filesystem/projectLayout.ts";
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
import { type DashboardWorkerRuntime } from "../worker/runtime.ts";
import { taskNotificationWorkerLoop } from "../worker/taskNotifications.ts";
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
    readonly createRuntime: (
        layout: DashboardProjectLayout,
        release: RuntimeRelease,
        logger: StructuredLogger,
        persistentGatewayTransport: PersistentGatewayTaskNotificationTransport
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
}

const defaultDependencies = Object.freeze({
    createGatewayTransport: createPersistentGatewayTaskNotificationTransport,
    createLogDestination: (logsDirectory, processRole) =>
        createProjectFileLogDestination(logsDirectory, processRole),
    createRuntime: (layout, release, _logger, gatewayTransport) =>
        createDashboardWorkerRuntime({
            database: {
                migrationsDirectory: path.join(release.releaseRoot, "migrations"),
                releaseId: release.manifest.source.commitSha,
                startupMode: "validate-only",
                stateDirectory: layout.production.state.root,
            },
            persistentGatewayTransport: gatewayTransport,
            pid: process.pid,
            releaseId: release.manifest.source.commitSha,
            sideEffects: createSystemJobWorkerSideEffects(),
            taskNotificationLoop: taskNotificationWorkerLoop,
            workerInstanceId: Bun.randomUUIDv7(),
        }),
    createTerminationController: createProcessTerminationController,
    loadRelease: (releasesDirectory, releaseRoot, processRole) =>
        loadRuntimeRelease(releasesDirectory, releaseRoot, processRole),
    resolveProjectLayout: resolveDashboardProjectLayout,
} satisfies DashboardWorkerProcessDependencies);

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
    const destination = dependencies.createLogDestination(
        layout.production.state.logs,
        "worker"
    );
    const logger = createWorkerLogger(configuration, release, destination);
    const termination = dependencies.createTerminationController();
    let runtime: DashboardWorkerRuntime | undefined;
    let gatewayTransport: PersistentGatewayTaskNotificationTransport | undefined;
    let failure: Error | undefined;
    try {
        gatewayTransport = dependencies.createGatewayTransport({
            clientVersion: release.manifest.source.commitSha,
            token: configuration.gatewayToken,
            url: configuration.gatewayUrl,
        });
        runtime = dependencies.createRuntime(layout, release, logger, gatewayTransport);
        const runtimeCompletion = runtime.completion.then(
            () => ({ kind: "stopped" as const }),
            (error: unknown) => ({ error, kind: "failed" as const })
        );
        await runtime.initialize();
        logger.info({
            component: "runtime",
            event: "runtime.started",
            outcome: "success",
        });
        const exit = await Promise.race([
            termination.termination.then(() => ({ kind: "signal" as const })),
            runtimeCompletion,
        ]);
        if (exit.kind === "failed") {
            throw exit.error;
        }
        if (exit.kind === "stopped") {
            throw new Error("Dashboard worker runtime stopped unexpectedly");
        }
        await runtime.dispose(termination.forceSignal);
        await runtime.completion;
        logger.info({
            component: "runtime",
            event: "runtime.stopped",
            outcome: "success",
        });
    } catch (error) {
        failure = normalizeWorkerProcessFailure(error);
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
