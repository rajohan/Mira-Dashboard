import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign,
} from "node:crypto";
import fs from "node:fs";
import Path from "node:path";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const MIN_TICK_INTERVAL_MS = 1000;
const MAX_TICK_INTERVAL_MS = 5 * 60_000;
const TICK_WATCH_POLL_INTERVAL_MS = 1000;
const DEFAULT_CONNECT_CHALLENGE_TIMEOUT_MS = 10_000;

/** Defines device identity. */
export type DeviceIdentity = {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
};

/** Defines gateway hello success payload. */
export type GatewayHelloOk = {
    type?: string;
    protocol?: number;
    policy?: {
        tickIntervalMs?: number;
    };
};

/** Defines gateway event. */
export type GatewayEvent = {
    type?: string;
    event?: string;
    payload?: unknown;
    seq?: number;
    stateVersion?: number;
};

/** Defines gateway response. */
type GatewayResponse = {
    type?: string;
    id?: string;
    isOk?: boolean | undefined | null;
    ok?: boolean;
    payload?: unknown;
    error?: {
        code?: string;
        message?: string;
        details?: unknown;
    };
};

/** Defines pending request entry. */
type PendingRequestEntry = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
};

async function websocketMessageToString(data: unknown): Promise<string> {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
            "utf8"
        );
    }
    if (data instanceof Blob) return data.text();
    return String(data);
}

/** Defines open claw gateway client options. */
export type OpenClawGatewayClientOptions = {
    url?: string;
    token?: string;
    role?: string;
    scopes?: string[];
    caps?: string[];
    clientName?: string;
    clientDisplayName?: string;
    clientVersion?: string;
    mode?: string;
    platform?: string;
    deviceFamily?: string;
    deviceIdentity?: DeviceIdentity;
    requestTimeoutMs?: number;
    onHelloOk?: (payload: GatewayHelloOk) => void;
    onEvent?: (event: GatewayEvent) => void;
    onConnectError?: (error: Error) => void;
    onClose?: (code: number, reason: string) => void;
};

/** Defines open claw gateway client instance. */
export type OpenClawGatewayClientInstance = {
    start: () => void;
    stop: () => void;
    request: (method: string, parameters?: unknown) => Promise<unknown>;
};

/** Performs base64 URL encode. */
function base64UrlEncode(buffer: Buffer): string {
    const bytes = buffer as unknown as Uint8Array & { toBase64: () => string };
    return bytes.toBase64().replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Clamps timer durations from Gateway policy before they reach setInterval/setTimeout. */
function sanitizeTimerDurationMs(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(
        Math.max(Math.trunc(value), MIN_TICK_INTERVAL_MS),
        MAX_TICK_INTERVAL_MS
    );
}

/** Performs derive public key raw. */
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
    const spki = createPublicKey(publicKeyPem).export({
        type: "spki",
        format: "der",
    });

    if (
        spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}

/** Performs fingerprint public key. */
function fingerprintPublicKey(publicKeyPem: string): string {
    return new Bun.CryptoHasher("sha256")
        .update(derivePublicKeyRaw(publicKeyPem))
        .digest("hex") as string;
}

/** Performs public key raw base64 URL from pem. */
function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
    return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

/** Returns a normalized error instance for callback surfaces. */
function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/** Performs sign device payload. */
function signDevicePayload(privateKeyPem: string, payload: string): string {
    const key = createPrivateKey(privateKeyPem);
    return base64UrlEncode(sign(undefined, Buffer.from(payload, "utf8"), key));
}

/** Performs generate IDentity. */
function generateIdentity(): DeviceIdentity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    return {
        deviceId: fingerprintPublicKey(publicKeyPem),
        publicKeyPem,
        privateKeyPem,
    };
}

