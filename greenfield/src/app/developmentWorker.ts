import { realpath } from "node:fs/promises";
import path from "node:path";

import {
    createDashboardWorkerRuntime,
    createSystemJobWorkerSideEffects,
} from "../server/domains/jobs/workerRuntime.ts";
import { createDevelopmentRuntimeRelease } from "../server/platform/release/developmentRuntimeRelease.ts";
import {
    developmentStartupFailureMessage,
    parseDevelopmentSourceCommit,
} from "../shared/developmentProcessSupport.ts";
import { createUnavailableDatabaseObservabilityCollector } from "../worker/database/bunSqlDatabaseObservabilityCollector.ts";
import { createFixedSqliteLifecycleMaintenance } from "../worker/database/fixedSqliteLifecycleMaintenance.ts";
import { developmentTaskNotificationLoop } from "../worker/developmentTaskNotifications.ts";
import { createDescriptorWorkspaceFileStructuralWriter } from "../worker/files/descriptorWorkspaceFileStructuralWriter.ts";
import { createDevelopmentLogMaintenanceExecutor } from "../worker/logs/developmentLogMaintenance.ts";
import { environmentSource } from "./environmentSource.ts";
import {
    type DashboardWorkerProcessDependencies,
    createDefaultDashboardWorkerProcessDependencies,
    runDashboardWorkerProcess,
} from "./worker.ts";

/**
 * Removes host Docker discovery and mutation authority from the source-watched worker.
 * Development state may be isolated while the host Docker daemon is still production.
 * @param dependencies Production worker composition boundaries.
 * @returns The same boundaries without either Docker composition or its broker.
 */
export function withoutDevelopmentDockerCapabilities(
    dependencies: DashboardWorkerProcessDependencies
): DashboardWorkerProcessDependencies {
    const {
        createDocker: _createDocker,
        startDockerBroker: _startDockerBroker,
        ...safeDependencies
    } = dependencies;
    return Object.freeze(safeDependencies);
}

/**
 * Runs the source-watched worker composition against isolated development state.
 * @param arguments_ Command-line arguments containing the exact source commit.
 * @returns Completion when the development worker process stops.
 */
export async function runDevelopmentWorkerProcess(
    arguments_: readonly string[] = Bun.argv.slice(2)
): Promise<void> {
    const repositoryRoot = await realpath(path.resolve(import.meta.dir, "../.."));
    const release = createDevelopmentRuntimeRelease(
        repositoryRoot,
        parseDevelopmentSourceCommit(arguments_, "worker")
    );
    const defaults = withoutDevelopmentDockerCapabilities(
        createDefaultDashboardWorkerProcessDependencies()
    );
    const dependencies = Object.freeze({
        ...defaults,
        createHostOperations: () => void 0,
        createLogMaintenanceExecutor: createDevelopmentLogMaintenanceExecutor,
        createOpenClawGatewayLifecycle: () => void 0,
        createOpenClawServiceActions: () => void 0,
        createRuntime: (
            layout,
            source,
            _logger,
            gatewayTransport,
            openClawGateway,
            openClawServiceActions,
            workspaceRoot,
            openClawRoot,
            logMaintenance,
            moltbook,
            _databaseObservability,
            _databaseObservabilityReconciler,
            hostOperations,
            bootIdentity
        ) => {
            const writer = createDescriptorWorkspaceFileStructuralWriter({
                roots: [workspaceRoot, openClawRoot],
                spoolRoot: layout.production.state.workspaceFileUploads,
            });
            return createDashboardWorkerRuntime({
                bootIdentity,
                database: {
                    migrationsDirectory: path.join(source.releaseRoot, "migrations"),
                    releaseId: source.manifest.source.commitSha,
                    startupMode: "initialize-empty",
                    stateDirectory: layout.production.state.root,
                },
                databaseObservability: createUnavailableDatabaseObservabilityCollector(),
                logMaintenance,
                moltbook,
                ...(openClawGateway === undefined ? {} : { openClawGateway }),
                ...(openClawServiceActions === undefined
                    ? {}
                    : { openClawServiceActions }),
                ...(hostOperations === undefined ? {} : { hostOperations }),
                persistentGatewayTransport: gatewayTransport,
                pid: process.pid,
                releaseId: source.manifest.source.commitSha,
                sideEffects: createSystemJobWorkerSideEffects(),
                sqliteMaintenance: createFixedSqliteLifecycleMaintenance({
                    migrationsDirectory: path.join(source.releaseRoot, "migrations"),
                    releaseId: source.manifest.source.commitSha,
                    releaseRoot: source.releaseRoot,
                    scriptPath: path.join(
                        source.releaseRoot,
                        "src/app/databaseMaintenance.ts"
                    ),
                    stateDirectory: layout.production.state.root,
                }),
                taskNotificationLoop: developmentTaskNotificationLoop,
                workerInstanceId: Bun.randomUUIDv7(),
                workspaceFiles: writer,
            });
        },
        loadRelease: () => Promise.resolve(release),
    } satisfies DashboardWorkerProcessDependencies);
    await runDashboardWorkerProcess(
        {
            configurationSource: environmentSource("worker"),
            releaseRoot: repositoryRoot,
        },
        dependencies
    );
}

if (import.meta.main) {
    try {
        await runDevelopmentWorkerProcess();
    } catch (error) {
        process.stderr.write(`${developmentStartupFailureMessage("worker", error)}\n`);
        process.exitCode = 1;
    }
}
