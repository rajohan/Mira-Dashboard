import { WebSocketServer } from "ws";

let socketServer: WebSocketServer | null = null;

export function setNotificationSocketServer(server: WebSocketServer): void {
    socketServer = server;
}

export function emitNotificationsUpdated(reason: "created" | "read" | "read_all"): void {
    if (!socketServer) {
        return;
    }

    const payload = JSON.stringify({
        type: "event",
        event: "notifications.updated",
        payload: {
            reason,
            at: Date.now(),
        },
    });

    for (const client of socketServer.clients) {
        if (client.readyState === 1) {
            client.send(payload);
        }
    }
}