/** Performs load or create device IDentity. */
export function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
    fs.mkdirSync(Path.dirname(filePath), { recursive: true });

    try {
        const parsed = JSON.parse(
            fs.readFileSync(filePath, "utf8")
        ) as Partial<DeviceIdentity> & {
            version?: number;
        };

        if (
            parsed?.version === 1 &&
            typeof parsed.deviceId === "string" &&
            typeof parsed.publicKeyPem === "string" &&
            typeof parsed.privateKeyPem === "string"
        ) {
            const identity: DeviceIdentity = {
                deviceId: fingerprintPublicKey(parsed.publicKeyPem),
                publicKeyPem: parsed.publicKeyPem,
                privateKeyPem: parsed.privateKeyPem,
            };

            fs.writeFileSync(
                filePath,
                `${JSON.stringify({ version: 1, ...identity }, undefined, 2)}\n`,
                { mode: 0o600 }
            );

            return identity;
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !(error instanceof SyntaxError)) {
            throw error;
        }
        // Missing or invalid JSON identity file; generate new identity below.
    }

    const identity = generateIdentity();
    fs.writeFileSync(
        filePath,
        `${JSON.stringify({ version: 1, ...identity }, undefined, 2)}\n`,
        {
            mode: 0o600,
        }
    );
    return identity;
}

/** Normalizes device metadata for auth. */
function normalizeDeviceMetadataForAuth(value?: string): string {
    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();
    return trimmed ? trimmed.replaceAll(/[A-Z]/gu, (char) => char.toLowerCase()) : "";
}

/** Builds device auth payload v3. */
function buildDeviceAuthPayloadV3(parameters: {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | undefined;
    nonce: string;
    platform?: string;
    deviceFamily?: string;
}): string {
    return [
        "v3",
        parameters.deviceId,
        parameters.clientId,
        parameters.clientMode,
        parameters.role,
        parameters.scopes.join(","),
        String(parameters.signedAtMs),
        parameters.token ?? "",
        parameters.nonce,
        normalizeDeviceMetadataForAuth(parameters.platform),
        normalizeDeviceMetadataForAuth(parameters.deviceFamily),
    ].join("|");
}

/** Implements open claw gateway client. */
export class OpenClawGatewayClient implements OpenClawGatewayClientInstance {
    private static readonly MAX_PENDING_REQUESTS = 1000;
    declare private readonly opts: OpenClawGatewayClientOptions;
    private ws: WebSocket | undefined = undefined;
    private requestId = 0;
    private readonly pending = new Map<string, PendingRequestEntry>();
    private closed = false;
    private reconnectTimer: NodeJS.Timeout | undefined = undefined;
    private connectChallengeTimer: NodeJS.Timeout | undefined = undefined;
    private backoffMs = 1000;
    private tickTimer: NodeJS.Timeout | undefined = undefined;
    private tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
    private lastTickAt = 0;

    constructor(options: OpenClawGatewayClientOptions) {
        this.opts = {
            url: "ws://127.0.0.1:18789",
            requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            clientName: "gateway-client",
            clientVersion: "1.0.0",
            mode: "backend",
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.admin"],
            caps: [],
            platform: process.platform,
            ...options,
        };
    }

