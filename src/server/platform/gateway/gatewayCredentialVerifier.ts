import {
    createGatewayCredentialConnectFrame,
    gatewayCredentialChallengeMaximumBytes,
    gatewayCredentialMessageMaximumBytes,
    parseGatewayCredentialProtocolFrame,
} from "./gatewayCredentialProtocol.ts";

const gatewayUrlMaximumLength = 2048;
const asciiControlCharacterMaximum = 31;
const asciiDeleteCharacter = 127;
const gatewayCredentialVerificationRequestId = "gateway-credential-verification";
const normalVerifierCloseCode = 1000;
const normalVerifierCloseReason = "credential verification complete";

export class GatewayCredentialVerifierConfigurationError extends TypeError {}

/** Safe failure for malformed protocol, transport, or unavailable Gateway state. */
export class GatewayCredentialVerifierUnavailableError extends Error {}

export type GatewayWebSocketFactory = (url: string) => WebSocket;

export interface GatewayCredentialVerifierOptions {
    /** Explicit direct-loopback WebSocket endpoint for the local Gateway. */
    readonly url: string;
    /** Test seam. Production uses Bun's native global WebSocket constructor. */
    readonly webSocketFactory?: GatewayWebSocketFactory;
}

export type GatewayCredentialVerifier = (
    credential: string,
    signal?: AbortSignal
) => Promise<boolean>;

function containsControlCharacter(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (
            codePoint !== undefined &&
            (codePoint <= asciiControlCharacterMaximum ||
                codePoint === asciiDeleteCharacter)
        ) {
            return true;
        }
    }
    return false;
}

function unavailable(): GatewayCredentialVerifierUnavailableError {
    return new GatewayCredentialVerifierUnavailableError(
        "Gateway credential verification is unavailable"
    );
}

/**
 * Validates and canonicalizes the explicit direct-loopback Gateway endpoint.
 * @param value Candidate composition URL.
 * @returns Canonical direct-loopback `ws://` endpoint.
 */
export function parseGatewayCredentialVerifierUrl(value: string): string {
    if (
        value.length === 0 ||
        value.length > gatewayUrlMaximumLength ||
        value !== value.trim() ||
        containsControlCharacter(value)
    ) {
        throw new GatewayCredentialVerifierConfigurationError(
            "Gateway verifier URL is invalid"
        );
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new GatewayCredentialVerifierConfigurationError(
            "Gateway verifier URL is invalid"
        );
    }
    if (
        url.protocol !== "ws:" ||
        (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
        url.port.length === 0 ||
        Number(url.port) === 0 ||
        url.pathname !== "/" ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
    ) {
        throw new GatewayCredentialVerifierConfigurationError(
            "Gateway verifier URL is invalid"
        );
    }
    const canonicalUrl = url.href;
    if (value !== canonicalUrl && value !== canonicalUrl.slice(0, -1)) {
        throw new GatewayCredentialVerifierConfigurationError(
            "Gateway verifier URL is invalid"
        );
    }
    return canonicalUrl;
}

function abortError(): DOMException {
    return new DOMException("Gateway verification aborted", "AbortError");
}

function boundedMessageText(data: unknown, maximumBytes: number): string {
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > maximumBytes) {
        throw unavailable();
    }
    return data;
}

function decodedGatewayFrame(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw unavailable();
    }
}

type PendingVerificationOutcome =
    | { readonly kind: "reject"; readonly error: Error }
    | { readonly kind: "resolve"; readonly value: boolean };

/**
 * Creates a one-shot native WebSocket verifier for first-user bootstrap.
 * Effect-owned authentication work supplies cancellation, deadline, admission,
 * and active-work lifetime around this cooperative transport adapter.
 * @param options Explicit Gateway endpoint and optional test socket factory.
 * @returns Credential verifier that never reconnects, persists, or logs credentials.
 */
