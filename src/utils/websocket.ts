/**
 * Get the WebSocket URL for connecting to the backend server.
 * Uses the current origin so the dev server can proxy /ws.
 */
export function getWebSocketUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
}
