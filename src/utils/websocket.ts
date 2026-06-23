/**
 * Get the WebSocket URL for connecting to the backend server.
 * Uses the current origin so the dev server can proxy /ws.
 */
export function getWebSocketUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws`;
}
