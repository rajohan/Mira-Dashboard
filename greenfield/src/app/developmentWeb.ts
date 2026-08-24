import { realpath } from "node:fs/promises";
import path from "node:path";

import { createPersistentGatewayTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import { createDevelopmentRuntimeRelease } from "../server/platform/release/developmentRuntimeRelease.ts";
import { createDashboardApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import type { FrontendAssetHandler } from "../server/rawHttp/frontendAssets.ts";
import {
    developmentStartupFailureMessage,
    parseDevelopmentSourceCommit,
} from "../shared/developmentProcessSupport.ts";
import {
    type DashboardWebProcessDependencies,
    createDefaultDashboardWebProcessDependencies,
    runDashboardWebProcess,
} from "./dashboardServer.ts";
import { environmentSource } from "./environmentSource.ts";

const noFrontendAssets: FrontendAssetHandler = () => Promise.resolve(undefined);

type DevelopmentWebRuntimeConfiguration = Pick<
    Parameters<DashboardWebProcessDependencies["createRuntime"]>[0],
    "gatewayToken" | "gatewayUrl"
>;

interface DevelopmentWebRuntimeFactories {
    readonly createApplicationRuntime: typeof createDashboardApplicationRuntime;
    readonly createGatewayTransport: typeof createPersistentGatewayTransport;
}

const developmentWebRuntimeFactories = Object.freeze({
    createApplicationRuntime: createDashboardApplicationRuntime,
    createGatewayTransport: createPersistentGatewayTransport,
} satisfies DevelopmentWebRuntimeFactories);

/**
 * Composes the development-only runtime overrides behind injectable factory boundaries.
 * @returns One application runtime using the source tree and isolated development state.
 */
export function createDevelopmentWebRuntime(
    configuration: DevelopmentWebRuntimeConfiguration,
    layout: Parameters<DashboardWebProcessDependencies["createRuntime"]>[1],
    source: Parameters<DashboardWebProcessDependencies["createRuntime"]>[2],
    logger: Parameters<DashboardWebProcessDependencies["createRuntime"]>[3],
    factories: DevelopmentWebRuntimeFactories = developmentWebRuntimeFactories
): ReturnType<DashboardWebProcessDependencies["createRuntime"]> {
    return factories.createApplicationRuntime({
        database: {
            migrationsDirectory: path.join(source.releaseRoot, "migrations"),
            releaseId: source.manifest.source.commitSha,
            startupMode: "initialize-empty",
            stateDirectory: layout.production.state.root,
        },
        logger,
        persistentGatewayTransport: factories.createGatewayTransport({
            clientVersion: source.manifest.source.commitSha,
            token: configuration.gatewayToken,
            url: configuration.gatewayUrl,
        }),
    });
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
        parseDevelopmentSourceCommit(arguments_, "web")
    );
    const defaults = createDefaultDashboardWebProcessDependencies();
    const dependencies = Object.freeze({
        ...defaults,
        createFrontendAssets: () => Promise.resolve(noFrontendAssets),
        createRuntime: createDevelopmentWebRuntime,
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
    } catch (error) {
        process.stderr.write(`${developmentStartupFailureMessage("web", error)}\n`);
        process.exitCode = 1;
    }
}
