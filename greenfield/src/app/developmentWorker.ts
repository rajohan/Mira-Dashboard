import { realpath } from "node:fs/promises";
import path from "node:path";

import { managedPreviewJobActionDefinitions } from "../server/domains/jobs/actionRegistry.ts";
import {
    createDashboardWorkerRuntime,
    createSystemJobWorkerSideEffects,
} from "../server/domains/jobs/workerRuntime.ts";
import { createManagedPreviewTaskNotificationTransport } from "../server/platform/gateway/previewGatewayTransport.ts";
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
 * Returns the exact job authority set for the managed-preview worker profile.
 * @param managedPreview Whether the process is an untrusted managed preview.
 * @returns The smoke-only authority set for previews, otherwise undefined.
 */
export function developmentWorkerActionDefinitions(
    managedPreview: boolean
): typeof managedPreviewJobActionDefinitions | undefined {
    return managedPreview ? managedPreviewJobActionDefinitions : undefined;
}

function developmentInvocation(arguments_: readonly string[]): Readonly<{
    commit: string;
    managedPreview: boolean;
}> {
    const commit = parseDevelopmentSourceCommit(arguments_.slice(0, 1), "worker");
    if (arguments_.length === 1) {
        return Object.freeze({ commit, managedPreview: false });
    }
    if (
        arguments_.length !== 3 ||
        arguments_[1] !== "--managed-preview" ||
        arguments_[2] === undefined
    ) {
        throw new TypeError("Managed preview worker arguments are invalid");
    }
    return Object.freeze({ commit, managedPreview: true });
}

/**
 * Runs the source-watched worker composition against isolated development state.
 * @param arguments_ Command-line arguments containing the exact source commit.
 * @returns Completion when the development worker process stops.
 */
export async function runDevelopmentWorkerProcess(
    arguments_: readonly string[] = Bun.argv.slice(2)
): Promise<void> {
    const invocation = developmentInvocation(arguments_);
    const repositoryRoot = await realpath(path.resolve(import.meta.dir, "../.."));
    const release = createDevelopmentRuntimeRelease(repositoryRoot, invocation.commit);
    const defaults = withoutDevelopmentDockerCapabilities(
        createDefaultDashboardWorkerProcessDependencies()
    );
    const isManagedPreview = invocation.managedPreview;
    const dependencies = Object.freeze({
        ...defaults,
        createHostOperations: () => void 0,
        createLogMaintenanceExecutor: createDevelopmentLogMaintenanceExecutor,
        ...(isManagedPreview
            ? {
                  createGatewayTransport: () =>
                      createManagedPreviewTaskNotificationTransport(),
              }
            : {}),
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
            const writer = isManagedPreview
                ? undefined
                : createDescriptorWorkspaceFileStructuralWriter({
                      roots: [workspaceRoot, openClawRoot],
                      spoolRoot: layout.production.state.workspaceFileUploads,
                  });
            const actionDefinitions =
                developmentWorkerActionDefinitions(isManagedPreview);
            return createDashboardWorkerRuntime({
                ...(actionDefinitions === undefined ? {} : { actionDefinitions }),
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
                ...(writer === undefined ? {} : { workspaceFiles: writer }),
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
