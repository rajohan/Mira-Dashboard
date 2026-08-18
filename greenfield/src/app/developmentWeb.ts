import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    type JobActionDefinition,
    managedPreviewJobActionDefinitions,
} from "../server/domains/jobs/actionRegistry.ts";
import { sourceDevelopmentScheduledJobActionDefinitions } from "../server/domains/jobs/sourceDevelopmentActionComposition.ts";
import { createPersistentGatewayTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import { createPreviewGatewayTransport } from "../server/platform/gateway/previewGatewayTransport.ts";
import { createSourceDevelopmentGatewayTransport } from "../server/platform/gateway/sourceDevelopmentGatewayTransport.ts";
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
    readonly createReadGatewayTransport: typeof createPersistentGatewayTransport;
    readonly createSourceDevelopmentGatewayTransport: typeof createSourceDevelopmentGatewayTransport;
}

const developmentWebRuntimeFactories = Object.freeze({
    createApplicationRuntime: createDashboardApplicationRuntime,
    createReadGatewayTransport: createPersistentGatewayTransport,
    createSourceDevelopmentGatewayTransport,
} satisfies DevelopmentWebRuntimeFactories);

/**
 * Installs the exact source-development schedule authority in the web composition.
 * The development worker shares the same isolated database and executable registry.
 * @param dependencies Production web composition boundaries.
 * @returns The same boundaries with the selected schedules and inert cutover detection.
 */
export function withSourceDevelopmentScheduleDefinitions(
    dependencies: DashboardWebProcessDependencies,
    actionDefinitions: readonly JobActionDefinition[] = sourceDevelopmentScheduledJobActionDefinitions
): DashboardWebProcessDependencies {
    return Object.freeze({
        ...dependencies,
        createServer: (options: DashboardServerOptions) =>
            dependencies.createServer({
                ...options,
                jobActionDefinitions: actionDefinitions,
            }),
        detectCutoverValidation: () => Promise.resolve(false),
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
    const readTransport = factories.createReadGatewayTransport({
        clientVersion: source.manifest.source.commitSha,
        token: configuration.gatewayToken,
        url: configuration.gatewayUrl,
    });
    const gatewayTransport = factories.createSourceDevelopmentGatewayTransport({
        readTransport,
        stateRoot: layout.root,
    });
    return factories.createApplicationRuntime({
        database: {
            migrationsDirectory: path.join(source.releaseRoot, "migrations"),
            releaseId: source.manifest.source.commitSha,
            startupMode: "initialize-empty",
            stateDirectory: layout.production.state.root,
        },
        logger,
        persistentGatewayTransport: gatewayTransport,
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
    const defaults = withSourceDevelopmentScheduleDefinitions(
        createDefaultDashboardWebProcessDependencies(),
        previewSocket === undefined
            ? sourceDevelopmentScheduledJobActionDefinitions
            : managedPreviewJobActionDefinitions
    );
    const sourceDevelopmentDefaults =
        previewSocket === undefined
            ? Object.freeze({
                  ...defaults,
                  createServer: async (options: DashboardServerOptions) => {
                      const isolatedOpenClawRoot = options.openClawFileRoot;
                      if (isolatedOpenClawRoot === undefined) {
                          return defaults.createServer(options);
                      }
                      const mediaRoot = await defaults
                          .resolveOpenClawFileRoot(
                              path.join(os.homedir(), ".openclaw"),
                              path.join(
                                  path.dirname(isolatedOpenClawRoot.path),
                                  "production"
                              )
                          )
                          .catch((): undefined => {});
                      return defaults.createServer({
                          ...options,
                          openClawMediaFileRoot: mediaRoot,
                      });
                  },
              } satisfies DashboardWebProcessDependencies)
            : defaults;
    const dependencies = Object.freeze({
        ...sourceDevelopmentDefaults,
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