    private armConnectChallengeTimeout(): void {
        this.clearConnectChallengeTimeout();
        this.connectChallengeTimer = setTimeout(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            this.opts.onConnectError?.(new Error("gateway connect challenge timeout"));
            this.ws.close(1008, "connect challenge timeout");
        }, DEFAULT_CONNECT_CHALLENGE_TIMEOUT_MS);
    }

    private clearConnectChallengeTimeout(): void {
        if (!this.connectChallengeTimer) {
            return;
        }

        clearTimeout(this.connectChallengeTimer);
        this.connectChallengeTimer = undefined;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.closed) {
            return;
        }
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.start();
        }, delay);
    }

    private startTickWatch(): void {
        this.stopTickWatch();
        // Keep the timer cadence fixed; Gateway policy only controls the clamped
        // silence threshold below, not how frequently this process wakes up.
        this.tickTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            const now = Date.now();
            const maxSilenceMs = this.tickIntervalMs * 3;
            if (this.lastTickAt && now - this.lastTickAt > maxSilenceMs) {
                this.opts.onConnectError?.(new Error("gateway tick timeout"));
                this.ws.close(1011, "tick timeout");
            }
        }, TICK_WATCH_POLL_INTERVAL_MS);
    }

    private stopTickWatch(): void {
        if (!this.tickTimer) {
            return;
        }

        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
    }

    private rejectAllPending(error: Error): void {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
            this.pending.delete(id);
        }
    }

    private handleMessage(raw: string): void {
        let parsed: unknown;

        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            console.error("[Gateway] Failed to parse message:", error);
            return;
        }

        if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { type?: string }).type === "event"
        ) {
            const eventMessage = parsed as GatewayEvent;

            if (eventMessage.event === "connect.challenge") {
                this.clearConnectChallengeTimeout();
                void this.respondToConnectChallenge(
                    eventMessage.payload as undefined | { nonce?: string }
                );
                return;
            }

            if (eventMessage.event === "tick") {
                this.lastTickAt = Date.now();
            }

            this.opts.onEvent?.(eventMessage);
            return;
        }

        if (
            typeof parsed !== "object" ||
            parsed === null ||
            !["response", "res"].includes((parsed as { type?: string }).type || "")
        ) {
            return;
        }

        const response = parsed as GatewayResponse;
        if (typeof response.id !== "string") {
            return;
        }

        const pending = this.pending.get(response.id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(response.id);

        const isSuccess =
            response.isOk === true ||
            ((response.isOk === null || response.isOk === undefined) &&
                response.ok === true);

        if (isSuccess) {
            const payload = response.payload;
            if (
                payload &&
                typeof payload === "object" &&
                ["hello-isOk", "hello-ok"].includes(
                    (payload as GatewayHelloOk).type || ""
                )
            ) {
                this.backoffMs = 1000;
                this.lastTickAt = Date.now();
                this.tickIntervalMs = sanitizeTimerDurationMs(
                    (payload as GatewayHelloOk).policy?.tickIntervalMs,
                    DEFAULT_TICK_INTERVAL_MS
                );
                this.startTickWatch();
                this.opts.onHelloOk?.(payload as GatewayHelloOk);
            }
            pending.resolve(payload);
            return;
        }

        const errorMessage =
            response.error?.message ||
            response.error?.code ||
            "Unknown gateway request error";
        pending.reject(new Error(errorMessage));
    }

    private async respondToConnectChallenge(challengePayload?: {
        nonce?: string;
    }): Promise<void> {
        try {
            await this.sendConnect(challengePayload);
        } catch (error) {
            this.handleSendConnectError(error);
        }
    }

    private handleSendConnectError(error: unknown): void {
        console.error("[Gateway] Failed to send connect response:", error);
        const normalizedError = asError(error);
        this.opts.onConnectError?.(normalizedError);
        this.ws?.close(1008, normalizedError.message);
    }

    private async sendConnect(challengePayload?: { nonce?: string }): Promise<void> {
        const nonce = challengePayload?.nonce;
        if (!nonce || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.opts.onConnectError?.(
                new Error("gateway connect challenge missing nonce")
            );
            this.ws?.close(1008, "connect challenge missing nonce");
            return;
        }

        const signedAtMs = Date.now();
        const role = this.opts.role || "operator";
        const scopes = this.opts.scopes || ["operator.admin"];
        const clientName = this.opts.clientName || "gateway-client";
        const mode = this.opts.mode || "backend";
        const platform = this.opts.platform || process.platform;
        const token = this.opts.token?.trim() || undefined;

        const device = this.opts.deviceIdentity
            ? (() => {
                  const payload = buildDeviceAuthPayloadV3({
                      deviceId: this.opts.deviceIdentity.deviceId,
                      clientId: clientName,
                      clientMode: mode,
                      role,
                      scopes,
                      signedAtMs,
                      token: token || undefined,
                      nonce,
                      platform,
                      deviceFamily: this.opts.deviceFamily,
                  });

                  return {
                      id: this.opts.deviceIdentity.deviceId,
                      publicKey: publicKeyRawBase64UrlFromPem(
                          this.opts.deviceIdentity.publicKeyPem
                      ),
                      signature: signDevicePayload(
                          this.opts.deviceIdentity.privateKeyPem,
                          payload
                      ),
                      signedAt: signedAtMs,
                      nonce,
                  };
              })()
            : undefined;

        try {
            await this.request("connect", {
                minProtocol: 3,
                maxProtocol: 4,
                client: {
                    id: clientName,
                    displayName: this.opts.clientDisplayName,
                    version: this.opts.clientVersion || "1.0.0",
                    platform,
                    deviceFamily: this.opts.deviceFamily,
                    mode,
                },
                caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
                role,
                scopes,
                auth: token ? { token } : undefined,
                device,
            });
        } catch (error) {
            this.opts.onConnectError?.(
                error instanceof Error ? error : new Error(String(error))
            );
            this.ws?.close(1008, error instanceof Error ? error.message : String(error));
        }
    }

    start(): void {
        if (this.closed || this.ws) {
            return;
        }
        const trimmedUrl = (
            typeof this.opts.url === "string" ? this.opts.url : "ws://127.0.0.1:18789"
        ).trim();
        if (trimmedUrl === "") {
            throw new Error("Gateway URL must be a non-empty string");
        }
        const requestTimeoutMs =
            typeof this.opts.requestTimeoutMs === "number" &&
            Number.isFinite(this.opts.requestTimeoutMs) &&
            this.opts.requestTimeoutMs > 0
                ? Math.trunc(this.opts.requestTimeoutMs)
                : DEFAULT_REQUEST_TIMEOUT_MS;
        this.opts.requestTimeoutMs = Math.min(
            Math.max(requestTimeoutMs, 1),
            MAX_TIMER_DELAY_MS
        );
        const ws = new WebSocket(trimmedUrl);
        ws.binaryType = "arraybuffer";
        this.ws = ws;

        ws.addEventListener("open", () => {
            this.armConnectChallengeTimeout();
        });

        ws.addEventListener("message", async (event) => {
            try {
                this.handleMessage(await websocketMessageToString(event.data));
            } catch (error) {
                const normalizedError =
                    error instanceof Error
                        ? error
                        : new Error(`gateway message error: ${String(error)}`);
                this.opts.onConnectError?.(normalizedError);
                this.rejectAllPending(normalizedError);
                ws.close(1011, "gateway message error");
            }
        });

        ws.addEventListener("close", (event) => {
            const reason = event.reason;
            if (this.ws === ws) {
                this.ws = undefined;
            }
            this.clearConnectChallengeTimeout();
            this.stopTickWatch();
            this.rejectAllPending(new Error(`gateway closed (${event.code}): ${reason}`));
            this.opts.onClose?.(event.code, reason);
            if (!this.closed) {
                this.scheduleReconnect();
            }
        });

        ws.addEventListener("error", (event) => {
            const details =
                "message" in event && typeof event.message === "string"
                    ? `: ${event.message}`
                    : "";
            this.opts.onConnectError?.(
                new Error(`gateway websocket error (${event.type})${details}`)
            );
        });
    }

    stop(): void {
        this.closed = true;
        this.clearConnectChallengeTimeout();
        this.stopTickWatch();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
        this.rejectAllPending(new Error("gateway client stopped"));
    }

    request(method: string, parameters: unknown = {}): Promise<unknown> {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Gateway not connected"));
        }
        if (this.pending.size >= OpenClawGatewayClient.MAX_PENDING_REQUESTS) {
            return Promise.reject(new Error("Too many pending gateway requests"));
        }

        const id = String(++this.requestId);
        const frame = {
            type: "req",
            id,
            method,
            params: parameters,
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Gateway request timed out: ${method}`));
            }, this.opts.requestTimeoutMs as number);

            this.pending.set(id, { resolve, reject, timeout });
            try {
                ws.send(JSON.stringify(frame));
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timeout);
                reject(error);
            }
        });
    }
}
