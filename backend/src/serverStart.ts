import { getPersistedGatewayToken } from "./auth.ts";
import gateway from "./gateway.ts";
import { installStructuredConsole } from "./lib/structuredLogger.ts";
import {
    getRuntimeReleaseIdentity,
    requireRunnableReleaseCommit,
} from "./releaseManifest.ts";
import { createServer, resolveListenPort } from "./server.ts";
import { shouldStartScheduledJobs } from "./serverStartPolicy.ts";
import { startDashboardJobWorker, stopDashboardJobWorker } from "./services/jobWorker.ts";
import { registerPullRequestJobLifecycleHandlers } from "./services/pullRequests.ts";

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
            void result.catch((cleanupError) => console.error(label, cleanupError));
        }
    } catch (cleanupError) {
        console.error(label, cleanupError);
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

/** Starts Gateway and notification monitors after the HTTP server is listening. */
export function handleServerListening(releaseCommit: string): void {
    let isGatewayStarted = false;
    try {
        registerPullRequestJobLifecycleHandlers();
        const token = resolveGatewayToken();
        if (token) {
            gateway.init(token);
            isGatewayStarted = true;
        } else {
            console.warn(
                "[Backend] No gateway token configured yet; waiting for bootstrap registration"
            );
        }

        if (shouldStartScheduledJobs()) {
            startDashboardJobWorker(releaseCommit);
        }
    } catch (error) {
        console.error("[Backend] Failed to start background services:", error);
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
                console.error("[Backend] Failed to close server:", cleanupError)
            );
        throw error;
    }
}

/** Binds the HTTP server and starts runtime-only background services. */
export function startBackendServer(port = resolveListenPort()): Promise<void> {
    installStructuredConsole();
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
            startup.resolve();
        } catch (error) {
            serverStartState.activeServer = undefined;
            console.error("[Backend] Failed to start server:", error);
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
    console.error("[Backend] Failed:", error);
    process.exitCode = 1;
}

/** Runs the web process until systemd or an operator requests a clean shutdown. */
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
    exitProcess = process.exit,
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
