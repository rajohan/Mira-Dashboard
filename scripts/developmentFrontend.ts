import { rm } from "node:fs/promises";

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
    startDevelopmentUnixProxy,
} from "./development/developmentRemoteProxy.ts";

export interface DevelopmentFrontendRuntime {
    readonly frontend: Bun.Server<DevelopmentProxySocketData>;
    readonly ingress?: Bun.Server<DevelopmentRemoteProxySocketData>;
    readonly remoteProxy?: Bun.Server<DevelopmentRemoteProxySocketData>;
    stop(closeActiveConnections?: boolean): Promise<void>;
}

interface DevelopmentFrontendDependencies {
    readonly dashboardRoute?: Bun.HTMLBundle;
}

/**
 * Starts Bun's full-stack HTML server and the reviewed loopback API proxy.
 * @param configuration Validated listener, HMR, origin, and backend configuration.
 * @returns The active frontend and optional remote-proxy lifecycle.
 */
export async function startDevelopmentFrontend(
    configuration: DevelopmentFrontendConfiguration,
    dependencies: DevelopmentFrontendDependencies = {}
): Promise<DevelopmentFrontendRuntime> {
    const backendRequest = (
        request: Request,
        server: Bun.Server<DevelopmentProxySocketData>
    ): Promise<Response> | Response | undefined =>
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
            ? proxyDevelopmentWebSocket(request, server, configuration)
            : proxyDevelopmentHttp(request, server, configuration);

    const serverOptions = {
        development: { console: true, hmr: configuration.hotReload },
        idleTimeout: 0,
        routes: {
            "/api": backendRequest,
            "/api/*": backendRequest,
            "/trpc": backendRequest,
            "/trpc/*": backendRequest,
            "/*": dependencies.dashboardRoute ?? dashboard,
        },
        websocket: developmentWebSocketHandler(configuration),
    } as const;
    const frontend = Bun.serve<DevelopmentProxySocketData>({
        ...serverOptions,
        hostname: configuration.host,
        port: configuration.port,
    });
    const frontendPort = frontend.port;
    if (frontendPort === undefined) {
        await frontend.stop(true);
        throw new Error("Development frontend did not open a TCP listener");
    }
    let ingress: Bun.Server<DevelopmentRemoteProxySocketData> | undefined;
    let remoteProxy: Bun.Server<DevelopmentRemoteProxySocketData> | undefined;
    try {
        if (configuration.ingressSocket !== undefined) {
            await rm(configuration.ingressSocket, { force: true });
            ingress = startDevelopmentUnixProxy({
                frontendTarget: `http://127.0.0.1:${String(frontendPort)}`,
                publicOrigin: configuration.publicOrigin,
                unix: configuration.ingressSocket,
            });
        }
        if (configuration.remoteProxyPort !== undefined) {
            remoteProxy = startDevelopmentRemoteProxy({
                frontendTarget: `http://127.0.0.1:${frontendPort}`,
                port: configuration.remoteProxyPort,
                publicOrigin: configuration.publicOrigin,
            });
        }
    } catch (error) {
        await Promise.all([
            frontend.stop(true),
            ...(ingress === undefined ? [] : [ingress.stop(true)]),
        ]);
        throw error;
    }

    return Object.freeze({
        frontend,
        ...(ingress === undefined ? {} : { ingress }),
        ...(remoteProxy === undefined ? {} : { remoteProxy }),
        async stop(closeActiveConnections = false): Promise<void> {
            await Promise.all([
                frontend.stop(closeActiveConnections),
                ...(ingress === undefined ? [] : [ingress.stop(closeActiveConnections)]),
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
