import {
    canonicalizeOpenClawHistoryMessageResult,
    canonicalizeOpenClawHistoryPage,
} from "../../../../contracts/chat/openClawHistoryPageAdapter.ts";
import type { Session } from "../../../../contracts/sessions.ts";
import { MAX_DASHBOARD_SOCKET_REQUEST_TIMEOUT_MS } from "../../../../contracts/socket.ts";
import { errorMessage } from "../../lib/errors.ts";
import { hashedLogCorrelation, runWithLogContext } from "../../lib/logContext.ts";
import {
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayRequestOptions,
} from "../../lib/openclawGatewayClient/client.ts";
import { type OpenClawChatBridge } from "../chat/openClawChatBridge.ts";
import type { DashboardSocket } from "./dashboardSocket.ts";
import { normalizeGatewaySessionList } from "./sessionProjection.ts";
import type { OpenClawTranscriptImageHydrator } from "./transcriptImageHydrator.ts";

const DEFAULT_FORWARDED_GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 15 * 60_000;

interface PendingRequest {
    clientWs: DashboardSocket;
    clientId: string;
    method?: string;
}

interface GatewayRequestForwarderOptions {
    broadcast: (message: unknown) => void;
    publishSessions: (client: OpenClawGatewayClientInstance, sessions: Session[]) => void;
    readActiveClient: () => OpenClawGatewayClientInstance | undefined;
    readChatBridge: () => OpenClawChatBridge;
    refreshSessionsAfterRequest: (client: OpenClawGatewayClientInstance) => Promise<void>;
    transcriptImageHydrator: OpenClawTranscriptImageHydrator;
}

/** Forwards Dashboard requests while preserving replay and response boundaries. */
export class GatewayRequestForwarder {
    readonly #options: GatewayRequestForwarderOptions;
    readonly #pendingRequests = new Map<string, PendingRequest>();
    #requestId = 1000;

    constructor(options: GatewayRequestForwarderOptions) {
        this.#options = options;
    }

    get pendingRequestCount(): number {
        return this.#pendingRequests.size;
    }

    removePendingRequests(client: DashboardSocket): void {
        for (const [id, pending] of this.#pendingRequests) {
            if (pending.clientWs === client) {
                this.#pendingRequests.delete(id);
            }
        }
    }

    failPendingRequests(error: string): void {
        for (const pending of this.#pendingRequests.values()) {
            this.#sendPendingRequestError(pending, error);
        }
        this.#pendingRequests.clear();
    }

