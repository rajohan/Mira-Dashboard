/**
 * Get the WebSocket URL for connecting to the backend server.
 * Handles dev (port 5173 → 3100) and production (same port).
 */
export function getWebSocketUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname;
    const port = window.location.port || "3100";
    const effectivePort = port === "5173" ? "3100" : port;
    return `${protocol}//${host}:${effectivePort}/ws`;
}
