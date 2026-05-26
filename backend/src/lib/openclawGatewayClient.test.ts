import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import {
    __testing,
    type GatewayEvent,
    loadOrCreateDeviceIdentity,
    OpenClawGatewayClient,
} from "./openclawGatewayClient.js";

describe("OpenClaw gateway client identity", () => {
    let tempDir: string;
    let identityPath: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-identity-"));
        identityPath = path.join(tempDir, ".openclaw", "identity", "device.json");
    });

    after(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it("creates a durable v1 Ed25519 device identity", async () => {
        const identity = loadOrCreateDeviceIdentity(identityPath);
        const saved = JSON.parse(await readFile(identityPath, "utf8")) as Record<
            string,
            unknown
        >;

        assert.equal(saved.version, 1);
        assert.equal(saved.deviceId, identity.deviceId);
        assert.match(identity.deviceId, /^[a-f0-9]{64}$/u);
        assert.match(identity.publicKeyPem, /BEGIN PUBLIC KEY/u);
        assert.match(identity.privateKeyPem, /BEGIN PRIVATE KEY/u);
    });

    it("reloads existing identities and repairs mismatched device ids", async () => {
        const original = loadOrCreateDeviceIdentity(identityPath);
        await writeFile(
            identityPath,
            `${JSON.stringify({ version: 1, ...original, deviceId: "stale" }, null, 2)}\n`,
            "utf8"
        );

        const repaired = loadOrCreateDeviceIdentity(identityPath);
        const saved = JSON.parse(await readFile(identityPath, "utf8")) as Record<
            string,
            unknown
        >;

        assert.equal(repaired.deviceId, original.deviceId);
        assert.equal(saved.deviceId, original.deviceId);
        assert.equal(repaired.publicKeyPem, original.publicKeyPem);
        assert.equal(repaired.privateKeyPem, original.privateKeyPem);
    });

    it("replaces malformed identity files", async () => {
        await writeFile(identityPath, JSON.stringify({ version: 1, deviceId: "broken" }));

        const identity = loadOrCreateDeviceIdentity(identityPath);

        assert.match(identity.deviceId, /^[a-f0-9]{64}$/u);
        assert.notEqual(identity.deviceId, "broken");
    });

    it("throws unexpected identity read errors", async () => {
        await assert.rejects(
            async () => loadOrCreateDeviceIdentity(tempDir),
            /EISDIR|illegal operation|is a directory/u
        );
    });
});

describe("OpenClaw gateway client helpers", () => {
    it("normalizes timer policy and device auth metadata", () => {
        assert.equal(__testing.sanitizeTimerDurationMs("bad", 12_345), 12_345);
        assert.equal(
            __testing.sanitizeTimerDurationMs(Number.POSITIVE_INFINITY, 12_345),
            12_345
        );
        assert.equal(__testing.sanitizeTimerDurationMs(10, 12_345), 1_000);
        assert.equal(__testing.sanitizeTimerDurationMs(1_000_000, 12_345), 300_000);
        assert.equal(__testing.sanitizeTimerDurationMs(1_234.9, 12_345), 1_234);
        assert.equal(__testing.normalizeDeviceMetadataForAuth(), "");
        assert.equal(
            __testing.normalizeDeviceMetadataForAuth("  NodeJS  "),
            "nodejS".toLowerCase()
        );
        assert.equal(__testing.normalizeDeviceMetadataForAuth("   "), "");
        assert.equal(__testing.asError("plain").message, "plain");
        const existingError = new Error("existing");
        assert.equal(__testing.asError(existingError), existingError);
        assert.equal(
            __testing.buildDeviceAuthPayloadV3({
                deviceId: "device",
                clientId: "client",
                clientMode: "backend",
                role: "operator",
                scopes: ["a", "b"],
                signedAtMs: 123,
                token: null,
                nonce: "nonce",
                platform: "NodeJS",
                deviceFamily: "SERVER",
            }),
            "v3|device|client|backend|operator|a,b|123||nonce|nodejs|server"
        );
        assert.deepEqual(
            __testing.derivePublicKeyRaw(
                "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAu8SjpMXuZYqql0MPcqzp1wfPqEdKD6LbsYBVlLT9A7w=\n-----END PUBLIC KEY-----\n"
            ),
            Buffer.from(
                "bbc4a3a4c5ee658aaa97430f72ace9d707cfa8474a0fa2dbb1805594b4fd03bc",
                "hex"
            )
        );
        const rsaPublicKey = crypto
            .generateKeyPairSync("rsa", { modulusLength: 1024 })
            .publicKey.export({ type: "spki", format: "pem" })
            .toString();
        assert.equal(__testing.derivePublicKeyRaw(rsaPublicKey).length > 32, true);
    });
});

