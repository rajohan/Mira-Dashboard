import { getPersistedGatewayToken } from "./auth.ts";
import gateway from "./gateway.ts";
import { createStructuredLogger } from "./lib/structuredLogger.ts";
import {
    getRuntimeReleaseIdentity,
    requireRunnableReleaseCommit,
} from "./releaseManifest.ts";
import { createServer, resolveListenPort } from "./server.ts";
import { shouldStartScheduledJobs } from "./serverStartPolicy.ts";
import { startDashboardJobWorker, stopDashboardJobWorker } from "./services/jobWorker.ts";
import { registerPullRequestJobLifecycleHandlers } from "./services/pullRequests.ts";

const logger = createStructuredLogger("server");

const serverStartState: {
    activeServer: ReturnType<typeof createServer> | undefined;
    startupPromise: Promise<void> | undefined;
} = {
    activeServer: undefined,
    startupPromise: undefined,
};

export { runLogRotationCli } from "./services/logRotation.ts";

function rollbackBackgroundServiceStartup(
    function_: () => void | Promise<void>,
    label: string
): void {
    try {
        const result = function_();
        if (result instanceof Promise) {
            void result.catch((error) =>
                logger.error("server.background_cleanup_failed", {
                    error,
                    operation: label,
                })
            );
        }
    } catch (error) {
        logger.error("server.background_cleanup_failed", { error, operation: label });
    }
}

export function resolveGatewayToken(
    environment = process.env,
    persistedToken = getPersistedGatewayToken
): string | undefined {
    return (
        environment.OPENCLAW_GATEWAY_TOKEN?.trim() ||
        persistedToken()?.trim() ||
        undefined
    );
}

/**
 * Starts Gateway and notification monitors after the HTTP server is listening.
 * @param releaseCommit Release commit value.
 */
export function handleServerListening(releaseCommit: string): void {
    let isGatewayStarted = false;
    try {
        registerPullRequestJobLifecycleHandlers();
        const token = resolveGatewayToken();
        if (token) {
            gateway.init(token);
            isGatewayStarted = true;
        } else {
            logger.warn("server.gateway_token_unavailable");
        }

        if (shouldStartScheduledJobs()) {
            startDashboardJobWorker(releaseCommit);
        }
    } catch (error) {
        logger.error("server.background_services_start_failed", { error });
        if (isGatewayStarted) {
            rollbackBackgroundServiceStartup(
                () => gateway.shutdown(),
                "[Backend] Failed to stop gateway:"
            );
        }
        const server = serverStartState.activeServer;
        serverStartState.activeServer = undefined;
        void server
            ?.stop(true)
            .catch((cleanupError) =>
                logger.error("server.http_cleanup_failed", { error: cleanupError })
            );
        throw error;
    }
}

/**
 * Binds the HTTP server and starts runtime-only background services.
 * @param port Port value.
 * @returns Start backend server result.
 */
export function startBackendServer(port = resolveListenPort()): Promise<void> {
    if (serverStartState.activeServer) {
        return Promise.resolve();
    }
    if (serverStartState.startupPromise) {
        return serverStartState.startupPromise;
    }
    const startup = Promise.withResolvers<void>();
    serverStartState.startupPromise = startup.promise;
    void (async () => {
        try {
            const release = await getRuntimeReleaseIdentity();
            const releaseCommit = requireRunnableReleaseCommit(release, "Backend");
            serverStartState.activeServer = createServer(port);
            handleServerListening(releaseCommit);
            logger.info("server.started", {
                port,
                releaseCommit,
            });
            startup.resolve();
        } catch (error) {
            serverStartState.activeServer = undefined;
            logger.error("server.start_failed", { error });
            process.exitCode = 1;
            startup.reject(error);
        } finally {
            if (serverStartState.startupPromise === startup.promise) {
                serverStartState.startupPromise = undefined;
            }
        }
    })();
    return startup.promise;
}

export async function stopBackendServer(): Promise<void> {
    const server = serverStartState.activeServer;
    serverStartState.activeServer = undefined;
    logger.info("server.stopping");
    try {
        await stopDashboardJobWorker();
        gateway.shutdown();
    } finally {
        await server?.stop(true);
    }
}

export function isDirectEntrypoint(isMain = import.meta.main): boolean {
    return isMain;
}

export function shouldStartOnImport(isDirect = isDirectEntrypoint()): boolean {
    return isDirect;
}

interface BackendServerEntrypointOptions {
    exitProcess?: (code: number) => void;
    isDirect?: boolean;
    reportFailure?: (error: unknown) => void;
    runServer?: () => Promise<void>;
}

function reportBackendServerFailure(error: unknown): void {
    logger.error("server.entrypoint_failed", { error });
    process.exitCode = 1;
}

/**
 * Runs the web process until systemd or an operator requests a clean shutdown.
 * @param port Port value.
 */
export async function runBackendServer(port = resolveListenPort()): Promise<void> {
    const shutdown = Promise.withResolvers<NodeJS.Signals>();
    const stop = (signal: NodeJS.Signals) => shutdown.resolve(signal);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        await startBackendServer(port);
        await shutdown.promise;
    } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await stopBackendServer();
    }
}

/**
 * Awaits direct CLI startup while preserving non-blocking opt-in startup for
 * modules imported by other runtimes without claiming their process signals.
 */
export async function startBackendServerEntrypoint({
    exitProcess = process.exit.bind(process),
    isDirect = isDirectEntrypoint(),
    reportFailure = reportBackendServerFailure,
    runServer = runBackendServer,
}: BackendServerEntrypointOptions = {}): Promise<void> {
    if (!isDirect) {
        return;
    }
    let exitCode = 0;
    try {
        await runServer();
    } catch (error) {
        reportFailure(error);
        exitCode = 1;
    }
    exitProcess(exitCode);
}

if (shouldStartOnImport()) {
    await startBackendServerEntrypoint();
}
