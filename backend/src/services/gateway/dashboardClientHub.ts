import type { Session } from "../../../../contracts/sessions.ts";
import { parseDashboardSocketRequest } from "../../../../contracts/socket.ts";
import type { DashboardSocket } from "../../dashboardSocket.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    subscribeToDashboardLogs,
    unsubscribeFromDashboardLogs,
} from "../appLogStreams.ts";
import {
    subscribeToLogs as subscribeToServiceLogs,
    unsubscribeFromLogs as unsubscribeFromServiceLogs,
} from "../logStreams.ts";

const logger = createStructuredLogger("gateway");

interface GatewayDashboardClientHubOptions {
    forwardRequest: (
        method: string,
        parameters: Record<string, unknown>,
        clientWs: DashboardSocket,
        clientId?: string,
        timeoutMs?: number
    ) => Promise<boolean>;
    readRuntimeSnapshot: (sessionKey: string) => Record<string, unknown>;
    readState: () => { gatewayConnected: boolean; sessions: Session[] };
    removePendingRequests: (client: DashboardSocket) => void;
}

/** Owns Dashboard WebSocket subscriptions and request dispatch. */
export class GatewayDashboardClientHub {
    readonly #options: GatewayDashboardClientHubOptions;
    readonly #subscribers = new Set<DashboardSocket>();

    constructor(options: GatewayDashboardClientHubOptions) {
        this.#options = options;
    }

    broadcast(message: unknown): void {
        const data = JSON.stringify(message);
        for (const client of this.#subscribers) {
            try {
                if (client.isOpen()) {
                    client.send(data);
                }
            } catch {
                // Ignore errors from closed connections.
            }
        }
    }

    #cleanupClient(client: DashboardSocket): void {
        this.#subscribers.delete(client);
        unsubscribeFromDashboardLogs(client);
        unsubscribeFromServiceLogs(client);
        this.#options.removePendingRequests(client);
    }

    handle(client: DashboardSocket): void {
        client.onError((error) => {
            logger.error("gateway.client_socket_failed", { error });
            this.#cleanupClient(client);
        });

        this.#subscribers.add(client);
        try {
            client.send(
                JSON.stringify({
                    type: "state",
                    ...this.#options.readState(),
                })
            );
        } catch (error) {
            logger.error("gateway.initial_client_state_send_failed", { error });
            this.#cleanupClient(client);
            client.close();
            return;
        }

        client.onMessage((data) => {
            void this.#handleMessage(client, data);
        });
        client.onClose(() => {
            this.#cleanupClient(client);
        });
    }

    async #handleMessage(client: DashboardSocket, data: Buffer | string): Promise<void> {
        try {
            const message = parseDashboardSocketRequest(JSON.parse(data.toString()));
            if (message.type === "subscribe" && message.channel === "logs") {
                subscribeToServiceLogs(client);
                return;
            }
            if (message.type === "unsubscribe" && message.channel === "logs") {
                unsubscribeFromServiceLogs(client);
                return;
            }
            if (message.type === "subscribe" && message.channel === "dashboard-logs") {
                subscribeToDashboardLogs(client);
                return;
            }
            if (
                message.type === "unsubscribe" &&
                message.channel === "dashboard-logs"
            ) {
                unsubscribeFromDashboardLogs(client);
                return;
            }

            if (
                (message.type === "request" || message.type === "req") &&
                message.method === "subscribe" &&
                message.params?.channel === "logs"
            ) {
                subscribeToServiceLogs(client);
                this.#sendSubscriptionResponse(client, message.id);
                return;
            }
            if (
                (message.type === "request" || message.type === "req") &&
                message.method === "subscribe" &&
                message.params?.channel === "dashboard-logs"
            ) {
                subscribeToDashboardLogs(client);
                this.#sendSubscriptionResponse(client, message.id);
                return;
            }
            if (
                (message.type === "request" || message.type === "req") &&
                message.method === "unsubscribe" &&
                message.params?.channel === "dashboard-logs"
            ) {
                unsubscribeFromDashboardLogs(client);
                this.#sendSubscriptionResponse(client, message.id);
                return;
            }
            if (
                (message.type === "request" || message.type === "req") &&
                message.method === "unsubscribe" &&
                message.params?.channel === "logs"
            ) {
                unsubscribeFromServiceLogs(client);
                this.#sendSubscriptionResponse(client, message.id);
                return;
            }
            if (
                (message.type !== "request" && message.type !== "req") ||
                !message.method
            ) {
                return;
            }

            if (message.method === "chat.runtimeSnapshot") {
                if (message.id && client.isOpen()) {
                    const sessionKey =
                        typeof message.params?.sessionKey === "string"
                            ? message.params.sessionKey
                            : "";
                    client.send(
                        JSON.stringify({
                            type: "response",
                            id: message.id,
                            isOk: true,
                            payload: this.#options.readRuntimeSnapshot(sessionKey),
                        })
                    );
                }
                return;
            }

            const isOk = await this.#options.forwardRequest(
                message.method,
                message.params || {},
                client,
                message.id,
                message.timeoutMs
            );
            if (!isOk && message.id && client.isOpen()) {
                client.send(
                    JSON.stringify({
                        type: "response",
                        id: message.id,
                        isOk: false,
                        error: "Gateway not connected",
                    })
                );
            }
        } catch (error) {
            logger.error("gateway.client_message_failed", { error });
        }
    }

    #sendSubscriptionResponse(client: DashboardSocket, id?: string): void {
        if (!id) {
            return;
        }
        client.send(
            JSON.stringify({
                type: "response",
                id,
                isOk: true,
            })
        );
    }
}
