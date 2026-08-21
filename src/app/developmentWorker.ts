import { realpath } from "node:fs/promises";
import path from "node:path";

import { managedPreviewJobActionDefinitions } from "../server/domains/jobs/actionRegistry.ts";
import { sourceDevelopmentExecutableJobActionDefinitions } from "../server/domains/jobs/sourceDevelopmentActionComposition.ts";
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
import {
    createDevelopmentRuntimeAuthority,
    type DevelopmentRuntimeAuthority,
} from "../worker/developmentRuntimeAuthority.ts";
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
 * Removes host Docker and production-cutover authority from the source-watched worker.
 * Development state may be isolated while host Docker and Delivery are still production.
 * @param dependencies Production worker composition boundaries.
 * The broker lifecycle is retained because ordinary source development supplies
 * it with development-only fixed operations rather than Docker daemon authority.
 * @returns Development-safe boundaries with inert cutover guards and no Docker composition.
 */
export function withoutDevelopmentDockerCapabilities(
    dependencies: DashboardWorkerProcessDependencies
): DashboardWorkerProcessDependencies {
    const {
        createCutoverRuntime: _createCutoverRuntime,
        createDocker: _createDocker,
        reconcileCutoverValidation: _reconcileCutoverValidation,
        ...safeDependencies
    } = dependencies;
    return Object.freeze({
        ...safeDependencies,
        createCutoverRuntime: () => {
            throw new Error("Production cutover runtime is unavailable in development");
        },
        detectCutoverValidation: () => Promise.resolve(false),
        reconcileCutoverValidation: () =>
            Promise.reject(
                new Error("Production cutover recovery is unavailable in development")
            ),
    });
}

/**
 * Returns the exact job authority set for one development worker profile.
 * @param managedPreview Whether the process is an untrusted managed preview.
 * @returns The smoke-only preview inventory or complete source-development inventory.
 */
export function developmentWorkerActionDefinitions(
    managedPreview: boolean
):
    | typeof managedPreviewJobActionDefinitions
    | typeof sourceDevelopmentExecutableJobActionDefinitions {
    return managedPreview
        ? managedPreviewJobActionDefinitions
        : sourceDevelopmentExecutableJobActionDefinitions;
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
    let developmentAuthority: DevelopmentRuntimeAuthority | undefined;
    const dependencies = Object.freeze({
        ...defaults,
        ...(isManagedPreview
            ? {}
            : {
                  createDocker: () => {
                      if (developmentAuthority === undefined) {
                          throw new Error(
                              "Development runtime authority is not initialized"
                          );
                      }
                      return Object.freeze({
                          operations: developmentAuthority.dockerOperations,
                          runtime: developmentAuthority.docker,
                      });
                  },
              }),
        createHostOperations: () => void 0,
        createLogMaintenanceExecutor: createDevelopmentLogMaintenanceExecutor,
        createGatewayTransport: () => createManagedPreviewTaskNotificationTransport(),
        createOpenClawGatewayLifecycle: () => void 0,
        createOpenClawServiceActions: () => void 0,
        createRuntime: (
            layout,
            source,
            _logger,
            gatewayTransport,
            _openClawGateway,
            _openClawServiceActions,
            workspaceRoot,
            openClawRoot,
            logMaintenance,
            moltbook,
            _overviewProviders,
            _databaseObservability,
            _databaseObservabilityReconciler,
            _hostOperations,
            bootIdentity
        ) => {
            const developmentAuthorities = developmentAuthority;
            if (!isManagedPreview && developmentAuthorities === undefined) {
                throw new Error("Development runtime authority is not initialized");
            }
            const writer = isManagedPreview
                ? undefined
                : createDescriptorWorkspaceFileStructuralWriter({
                      roots: [workspaceRoot, openClawRoot],
                      spoolRoot: layout.production.state.workspaceFileUploads,
                  });
            const actionDefinitions =
                developmentWorkerActionDefinitions(isManagedPreview);
            return createDashboardWorkerRuntime({
                actionDefinitions,
                bootIdentity,
                database: {
                    migrationsDirectory: path.join(source.releaseRoot, "migrations"),
                    releaseId: source.manifest.source.commitSha,
                    startupMode: "initialize-empty",
                    stateDirectory: layout.production.state.root,
                },
                databaseObservability:
                    developmentAuthorities?.databaseObservability ??
                    createUnavailableDatabaseObservabilityCollector(),
                logMaintenance,
                moltbook,
                ...(developmentAuthorities === undefined
                    ? {}
                    : {
                          hostOperations: developmentAuthorities.hostOperations,
                          openClawGateway: developmentAuthorities.openClawGateway,
                          openClawServiceActions:
                              developmentAuthorities.openClawServiceActions,
                          backups: developmentAuthorities.backups,
                          createDelivery: developmentAuthorities.createDelivery,
                          docker: developmentAuthorities.docker,
                          overviewProviders: developmentAuthorities.overviewProviders,
                      }),
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
        resolveProjectLayout: async (projectRoot) => {
            const layout = await defaults.resolveProjectLayout(projectRoot);
            if (!isManagedPreview) {
                developmentAuthority = createDevelopmentRuntimeAuthority({
                    stateRoot: layout.root,
                });
            }
            return layout;
        },
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