function waitFor<T>(predicate: () => T | undefined, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            const value = predicate();
            if (value) {
                clearInterval(timer);
                resolve(value);
                return;
            }
            if (Date.now() - started > 2_000) {
                clearInterval(timer);
                reject(new Error(`Timed out waiting for ${label}`));
            }
        }, 10);
    });
}

async function startGatewayServer(
    onConnection: (socket: WebSocket) => void
): Promise<{ url: string; close: () => Promise<void> }> {
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", onConnection);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        url: `ws://127.0.0.1:${address.port}`,
        close: () =>
            new Promise((resolve) => {
                for (const client of server.clients) {
                    client.close();
                }
                server.close(() => resolve());
            }),
    };
}

describe("OpenClaw gateway client websocket protocol", () => {
    it("responds to connect challenges with token, client, caps, and signed device auth", async () => {
        let connectFrame: Record<string, unknown> | undefined;
        const identityFile = path.join(
            await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-client-ws-")),
            "device.json"
        );
        const identity = loadOrCreateDeviceIdentity(identityFile);
        const server = await startGatewayServer((socket) => {
            socket.send(
                JSON.stringify({
                    type: "event",
                    event: "connect.challenge",
                    payload: { nonce: "nonce-1" },
                })
            );
            socket.on("message", (raw) => {
                connectFrame = JSON.parse(raw.toString()) as Record<string, unknown>;
                socket.send(
                    JSON.stringify({
                        type: "res",
                        id: connectFrame.id,
                        ok: true,
                        payload: { type: "hello-ok", policy: { tickIntervalMs: 1000 } },
                    })
                );
            });
        });
        const helloPayloads: unknown[] = [];
        const client = new OpenClawGatewayClient({
            url: server.url,
            token: " gateway-token ",
            clientName: "dashboard-test",
            clientDisplayName: "Dashboard Test",
            clientVersion: "9.9.9",
            role: "operator",
            scopes: ["operator.read"],
            caps: ["tool-events"],
            platform: "NodeJS",
            deviceFamily: "SERVER",
            deviceIdentity: identity,
            onHelloOk: (payload) => helloPayloads.push(payload),
        });

        try {
            client.start();
            const frame = await waitFor(() => connectFrame, "connect frame");
            await waitFor(() => helloPayloads[0], "hello-ok callback");

            assert.equal(frame.type, "req");
            assert.equal(frame.method, "connect");
            const params = frame.params as Record<string, unknown>;
            assert.equal(params.minProtocol, 3);
            assert.equal(params.maxProtocol, 4);
            assert.deepEqual(params.auth, { token: "gateway-token" });
            assert.deepEqual(params.caps, ["tool-events"]);
            assert.deepEqual(params.scopes, ["operator.read"]);
            assert.equal((params.client as Record<string, unknown>).id, "dashboard-test");
            assert.equal(
                (params.client as Record<string, unknown>).displayName,
                "Dashboard Test"
            );
            assert.equal((params.client as Record<string, unknown>).platform, "NodeJS");
            const device = params.device as Record<string, unknown>;
            assert.equal(device.id, identity.deviceId);
            assert.equal(device.nonce, "nonce-1");
            assert.equal(typeof device.publicKey, "string");
            assert.equal(typeof device.signature, "string");
        } finally {
            client.stop();
            await server.close();
        }
    });

    it("resolves, rejects, and times out gateway requests deterministically", async () => {
        let socketRef: WebSocket | undefined;
        const sentFrames: Array<Record<string, unknown>> = [];
        const server = await startGatewayServer((socket) => {
            socketRef = socket;
            socket.on("message", (raw) => {
                const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
                sentFrames.push(frame);
                if (frame.method === "ok.method") {
                    socket.send(
                        JSON.stringify({
                            type: "res",
                            id: frame.id,
                            ok: true,
                            payload: { value: 42 },
                        })
                    );
                }
                if (frame.method === "bad.method") {
                    socket.send(
                        JSON.stringify({
                            type: "res",
                            id: frame.id,
                            ok: false,
                            error: { code: "BAD" },
                        })
                    );
                }
            });
        });
        const events: GatewayEvent[] = [];
        const disconnectedClient = new OpenClawGatewayClient({ url: server.url });
        await assert.rejects(
            disconnectedClient.request("too.early"),
            /Gateway not connected/u
        );

        const client = new OpenClawGatewayClient({
            url: server.url,
            requestTimeoutMs: 50,
            onEvent: (event) => events.push(event),
        });

        try {
            client.start();
            await waitFor(() => socketRef, "gateway socket");
            socketRef?.send(
                JSON.stringify({ type: "event", event: "tick", payload: { ok: true } })
            );
            socketRef?.send(
                JSON.stringify({
                    type: "event",
                    event: "connect.challenge",
                    payload: { nonce: "n" },
                })
            );
            const connect = await waitFor(
                () => sentFrames.find((frame) => frame.method === "connect"),
                "connect request"
            );
            socketRef?.send(
                JSON.stringify({
                    type: "res",
                    id: connect.id,
                    ok: true,
                    payload: { type: "hello-ok", policy: { tickIntervalMs: 1000 } },
                })
            );

            assert.deepEqual(await client.request("ok.method", { a: 1 }), { value: 42 });
            await assert.rejects(client.request("bad.method"), /BAD/u);
            await assert.rejects(
                client.request("slow.method"),
                /timed out: slow\.method/u
            );
            assert.equal(
                events.some((event) => event.event === "tick"),
                true
            );
        } finally {
            client.stop();
            await server.close();
        }
    });

    it("clamps gateway tick thresholds without using them as timer cadence", async () => {
        let connectFrame: Record<string, unknown> | undefined;
        const server = await startGatewayServer((socket) => {
            socket.on("message", (raw) => {
                connectFrame = JSON.parse(raw.toString()) as Record<string, unknown>;
                socket.send(
                    JSON.stringify({
                        type: "res",
                        id: connectFrame.id,
                        ok: true,
                        payload: {
                            type: "hello-ok",
                            policy: { tickIntervalMs: 1_000_000 },
                        },
                    })
                );
            });
            socket.send(
                JSON.stringify({
                    type: "event",
                    event: "connect.challenge",
                    payload: { nonce: "nonce-1" },
                })
            );
        });
        const client = new OpenClawGatewayClient({ url: server.url });

        try {
            client.start();
            await waitFor(() => connectFrame, "connect frame");
            const state = await waitFor(() => {
                const gatewayClient = client as unknown as {
                    tickIntervalMs: number;
                    tickTimer: { _idleTimeout?: number } | null;
                };
                return gatewayClient.tickIntervalMs === 300_000 && gatewayClient.tickTimer
                    ? gatewayClient
                    : undefined;
            }, "clamped tick interval");

            assert.equal(state.tickTimer?._idleTimeout, 1000);
        } finally {
            client.stop();
            await server.close();
        }
    });

    it("reports malformed server messages and missing connect nonces without crashing", async () => {
        let socketRef: WebSocket | undefined;
        const errors: string[] = [];
        const server = await startGatewayServer((socket) => {
            socketRef = socket;
        });
        const client = new OpenClawGatewayClient({
            url: server.url,
            requestTimeoutMs: 50,
            onConnectError: (error) => errors.push(error.message),
        });

        try {
            client.start();
            await waitFor(() => socketRef, "gateway socket");
            socketRef?.send("not json");
            socketRef?.send(
                JSON.stringify({ type: "event", event: "connect.challenge", payload: {} })
            );
            await waitFor(
                () => errors.find((message) => message.includes("missing nonce")),
                "missing nonce error"
            );
        } finally {
            client.stop();
            await server.close();
        }
    });

    it("handles socket close and connection errors through lifecycle callbacks", async () => {
        let socketRef: WebSocket | undefined;
        const closed: Array<{ code: number; reason: string }> = [];
        const errors: string[] = [];
        const server = await startGatewayServer((socket) => {
            socketRef = socket;
        });
        const client = new OpenClawGatewayClient({
            url: server.url,
            onClose: (code, reason) => closed.push({ code, reason }),
            onConnectError: (error) => errors.push(error.message),
        });

        try {
            client.start();
            await waitFor(() => socketRef, "gateway socket");
            socketRef?.close(1001, "bye");
            await waitFor(() => closed[0], "close callback");
            assert.deepEqual(closed[0], { code: 1001, reason: "bye" });
        } finally {
            client.stop();
            await server.close();
        }

        const failing = new OpenClawGatewayClient({
            url: "ws://127.0.0.1:1",
            onConnectError: (error) => errors.push(error.message),
        });
        try {
            failing.start();
            await waitFor(() => errors.at(-1), "connect error");
            assert.equal(typeof errors.at(-1), "string");
        } finally {
            failing.stop();
        }
    });

    it("covers direct protocol edge cases without relying on network timing", async () => {
        const events: GatewayEvent[] = [];
        const errors: string[] = [];
        const client = new OpenClawGatewayClient({
            onConnectError: (error) => errors.push(error.message),
            onEvent: (event) => events.push(event),
        });
        const internals = client as unknown as {
            handleMessage: (raw: string) => void;
            pending: Map<
                string,
                {
                    timeout: NodeJS.Timeout;
                    resolve: (value: unknown) => void;
                    reject: (error: Error) => void;
                    method: string;
                }
            >;
            rejectAllPending: (error: Error) => void;
            scheduleReconnect: () => void;
            sendConnect: (payload?: { nonce?: string }) => void;
            startTickWatch: () => void;
            stopTickWatch: () => void;
            armConnectChallengeTimeout: () => void;
            backoffMs: number;
            connectChallengeTimer: NodeJS.Timeout | null;
            ws: {
                close: (code?: number, reason?: string) => void;
                readyState: number;
                send: (data: string) => void;
            } | null;
            closed: boolean;
            reconnectTimer: NodeJS.Timeout | null;
            tickIntervalMs: number;
            lastTickAt: number;
            requestId: number;
            opts: {
                onConnectError?: (error: Error) => void;
                requestTimeoutMs?: number;
                deviceIdentity?: {
                    deviceId: string;
                    publicKeyPem: string;
                    privateKeyPem: string;
                };
                token?: string;
            };
        };

        internals.handleMessage(JSON.stringify({ type: "noop" }));
        internals.handleMessage(JSON.stringify({ type: "res" }));
        internals.handleMessage(JSON.stringify({ type: "res", id: "missing" }));
        internals.handleMessage(
            JSON.stringify({
                type: "res",
                id: "missing-ok",
                ok: true,
                payload: { type: "hello-ok", policy: { tickIntervalMs: "bad" } },
            })
        );
        internals.handleMessage(
            JSON.stringify({ type: "event", event: "custom", payload: { ok: true } })
        );
        assert.equal(events.at(-1)?.event, "custom");

        await new Promise((resolve) => {
            internals.pending.set("hello-bad-policy", {
                timeout: setTimeout(() => {}, 1000),
                method: "connect",
                resolve,
                reject: () => {},
            });
            internals.handleMessage(
                JSON.stringify({
                    type: "res",
                    id: "hello-bad-policy",
                    ok: true,
                    payload: { type: "hello-ok", policy: { tickIntervalMs: "bad" } },
                })
            );
        });
        assert.equal(internals.tickIntervalMs, 30_000);

        await assert.rejects(
            new Promise((_resolve, reject) => {
                internals.pending.set("bad", {
                    timeout: setTimeout(() => {}, 1000),
                    method: "bad",
                    resolve: () => {},
                    reject,
                });
                internals.handleMessage(
                    JSON.stringify({
                        type: "res",
                        id: "bad",
                        ok: false,
                        error: { message: "explicit failure" },
                    })
                );
            }),
            /explicit failure/u
        );

        await assert.rejects(
            new Promise((_resolve, reject) => {
                internals.pending.set("unknown-error", {
                    timeout: setTimeout(() => {}, 1000),
                    method: "unknown-error",
                    resolve: () => {},
                    reject,
                });
                internals.handleMessage(
                    JSON.stringify({
                        type: "res",
                        id: "unknown-error",
                        ok: false,
                        error: {},
                    })
                );
            }),
            /Unknown gateway request error/u
        );

        await assert.rejects(
            new Promise((_resolve, reject) => {
                internals.pending.set("pending", {
                    timeout: setTimeout(() => {}, 1000),
                    method: "pending",
                    resolve: () => {},
                    reject,
                });
                internals.rejectAllPending(new Error("closed"));
            }),
            /closed/u
        );

        internals.ws = { readyState: WebSocket.OPEN, send: () => {}, close: () => {} };
        for (let i = 0; i < 1000; i++) {
            internals.pending.set(`overflow-${i}`, {
                timeout: setTimeout(() => {}, 1000),
                method: "overflow",
                resolve: () => {},
                reject: () => {},
            });
        }
        await assert.rejects(client.request("overflow"), /Too many pending/u);
        for (const pending of internals.pending.values()) {
            clearTimeout(pending.timeout);
        }
        internals.pending.clear();

        const closedFrames: Array<{ code?: number; reason?: string }> = [];
        internals.ws = {
            readyState: WebSocket.OPEN,
            send: () => {
                throw new Error("send failed");
            },
            close: (code?: number, reason?: string) =>
                closedFrames.push({ code, reason }),
        };
        await assert.rejects(client.request("send.failure"), /send failed/u);

        internals.ws = {
            readyState: WebSocket.CLOSED,
            send: () => {},
            close: (code?: number, reason?: string) =>
                closedFrames.push({ code, reason }),
        };
        internals.sendConnect({ nonce: "nonce" });
        assert.equal(errors.at(-1), "gateway connect challenge missing nonce");

        internals.closed = false;
        internals.backoffMs = 1;
        internals.scheduleReconnect();
        assert.ok(internals.reconnectTimer);
        await waitFor(() => internals.reconnectTimer === null || undefined, "reconnect");
        internals.closed = false;
        internals.scheduleReconnect();
        assert.ok(internals.reconnectTimer);
        client.stop();
        assert.equal(internals.reconnectTimer, null);

        internals.ws = { readyState: WebSocket.OPEN, send: () => {}, close: () => {} };
        internals.tickIntervalMs = 1;
        internals.lastTickAt = Date.now() - 10_000;
        internals.startTickWatch();
        await waitFor(
            () => errors.find((message) => message === "gateway tick timeout"),
            "tick timeout"
        );
        internals.stopTickWatch();

        internals.ws = null;
        internals.startTickWatch();
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        internals.stopTickWatch();

        const challengeCloses: Array<{ code?: number; reason?: string }> = [];
        internals.ws = {
            readyState: WebSocket.OPEN,
            send: () => {},
            close: (code?: number, reason?: string) =>
                challengeCloses.push({ code, reason }),
        };
        internals.armConnectChallengeTimeout();
        assert.ok(internals.connectChallengeTimer);
        const challengeTimer = internals.connectChallengeTimer as unknown as {
            _onTimeout: () => void;
        };
        challengeTimer._onTimeout();
        assert.equal(errors.includes("gateway connect challenge timeout"), true);
        assert.deepEqual(challengeCloses.at(-1), {
            code: 1008,
            reason: "connect challenge timeout",
        });
        clearTimeout(internals.connectChallengeTimer as NodeJS.Timeout);
        internals.connectChallengeTimer = null;

        internals.ws = { readyState: WebSocket.CLOSED, send: () => {}, close: () => {} };
        internals.armConnectChallengeTimeout();
        const closedChallengeTimer = internals.connectChallengeTimer as unknown as {
            _onTimeout: () => void;
        };
        closedChallengeTimer._onTimeout();
        const timerToClear = internals.connectChallengeTimer;
        assert.ok(timerToClear);
        clearTimeout(timerToClear);
        internals.connectChallengeTimer = null;

        internals.closed = true;
        internals.scheduleReconnect();

        const blankUrlClient = new OpenClawGatewayClient({ url: "   " });
        assert.throws(
            () => blankUrlClient.start(),
            /Gateway URL must be a non-empty string/u
        );
        const fallbackStartClient = new OpenClawGatewayClient({
            url: undefined as unknown as string,
            requestTimeoutMs: Number.NaN,
        });
        const fallbackStartInternals = fallbackStartClient as unknown as {
            opts: { requestTimeoutMs?: number };
        };
        fallbackStartClient.start();
        assert.equal(fallbackStartInternals.opts.requestTimeoutMs, 30_000);
        fallbackStartClient.stop();

        client.start();
        internals.closed = true;
        client.start();

        const originalRequest = client.request;
        client.request = async () => {
            throw "connect failed";
        };
        internals.ws = {
            readyState: WebSocket.OPEN,
            send: () => {},
            close: (code?: number, reason?: string) =>
                closedFrames.push({ code, reason }),
        };
        internals.sendConnect({ nonce: "nonce-2" });
        await waitFor(
            () => errors.find((message) => message === "connect failed"),
            "non-error connect failure"
        );

        client.request = async () => {
            throw new Error("connect error");
        };
        internals.sendConnect({ nonce: "nonce-3" });
        await waitFor(
            () => errors.find((message) => message === "connect error"),
            "error connect failure"
        );
        client.request = originalRequest;

        const defaultConnectParams: unknown[] = [];
        internals.opts = { onConnectError: internals.opts.onConnectError } as never;
        client.request = async (_method: string, params?: unknown) => {
            defaultConnectParams.push(params);
            return {};
        };
        internals.ws = { readyState: WebSocket.OPEN, send: () => {}, close: () => {} };
        internals.sendConnect({ nonce: "nonce-defaults" });
        await waitFor(() => defaultConnectParams[0], "default connect params");
        const defaultParams = defaultConnectParams[0] as Record<string, unknown>;
        assert.equal(defaultParams.role, "operator");
        assert.deepEqual(defaultParams.scopes, ["operator.admin"]);
        assert.deepEqual(defaultParams.caps, []);
        assert.equal(
            (defaultParams.client as Record<string, unknown>).id,
            "gateway-client"
        );
        assert.equal((defaultParams.client as Record<string, unknown>).version, "1.0.0");
        assert.equal((defaultParams.client as Record<string, unknown>).mode, "backend");
        assert.equal(
            (defaultParams.client as Record<string, unknown>).platform,
            process.platform
        );

        const identityFile = path.join(
            await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-default-device-")),
            "device.json"
        );
        internals.opts.deviceIdentity = loadOrCreateDeviceIdentity(identityFile);
        internals.opts.token = "   ";
        internals.sendConnect({ nonce: "nonce-token-null" });
        await waitFor(() => defaultConnectParams[1], "device connect params");
        const deviceParams = defaultConnectParams[1] as Record<string, unknown>;
        assert.equal(deviceParams.auth, undefined);
        assert.equal(typeof deviceParams.device, "object");
        client.request = originalRequest;
    });
});
