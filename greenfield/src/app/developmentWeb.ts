import { realpath } from "node:fs/promises";
import path from "node:path";

import {
    dockerFreeJobActionDefinitions,
    type JobActionDefinition,
    managedPreviewJobActionDefinitions,
} from "../server/domains/jobs/actionRegistry.ts";
import { createPersistentGatewayTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import { createPreviewGatewayTransport } from "../server/platform/gateway/previewGatewayTransport.ts";
import { createDevelopmentRuntimeRelease } from "../server/platform/release/developmentRuntimeRelease.ts";
import { createDashboardApplicationRuntime } from "../server/platform/runtime/applicationRuntime.ts";
import type { FrontendAssetHandler } from "../server/rawHttp/frontendAssets.ts";
import {
    developmentStartupFailureMessage,
    parseDevelopmentSourceCommit,
} from "../shared/developmentProcessSupport.ts";
import {
    type DashboardServerOptions,
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
 * Removes Docker schedule authority from the source-watched web composition.
 * The development worker shares the same isolated database and exact registry.
 * @param dependencies Production web composition boundaries.
 * @returns The same boundaries with a Docker-free schedule registry injection.
 */
export function withoutDevelopmentDockerScheduleDefinitions(
    dependencies: DashboardWebProcessDependencies,
    actionDefinitions: readonly JobActionDefinition[] = dockerFreeJobActionDefinitions
): DashboardWebProcessDependencies {
    return Object.freeze({
        ...dependencies,
        createServer: (options: DashboardServerOptions) =>
            dependencies.createServer({
                ...options,
                jobActionDefinitions: actionDefinitions,
            }),
    });
}

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

function developmentInvocation(arguments_: readonly string[]): Readonly<{
    commit: string;
    previewSocket?: string;
}> {
    const commit = parseDevelopmentSourceCommit(arguments_.slice(0, 1), "web");
    if (arguments_.length === 1) return Object.freeze({ commit });
    const socketPath = arguments_[2];
    if (
        arguments_.length !== 3 ||
        arguments_[1] !== "--managed-preview" ||
        socketPath === undefined
    ) {
        throw new TypeError("Managed preview web arguments are invalid");
    }
    return Object.freeze({ commit, previewSocket: socketPath });
}

/**
 * Runs the source-watched web composition against isolated development state.
 * @param arguments_ Command-line arguments containing the exact source commit.
 * @returns Completion when the development web process stops.
 */
export async function runDevelopmentWebProcess(
    arguments_: readonly string[] = Bun.argv.slice(2)
): Promise<void> {
    const invocation = developmentInvocation(arguments_);
    const repositoryRoot = await realpath(path.resolve(import.meta.dir, "../.."));
    const release = createDevelopmentRuntimeRelease(repositoryRoot, invocation.commit);
    const previewSocket = invocation.previewSocket;
    const defaults = withoutDevelopmentDockerScheduleDefinitions(
        createDefaultDashboardWebProcessDependencies(),
        previewSocket === undefined
            ? dockerFreeJobActionDefinitions
            : managedPreviewJobActionDefinitions
    );
    const dependencies = Object.freeze({
        ...defaults,
        createFrontendAssets: () => Promise.resolve(noFrontendAssets),
        createRuntime:
            previewSocket === undefined
                ? createDevelopmentWebRuntime
                : (_configuration, layout, source, logger) =>
                      createDashboardApplicationRuntime({
                          database: {
                              migrationsDirectory: path.join(
                                  source.releaseRoot,
                                  "migrations"
                              ),
                              releaseId: source.manifest.source.commitSha,
                              startupMode: "initialize-empty",
                              stateDirectory: layout.production.state.root,
                          },
                          logger,
                          persistentGatewayTransport: createPreviewGatewayTransport({
                              socketPath: previewSocket,
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
    } catch (error) {
        process.stderr.write(`${developmentStartupFailureMessage("web", error)}\n`);
        process.exitCode = 1;
    }
}
