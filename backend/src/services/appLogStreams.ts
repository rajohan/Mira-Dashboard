import type { DashboardSocket } from "../dashboardSocket.ts";
import { subscribeToStructuredLogs } from "../lib/structuredLogger.ts";

const dashboardLogSubscriptions = new Map<DashboardSocket, () => void>();

/** Streams every newly emitted Dashboard structured log line to one client. */
export function subscribeToDashboardLogs(socket: DashboardSocket): void {
    if (dashboardLogSubscriptions.has(socket)) return;

    const unsubscribe = subscribeToStructuredLogs((line) => {
        if (!socket.isOpen()) return;
        try {
            socket.send(JSON.stringify({ line, type: "dashboard_log" }));
        } catch {
            // Socket cleanup removes the listener; logging here would recurse.
        }
    });
    dashboardLogSubscriptions.set(socket, unsubscribe);
}

/** Stops Dashboard structured-log delivery for one client. */
export function unsubscribeFromDashboardLogs(socket: DashboardSocket): void {
    dashboardLogSubscriptions.get(socket)?.();
    dashboardLogSubscriptions.delete(socket);
}
