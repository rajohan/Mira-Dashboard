/**
 * Get the WebSocket URL for connecting to the backend server.
 * Responds to dev (port 5173 → 3100 by default) and production (same port).
 */
export function getWebSocketUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const host = location.hostname;
    const port = location.port || "3100";
    const configuredDevelopmentPort = import.meta.env.VITE_DASHBOARD_WS_PORT as
        | string
        | undefined;
    const effectivePort = port === "5173" ? configuredDevelopmentPort || "3100" : port;
    return `${protocol}//${host}:${effectivePort}/ws`;
}
