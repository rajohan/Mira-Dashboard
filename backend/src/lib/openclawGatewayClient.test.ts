import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { type WebSocket, WebSocketServer } from "ws";

import {
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
            assert.equal(params.minProtocol, 4);
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
});
