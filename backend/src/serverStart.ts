import { getPersistedGatewayToken } from "./auth.ts";
import gateway from "./gateway.ts";
import { createServer, resolveListenPort } from "./server.ts";
import { shouldStartScheduledJobs } from "./serverStartPolicy.ts";
import { startDashboardJobWorker, stopDashboardJobWorker } from "./services/jobWorker.ts";
import { registerPullRequestJobLifecycleHandlers } from "./services/pullRequests.ts";

const serverStartState: {
    activeServer: ReturnType<typeof createServer> | undefined;
    isStarting: boolean;
} = {
    activeServer: undefined,
    isStarting: false,
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
        environment.OPENCLAW_TOKEN?.trim() ||
        persistedToken()?.trim() ||
        undefined
    );
}

/** Starts Gateway and notification monitors after the HTTP server is listening. */
export function handleServerListening(): void {
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
            startDashboardJobWorker();
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
export function startBackendServer(port = resolveListenPort()): void {
    if (serverStartState.activeServer || serverStartState.isStarting) {
        return;
    }
    serverStartState.isStarting = true;
    try {
        serverStartState.activeServer = createServer(port);
        handleServerListening();
        serverStartState.isStarting = false;
    } catch (error) {
        serverStartState.isStarting = false;
        serverStartState.activeServer = undefined;
        console.error("[Backend] Failed to start server:", error);
        process.exitCode = 1;
        throw error;
    }
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

export function shouldStartOnImport(
    startOnImport = process.env.MIRA_DASHBOARD_START_ON_IMPORT,
    isDirect = isDirectEntrypoint()
): boolean {
    return startOnImport === "1" || isDirect;
}

interface BackendServerEntrypointOptions {
    isDirect?: boolean;
    reportFailure?: (error: unknown) => void;
    runServer?: () => Promise<void>;
    startOnImport?: string;
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
        startBackendServer(port);
        await shutdown.promise;
    } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await stopBackendServer();
    }
}

/**
 * Awaits direct CLI startup while preserving non-blocking opt-in startup for
 * modules imported by tests or other runtimes.
 */
export async function startBackendServerEntrypoint({
    isDirect = isDirectEntrypoint(),
    reportFailure = reportBackendServerFailure,
    runServer = runBackendServer,
    startOnImport = process.env.MIRA_DASHBOARD_START_ON_IMPORT,
}: BackendServerEntrypointOptions = {}): Promise<void> {
    if (!shouldStartOnImport(startOnImport, isDirect)) {
        return;
    }
    if (!isDirect) {
        void runServer().catch(reportFailure);
        return;
    }
    try {
        await runServer();
    } catch (error) {
        reportFailure(error);
    }
}

if (shouldStartOnImport()) {
    await startBackendServerEntrypoint();
}
