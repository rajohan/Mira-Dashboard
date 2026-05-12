import crypto from "node:crypto";
import fs from "node:fs";
import Path from "node:path";

import WebSocket from "ws";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_CONNECT_CHALLENGE_TIMEOUT_MS = 10_000;

export type DeviceIdentity = {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
};

export type GatewayHelloOk = {
    type?: string;
    protocol?: number;
    policy?: {
        tickIntervalMs?: number;
    };
};

export type GatewayEvent = {
    type?: string;
    event?: string;
    payload?: unknown;
    seq?: number;
    stateVersion?: number;
};

type GatewayResponse = {
    type?: string;
    id?: string;
    ok?: boolean;
    payload?: unknown;
    error?: {
        code?: string;
        message?: string;
        details?: unknown;
    };
};

type PendingRequestEntry = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
};

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
    onEvent?: (evt: GatewayEvent) => void;
    onConnectError?: (err: Error) => void;
    onClose?: (code: number, reason: string) => void;
};

export type OpenClawGatewayClientInstance = {
    start: () => void;
    stop: () => void;
    request: (method: string, params?: unknown) => Promise<unknown>;
};

function base64UrlEncode(buffer: Buffer): string {
    return buffer
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
    const spki = crypto.createPublicKey(publicKeyPem).export({
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

function fingerprintPublicKey(publicKeyPem: string): string {
    return crypto
        .createHash("sha256")
        .update(derivePublicKeyRaw(publicKeyPem))
        .digest("hex");
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
    return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
    const key = crypto.createPrivateKey(privateKeyPem);
    return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function generateIdentity(): DeviceIdentity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    return {
        deviceId: fingerprintPublicKey(publicKeyPem),
        publicKeyPem,
        privateKeyPem,
    };
}

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
                `${JSON.stringify({ version: 1, ...identity }, null, 2)}\n`,
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
        `${JSON.stringify({ version: 1, ...identity }, null, 2)}\n`,
        {
            mode: 0o600,
        }
    );
    return identity;
}

function normalizeDeviceMetadataForAuth(value?: string): string {
    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();
    return trimmed ? trimmed.replaceAll(/[A-Z]/gu, (char) => char.toLowerCase()) : "";
}

function buildDeviceAuthPayloadV3(params: {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | null;
    nonce: string;
    platform?: string;
    deviceFamily?: string;
}): string {
    return [
        "v3",
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        params.scopes.join(","),
        String(params.signedAtMs),
        params.token ?? "",
        params.nonce,
        normalizeDeviceMetadataForAuth(params.platform),
        normalizeDeviceMetadataForAuth(params.deviceFamily),
    ].join("|");
}

export class OpenClawGatewayClient implements OpenClawGatewayClientInstance {
    private readonly opts: OpenClawGatewayClientOptions;
    private ws: WebSocket | null = null;
    private requestId = 0;
    private readonly pending = new Map<string, PendingRequestEntry>();
    private static readonly MAX_PENDING_REQUESTS = 1000;
    private closed = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private connectChallengeTimer: NodeJS.Timeout | null = null;
    private backoffMs = 1_000;
    private tickTimer: NodeJS.Timeout | null = null;
    private tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
    private lastTickAt = 0;

    constructor(opts: OpenClawGatewayClientOptions) {
        this.opts = {
            requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            clientName: "gateway-client",
            clientVersion: "1.0.0",
            mode: "backend",
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.admin"],
            caps: [],
            platform: process.platform,
            ...opts,
        };
    }

    start(): void {
        if (this.closed || this.ws) {
            return;
        }

        const url = this.opts.url || "ws://127.0.0.1:18789";
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.on("open", () => {
            this.armConnectChallengeTimeout();
        });

        ws.on("message", (raw) => {
            this.handleMessage(raw.toString());
        });

        ws.on("close", (code, reasonBuffer) => {
            const reason = reasonBuffer.toString();
            if (this.ws === ws) {
                this.ws = null;
            }
            this.clearConnectChallengeTimeout();
            this.stopTickWatch();
            this.rejectAllPending(new Error(`gateway closed (${code}): ${reason}`));
            this.opts.onClose?.(code, reason);
            if (!this.closed) {
                this.scheduleReconnect();
            }
        });

        ws.on("error", (error) => {
            this.opts.onConnectError?.(
                error instanceof Error ? error : new Error(String(error))
            );
        });
    }

    stop(): void {
        this.closed = true;
        this.clearConnectChallengeTimeout();
        this.stopTickWatch();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.rejectAllPending(new Error("gateway client stopped"));
    }

    request(method: string, params: unknown = {}): Promise<unknown> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
            params,
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Gateway request timed out: ${method}`));
            }, this.opts.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);

            this.pending.set(id, { resolve, reject, timeout });
            this.ws?.send(JSON.stringify(frame));
        });
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
        if (this.connectChallengeTimer) {
            clearTimeout(this.connectChallengeTimer);
            this.connectChallengeTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.closed) {
            return;
        }

        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.start();
        }, delay);
    }

    private startTickWatch(): void {
        this.stopTickWatch();
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
        }, this.tickIntervalMs);
    }

    private stopTickWatch(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
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
                this.sendConnect(eventMessage.payload as { nonce?: string } | undefined);
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
            (parsed as { type?: string }).type !== "res"
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

        if (response.ok) {
            const payload = response.payload;
            if (
                payload &&
                typeof payload === "object" &&
                (payload as GatewayHelloOk).type === "hello-ok"
            ) {
                this.backoffMs = 1_000;
                this.lastTickAt = Date.now();
                this.tickIntervalMs =
                    (payload as GatewayHelloOk).policy?.tickIntervalMs ||
                    DEFAULT_TICK_INTERVAL_MS;
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

    private sendConnect(challengePayload?: { nonce?: string }): void {
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
                      token: token || null,
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

        void this.request("connect", {
            minProtocol: 3,
            maxProtocol: 3,
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
        }).catch((error) => {
            this.opts.onConnectError?.(
                error instanceof Error ? error : new Error(String(error))
            );
            this.ws?.close(1008, error instanceof Error ? error.message : String(error));
        });
    }
}
