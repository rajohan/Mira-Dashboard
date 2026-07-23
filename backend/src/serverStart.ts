import { getPersistedGatewayToken } from "./auth.ts";
import gateway from "./gateway.ts";
import { createServer, resolveListenPort } from "./server.ts";
import { shouldStartScheduledJobs } from "./serverStartPolicy.ts";
import { startDashboardJobWorker, stopDashboardJobWorker } from "./services/jobWorker.ts";

const serverStartState: {
    activeServer: ReturnType<typeof createServer> | undefined;
    stopWorkerOnServerClose?: () => Promise<void>;
    isStarting: boolean;
} = {
    activeServer: undefined,
    isStarting: false,
};

export { runLogRotationCli } from "./services/logRotation.ts";

function installWorkerCloseCleanup(): void {
    if (serverStartState.stopWorkerOnServerClose) {
        return;
    }
    serverStartState.stopWorkerOnServerClose = async () => {
        await stopDashboardJobWorker();
        serverStartState.stopWorkerOnServerClose = undefined;
    };
}

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

function removeWorkerCloseCleanup(): void {
    if (!serverStartState.stopWorkerOnServerClose) {
        return;
    }

    serverStartState.stopWorkerOnServerClose = undefined;
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
    let isJobWorkerStarted = false;
    try {
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
            isJobWorkerStarted = true;
            installWorkerCloseCleanup();
        }
    } catch (error) {
        console.error("[Backend] Failed to start background services:", error);
        if (isJobWorkerStarted) {
            removeWorkerCloseCleanup();
            rollbackBackgroundServiceStartup(
                () => stopDashboardJobWorker(),
                "[Backend] Failed to stop job worker:"
            );
        }
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
        removeWorkerCloseCleanup();
        await stopDashboardJobWorker();
        gateway.shutdown();
    } finally {
        await server?.stop(true);
    }
}

export function isDirectEntrypoint(
    argvPath = process.argv[1],
    moduleUrl = import.meta.url
): boolean {
    return Boolean(argvPath && moduleUrl === Bun.pathToFileURL(argvPath).href);
}

export function shouldStartOnImport(
    startOnImport = process.env.MIRA_DASHBOARD_START_ON_IMPORT,
    isDirect = isDirectEntrypoint()
): boolean {
    return startOnImport === "1" || isDirect;
}

if (shouldStartOnImport()) {
    startBackendServer();
}
