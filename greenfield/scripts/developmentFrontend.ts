import dashboard from "../src/browser/index.html";
import {
    type DevelopmentFrontendConfiguration,
    resolveDevelopmentFrontendConfiguration,
} from "./development/developmentFrontendConfig.ts";
import {
    developmentWebSocketHandler,
    type DevelopmentProxySocketData,
    proxyDevelopmentHttp,
    proxyDevelopmentWebSocket,
} from "./development/developmentProxy.ts";
import {
    type DevelopmentRemoteProxySocketData,
    startDevelopmentRemoteProxy,
} from "./development/developmentRemoteProxy.ts";

export interface DevelopmentFrontendRuntime {
    readonly frontend: Bun.Server<DevelopmentProxySocketData>;
    readonly remoteProxy?: Bun.Server<DevelopmentRemoteProxySocketData>;
    stop(closeActiveConnections?: boolean): Promise<void>;
}

/**
 * Starts Bun's full-stack HTML server and the reviewed loopback API proxy.
 * @param configuration Validated listener, HMR, origin, and backend configuration.
 * @returns The active frontend and optional remote-proxy lifecycle.
 */
export async function startDevelopmentFrontend(
    configuration: DevelopmentFrontendConfiguration
): Promise<DevelopmentFrontendRuntime> {
    const backendRequest = (
        request: Request,
        server: Bun.Server<DevelopmentProxySocketData>
    ): Promise<Response> | Response | undefined =>
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
            ? proxyDevelopmentWebSocket(request, server, configuration)
            : proxyDevelopmentHttp(request, server, configuration);

    const frontend = Bun.serve<DevelopmentProxySocketData>({
        development: { console: true, hmr: configuration.hotReload },
        hostname: configuration.host,
        idleTimeout: 0,
        port: configuration.port,
        routes: {
            "/api": backendRequest,
            "/api/*": backendRequest,
            "/trpc": backendRequest,
            "/trpc/*": backendRequest,
            "/*": dashboard,
        },
        websocket: developmentWebSocketHandler(configuration),
    });
    let remoteProxy: Bun.Server<DevelopmentRemoteProxySocketData> | undefined;
    try {
        if (configuration.remoteProxyPort !== undefined) {
            const frontendPort = frontend.port;
            if (frontendPort === undefined) {
                throw new Error("Development frontend did not open a TCP listener");
            }
            remoteProxy = startDevelopmentRemoteProxy({
                frontendTarget: `http://127.0.0.1:${frontendPort}`,
                port: configuration.remoteProxyPort,
                publicOrigin: configuration.publicOrigin,
            });
        }
    } catch (error) {
        await frontend.stop(true);
        throw error;
    }

    return Object.freeze({
        frontend,
        ...(remoteProxy === undefined ? {} : { remoteProxy }),
        async stop(closeActiveConnections = false): Promise<void> {
            await Promise.all([
                frontend.stop(closeActiveConnections),
                ...(remoteProxy === undefined
                    ? []
                    : [remoteProxy.stop(closeActiveConnections)]),
            ]);
        },
    });
}

if (import.meta.main) {
    const configuration = resolveDevelopmentFrontendConfiguration();
    const runtime = await startDevelopmentFrontend(configuration);
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        void runtime.stop(true).catch((error: unknown) => {
            process.stderr.write(
                `${error instanceof Error ? error.message : "Development frontend shutdown failed"}\n`
            );
            process.exitCode = 1;
        });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdout.write(
        `Dashboard Bun dev server listening on ${configuration.publicOrigin}\n`
    );
}