export function createGatewayCredentialVerifier(
    options: GatewayCredentialVerifierOptions
): GatewayCredentialVerifier {
    const url = parseGatewayCredentialVerifierUrl(options.url);
    const createSocket = options.webSocketFactory ?? ((target) => new WebSocket(target));

    return (credential, signal) => {
        if (signal?.aborted) return Promise.reject(abortError());

        return new Promise<boolean>((resolve, reject) => {
            let connectRequestSent = false;
            let closeListenerInstalled = false;
            let pendingOutcome: PendingVerificationOutcome | undefined;
            let settled = false;
            let socket: WebSocket;

            const removeWorkListeners = (): void => {
                try {
                    signal?.removeEventListener("abort", onAbort);
                } catch {
                    // Listener cleanup never changes the redacted outcome.
                }
                try {
                    socket.removeEventListener("error", onError);
                    socket.removeEventListener("message", onMessage);
                } catch {
                    // Listener cleanup never changes the redacted outcome.
                }
            };
            const finalizeAfterClose = (): void => {
                if (settled || pendingOutcome === undefined) return;
                settled = true;
                removeWorkListeners();
                if (closeListenerInstalled) {
                    try {
                        socket.removeEventListener("close", onClose);
                    } catch {
                        // The native close was already observed.
                    }
                }
                if (pendingOutcome.kind === "resolve") {
                    resolve(pendingOutcome.value);
                } else {
                    reject(pendingOutcome.error);
                }
            };
            const closeSocket = (): void => {
                try {
                    socket.close(normalVerifierCloseCode, normalVerifierCloseReason);
                } catch {
                    try {
                        if (socket.readyState === WebSocket.CLOSED) {
                            finalizeAfterClose();
                        }
                    } catch {
                        // Hold the permit fail-closed when close state is unknowable.
                    }
                }
            };
            const requestOutcome = (outcome: PendingVerificationOutcome): void => {
                if (settled || pendingOutcome !== undefined) return;
                pendingOutcome = outcome;
                removeWorkListeners();
                try {
                    if (socket.readyState === WebSocket.CLOSED) {
                        finalizeAfterClose();
                        return;
                    }
                } catch {
                    // Close below and retain the permit until an observed close.
                }
                closeSocket();
            };
            const onAbort = (): void =>
                requestOutcome({
                    error: signal === undefined ? unavailable() : abortError(),
                    kind: "reject",
                });
            const onClose = (): void => {
                if (pendingOutcome === undefined) {
                    pendingOutcome = { error: unavailable(), kind: "reject" };
                }
                finalizeAfterClose();
            };
            const onError = (): void =>
                requestOutcome({ error: unavailable(), kind: "reject" });
            const onMessage = (event: MessageEvent): void => {
                try {
                    const maximumBytes = connectRequestSent
                        ? gatewayCredentialMessageMaximumBytes
                        : gatewayCredentialChallengeMaximumBytes;
                    const outcome = parseGatewayCredentialProtocolFrame(
                        decodedGatewayFrame(boundedMessageText(event.data, maximumBytes)),
                        gatewayCredentialVerificationRequestId
                    );
                    if (outcome === undefined) {
                        requestOutcome({ error: unavailable(), kind: "reject" });
                        return;
                    }
                    if (outcome.kind === "challenge") {
                        if (connectRequestSent || socket.readyState !== WebSocket.OPEN) {
                            requestOutcome({ error: unavailable(), kind: "reject" });
                            return;
                        }
                        const frame = createGatewayCredentialConnectFrame({
                            credential,
                            requestId: gatewayCredentialVerificationRequestId,
                        });
                        socket.send(JSON.stringify(frame));
                        connectRequestSent = true;
                        return;
                    }
                    if (!connectRequestSent) {
                        requestOutcome({ error: unavailable(), kind: "reject" });
                        return;
                    }
                    requestOutcome(
                        outcome.kind === "verified"
                            ? { kind: "resolve", value: true }
                            : { kind: "resolve", value: false }
                    );
                } catch {
                    requestOutcome({ error: unavailable(), kind: "reject" });
                }
            };

            try {
                socket = createSocket(url);
            } catch {
                reject(unavailable());
                return;
            }
            try {
                socket.addEventListener("close", onClose, { once: true });
                closeListenerInstalled = true;
                socket.addEventListener("error", onError, { once: true });
                socket.addEventListener("message", onMessage);
                signal?.addEventListener("abort", onAbort, { once: true });
                if (signal?.aborted) onAbort();
            } catch {
                requestOutcome({ error: unavailable(), kind: "reject" });
            }
        });
    };
}
