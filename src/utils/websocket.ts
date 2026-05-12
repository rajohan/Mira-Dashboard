/**
 * Get the WebSocket URL for connecting to the backend server.
 * Responds to dev (port 5173 → 3100 by default) and production (same port).
 */
export function getWebSocketUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname;
    const port = window.location.port || "3100";
    const configuredDevPort = import.meta.env.VITE_DASHBOARD_WS_PORT as
        | string
        | undefined;
    const effectivePort = port === "5173" ? configuredDevPort || "3100" : port;
    return `${protocol}//${host}:${effectivePort}/ws`;
}
