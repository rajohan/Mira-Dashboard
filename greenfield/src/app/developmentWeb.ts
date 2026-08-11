import { realpath } from "node:fs/promises";
import path from "node:path";

import { createPersistentGatewayTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import { createDevelopmentRuntimeRelease } from "../server/platform/release/developmentRuntimeRelease.ts";
import { createDashboardApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import type { FrontendAssetHandler } from "../server/rawHttp/frontendAssets.ts";
import {
    type DashboardWebProcessDependencies,
    createDefaultDashboardWebProcessDependencies,
    runDashboardWebProcess,
} from "./dashboardServer.ts";
import { environmentSource } from "./environmentSource.ts";

const noFrontendAssets: FrontendAssetHandler = () => Promise.resolve(undefined);

function developmentSourceCommit(arguments_: readonly string[]): string {
    if (arguments_.length !== 1 || !/^[\da-f]{40}$/u.test(arguments_[0] ?? "")) {
        throw new TypeError("Development web requires one exact source commit");
    }
    return arguments_[0]!;
}

/**
 * Runs the source-watched web composition against isolated development state.
 * @param arguments_ Command-line arguments containing the exact source commit.
 * @returns Completion when the development web process stops.
 */
export async function runDevelopmentWebProcess(
    arguments_: readonly string[] = Bun.argv.slice(2)
): Promise<void> {
    const repositoryRoot = await realpath(path.resolve(import.meta.dir, "../.."));
    const release = createDevelopmentRuntimeRelease(
        repositoryRoot,
        developmentSourceCommit(arguments_)
    );
    const defaults = createDefaultDashboardWebProcessDependencies();
    const dependencies = Object.freeze({
        ...defaults,
        createFrontendAssets: () => Promise.resolve(noFrontendAssets),
        createRuntime: (configuration, layout, source, logger) =>
            createDashboardApplicationRuntime({
                database: {
                    migrationsDirectory: path.join(source.releaseRoot, "migrations"),
                    releaseId: source.manifest.source.commitSha,
                    startupMode: "initialize-empty",
                    stateDirectory: layout.production.state.root,
                },
                logger,
                persistentGatewayTransport: createPersistentGatewayTransport({
                    clientVersion: source.manifest.source.commitSha,
                    token: configuration.gatewayToken,
                    url: configuration.gatewayUrl,
                }),
            }),
        loadRelease: () => Promise.resolve(release),
    } satisfies DashboardWebProcessDependencies);
    await runDashboardWebProcess(
        {
            configurationSource: environmentSource("web"),
            releaseRoot: repositoryRoot,
        },
        dependencies
    );
}

if (import.meta.main) {
    try {
        await runDevelopmentWebProcess();
    } catch {
        process.stderr.write("Mira Dashboard development web startup failed\n");
        process.exitCode = 1;
    }
}