    #sendPendingRequestError(pending: PendingRequest, error: string): void {
        try {
            if (!pending.clientWs.isOpen()) {
                return;
            }
            pending.clientWs.send(
                JSON.stringify({
                    type: "response",
                    id: pending.clientId,
                    isOk: false,
                    error,
                })
            );
        } catch {
            // The client disconnected while the Gateway request was in flight.
        }
    }

    #captureChatSendRequestBoundary(
        method: string,
        parameters: Record<string, unknown>
    ): number | undefined {
        if (method !== "chat.send") {
            return undefined;
        }
        return this.#options
            .readChatBridge()
            .captureRequestBoundary(
                typeof parameters.sessionKey === "string"
                    ? parameters.sessionKey
                    : undefined,
                typeof parameters.idempotencyKey === "string"
                    ? parameters.idempotencyKey
                    : undefined
            );
    }

    async #requestWithReplayBoundaryInContext(
        client: OpenClawGatewayClientInstance,
        method: string,
        parameters: Record<string, unknown>,
        options?: OpenClawGatewayRequestOptions
    ): Promise<unknown> {
        let requestBoundary: number | undefined;
        let didCaptureRequestBoundary = false;
        try {
            requestBoundary = this.#captureChatSendRequestBoundary(method, parameters);
            didCaptureRequestBoundary = method === "chat.send";
            const payload = await client.request(method, parameters, options);
            const identityEnvelope = this.#options
                .readChatBridge()
                .handleSuccessfulRequest(method, parameters, payload, requestBoundary);
            if (identityEnvelope) {
                this.#options.broadcast(identityEnvelope);
            }
            return payload;
        } catch (error) {
            if (didCaptureRequestBoundary) {
                this.#options
                    .readChatBridge()
                    .handleFailedRequest(method, parameters, requestBoundary);
            }
            throw error;
        }
    }

    #sessionIdentifier(
        method: string,
        parameters: Record<string, unknown>
    ): string | undefined {
        if (typeof parameters.sessionKey === "string") {
            return parameters.sessionKey;
        }
        if (typeof parameters.sessionId === "string") {
            return parameters.sessionId;
        }
        if (typeof parameters.key === "string" && method.startsWith("sessions.")) {
            return parameters.key;
        }
        return undefined;
    }

    async request(
        client: OpenClawGatewayClientInstance,
        method: string,
        parameters: Record<string, unknown>,
        options?: OpenClawGatewayRequestOptions
    ): Promise<unknown> {
        const sessionIdentifier = this.#sessionIdentifier(method, parameters);
        return runWithLogContext(
            {
                ...(sessionIdentifier && {
                    sessionId: hashedLogCorrelation(
                        "openclaw-session",
                        sessionIdentifier
                    ),
                }),
            },
            () =>
                this.#requestWithReplayBoundaryInContext(
                    client,
                    method,
                    parameters,
                    options
                )
        );
    }

    async forward(
        method: string,
        parameters: Record<string, unknown>,
        clientWs?: DashboardSocket,
        clientId?: string,
        timeoutMs?: number
    ): Promise<boolean> {
        const activeGateway = this.#options.readActiveClient();
        if (!activeGateway) {
            return false;
        }
        const requestOptions = {
            timeoutMs:
                method === "sessions.compact"
                    ? SESSION_COMPACT_REQUEST_TIMEOUT_MS
                    : Math.min(
                          timeoutMs ?? DEFAULT_FORWARDED_GATEWAY_REQUEST_TIMEOUT_MS,
                          MAX_DASHBOARD_SOCKET_REQUEST_TIMEOUT_MS
                      ),
        };

        if (clientWs && clientId) {
            const id = String(++this.#requestId);
            this.#pendingRequests.set(id, { clientWs, clientId, method });
            await this.#forwardDashboardRequest(
                id,
                activeGateway,
                method,
                parameters,
                requestOptions
            );
            return true;
        }

        try {
            const payload = await this.request(
                activeGateway,
                method,
                parameters,
                requestOptions
            );
            if (method === "sessions.list") {
                this.#options.publishSessions(
                    activeGateway,
                    normalizeGatewaySessionList(payload)
                );
            } else if (method.startsWith("sessions.")) {
                await this.#options.refreshSessionsAfterRequest(activeGateway);
            }
            return true;
        } catch {
            return false;
        }
    }

    async #forwardDashboardRequest(
        id: string,
        activeGateway: OpenClawGatewayClientInstance,
        method: string,
        parameters: Record<string, unknown>,
        requestOptions: OpenClawGatewayRequestOptions
    ): Promise<void> {
        try {
            let payload = await this.request(
                activeGateway,
                method,
                parameters,
                requestOptions
            );
            let normalizedSessions: Session[] | undefined;
            if (method === "chat.history") {
                payload = await this.#options.transcriptImageHydrator.hydrateHistory(
                    payload,
                    typeof parameters.sessionKey === "string"
                        ? parameters.sessionKey
                        : undefined
                );
                payload = canonicalizeOpenClawHistoryPage(payload, {
                    messageId:
                        typeof parameters.messageId === "string"
                            ? parameters.messageId
                            : undefined,
                    offset:
                        typeof parameters.offset === "number" &&
                        Number.isSafeInteger(parameters.offset) &&
                        parameters.offset >= 0
                            ? parameters.offset
                            : 0,
                    sessionKey:
                        typeof parameters.sessionKey === "string"
                            ? parameters.sessionKey
                            : "",
                });
            } else if (method === "chat.message.get") {
                const requestedSessionKey =
                    typeof parameters.sessionKey === "string"
                        ? parameters.sessionKey
                        : undefined;
                payload = await this.#options.transcriptImageHydrator.hydrateMessage(
                    payload,
                    requestedSessionKey
                );
                payload = canonicalizeOpenClawHistoryMessageResult(payload, {
                    messageId:
                        typeof parameters.messageId === "string"
                            ? parameters.messageId
                            : "",
                    sessionKey: requestedSessionKey ?? "",
                });
            } else if (method === "sessions.list") {
                normalizedSessions = normalizeGatewaySessionList(payload);
                payload = { sessions: normalizedSessions };
            }

            const pending = this.#pendingRequests.get(id);
            this.#pendingRequests.delete(id);
            try {
                if (pending?.clientWs.isOpen()) {
                    pending.clientWs.send(
                        JSON.stringify({
                            type: "response",
                            id: pending.clientId,
                            isOk: true,
                            payload,
                        })
                    );
                }
            } catch {
                // Ignore reply write failures; the Gateway call already succeeded.
            }
            if (normalizedSessions) {
                this.#options.publishSessions(activeGateway, normalizedSessions);
            } else if (method.startsWith("sessions.")) {
                await this.#options.refreshSessionsAfterRequest(activeGateway);
            }
        } catch (error) {
            const pending = this.#pendingRequests.get(id);
            this.#pendingRequests.delete(id);
            if (pending) {
                this.#sendPendingRequestError(
                    pending,
                    errorMessage(error, "Gateway request failed")
                );
            }
        }
    }
}
