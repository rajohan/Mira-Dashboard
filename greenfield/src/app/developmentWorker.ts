import { realpath } from "node:fs/promises";
import path from "node:path";

import {
    createDashboardWorkerRuntime,
    createSystemJobWorkerSideEffects,
} from "../server/domains/jobs/workerRuntime.ts";
import { createDevelopmentRuntimeRelease } from "../server/platform/release/developmentRuntimeRelease.ts";
import { developmentTaskNotificationLoop } from "../worker/developmentTaskNotifications.ts";
import { createDescriptorWorkspaceFileStructuralWriter } from "../worker/files/descriptorWorkspaceFileStructuralWriter.ts";
import { createDevelopmentLogMaintenanceExecutor } from "../worker/logs/developmentLogMaintenance.ts";
import { environmentSource } from "./environmentSource.ts";
import {
    type DashboardWorkerProcessDependencies,
    createDefaultDashboardWorkerProcessDependencies,
    runDashboardWorkerProcess,
} from "./worker.ts";

function developmentSourceCommit(arguments_: readonly string[]): string {
    if (arguments_.length !== 1 || !/^[\da-f]{40}$/u.test(arguments_[0] ?? "")) {
        throw new TypeError("Development worker requires one exact source commit");
    }
    return arguments_[0]!;
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
        developmentSourceCommit(arguments_)
    );
    const defaults = createDefaultDashboardWorkerProcessDependencies();
    const dependencies = Object.freeze({
        ...defaults,
        createLogMaintenanceExecutor: createDevelopmentLogMaintenanceExecutor,
        createRuntime: (
            layout,
            source,
            _logger,
            gatewayTransport,
            workspaceRoot,
            openClawRoot,
            logMaintenance
        ) => {
            const writer = createDescriptorWorkspaceFileStructuralWriter({
                roots: [workspaceRoot, openClawRoot],
                spoolRoot: layout.production.state.workspaceFileUploads,
            });
            return createDashboardWorkerRuntime({
                database: {
                    migrationsDirectory: path.join(source.releaseRoot, "migrations"),
                    releaseId: source.manifest.source.commitSha,
                    startupMode: "initialize-empty",
                    stateDirectory: layout.production.state.root,
                },
                logMaintenance,
                persistentGatewayTransport: gatewayTransport,
                pid: process.pid,
                releaseId: source.manifest.source.commitSha,
                sideEffects: createSystemJobWorkerSideEffects(),
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
    } catch {
        process.stderr.write("Mira Dashboard development worker startup failed\n");
        process.exitCode = 1;
    }
}
