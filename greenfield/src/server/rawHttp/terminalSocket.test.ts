import { describe, expect, test } from "bun:test";

import type { Server, WebSocketHandler } from "bun";

import type { AuthenticatedPrincipal } from "../../contracts/security.ts";
import {
    terminalBinaryOutputHeaderBytes,
    terminalBinaryOutputKind,
    terminalClientMessageMaximumBytes,
    terminalServerMessageMaximumBytes,
    terminalSocketBufferedMaximumBytes,
    terminalWebSocketProtocol,
} from "../../contracts/terminal.ts";
import type { AuthenticationLifecycleService } from "../domains/security/authenticationLifecycle.ts";
import type { AuthenticationResolution } from "../domains/security/authenticationResolution.ts";
import { TerminalSessionBrokerError } from "../domains/terminal/brokerPort.ts";
import type {
    InteractiveTerminalBrokerClient,
    TerminalBrokerRelay,
    TerminalBrokerRelayCallbacks,
} from "../platform/terminal/terminalBrokerClient.ts";
import {
    createTerminalSocketBoundary,
    type TerminalSocketConnection,
    type TerminalSocketUpgradeServer,
} from "./terminalSocket.ts";

const sessionId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const userId = "019fc968-1a9b-7771-8f1b-d5b863b0e7b4";
const sessionSelector = "c".repeat(32);
const sessionToken = `${sessionSelector}.${"d".repeat(64)}`;
const connectionToken = `${"a".repeat(32)}.${"b".repeat(64)}`;
const nowMs = 1_000_000;

const principal = Object.freeze({
    authenticatorId: sessionSelector,
    authorizationVersion: 1,
    capabilities: Object.freeze(["terminal:write" as const]),
    id: userId,
    kind: "session" as const,
});

const session = Object.freeze({
    dimensions: { columns: 100, rows: 30 },
    expiresAtMs: nowMs + 60_000,
    idleExpiresAtMs: nowMs + 30_000,
    location: { path: "/", rootId: "dashboard" },
    nextSequence: 2,
    replayAvailableFromSequence: 1,
    sessionId,
    startedAtMs: nowMs,
    state: "connected" as const,
});

function authenticationLifecycle(
    authorization:
        | "authorized"
        | "session-changed"
        | "step-up-required"
        | (() => "authorized" | "session-changed" | "step-up-required") = "authorized"
): AuthenticationLifecycleService {
    return {
        authorizeRecentMfa: () =>
            typeof authorization === "function" ? authorization() : authorization,
    } as unknown as AuthenticationLifecycleService;
}

interface RelayFixture {
    readonly calls: string[];
    readonly relay: TerminalBrokerRelay;
}

function relayFixture(
    inputDispositions: readonly ("accepted" | "backpressured" | "closed")[] = []
): RelayFixture {
    const calls: string[] = [];
    const pendingInputDispositions = [...inputDispositions];
    const relay: TerminalBrokerRelay = {
        detach() {
            calls.push("detach");
        },
        input(data) {
            calls.push(`input:${data.toHex()}`);
            return pendingInputDispositions.shift() ?? "accepted";
        },
        ping() {
            calls.push("ping");
            return "accepted";
        },
        resize(dimensions) {
            calls.push(`resize:${dimensions.columns}x${dimensions.rows}`);
            return "accepted";
        },
        resumeOutput() {
            calls.push("resume-output");
        },
        signal(signal) {
            calls.push(`signal:${signal}`);
            return "accepted";
        },
        terminate() {
            calls.push("terminate");
        },
    };
    return { calls, relay: Object.freeze(relay) };
}

interface BrokerFixture {
    readonly attachCalls: Array<{
        readonly connectionToken: string;
        readonly owner: { readonly authenticatorId: string; readonly id: string };
        readonly sessionId: string;
    }>;
    callbacks?: TerminalBrokerRelayCallbacks;
    broker: InteractiveTerminalBrokerClient;
}

function brokerFixture(
    relay: TerminalBrokerRelay,
    failure?: TerminalSessionBrokerError
): BrokerFixture {
    const fixture: BrokerFixture = {
        attachCalls: [],
        broker: undefined as unknown as InteractiveTerminalBrokerClient,
    };
    const broker: InteractiveTerminalBrokerClient = {
        async attach(input) {
            await Promise.resolve();
            fixture.attachCalls.push({
                connectionToken: input.connectionToken,
                owner: input.owner,
                sessionId: input.sessionId,
            });
            if (failure !== undefined) throw failure;
            fixture.callbacks = input.callbacks;
            input.callbacks.onControl({
                replayAvailableFromSequence: 1,
                resumed: false,
                session,
                type: "ready",
            });
            input.callbacks.onOutput(1, Uint8Array.from([27, 91, 109]));
            return relay;
        },
        getActive: () => Promise.resolve(undefined),
        prepareResume: () => Promise.reject(new Error("unused")),
        reserve: () => Promise.reject(new Error("unused")),
        terminate: () => Promise.reject(new Error("unused")),
    };
    fixture.broker = Object.freeze(broker);
    return fixture;
}

interface AuthenticationResolutionFixtureOptions {
    readonly expiresAtMs?: number;
    readonly principal?: AuthenticatedPrincipal;
    readonly revalidate?: (signal: AbortSignal) => Promise<unknown>;
}

function authenticatedResolution(
    options: AuthenticationResolutionFixtureOptions = {}
): AuthenticationResolution {
    const authenticatedPrincipal = options.principal ?? principal;
    return {
        authentication: {
            kind: "authenticated" as const,
            principal: authenticatedPrincipal,
        },
        lease: {
            expiresAtMs: options.expiresAtMs ?? nowMs + 10_000,
            revalidate:
                options.revalidate ??
                (() =>
                    Promise.resolve(
                        authenticatedResolution({ principal: authenticatedPrincipal })
                    )),
        },
    };
}

function request(
    overrides: {
        readonly headers?: Readonly<Record<string, string | undefined>>;
        readonly method?: string;
        readonly path?: string;
    } = {}
): Request {
    const headers = new Headers({
        connection: "keep-alive, Upgrade",
        cookie: `__Host-mira_dashboard_session=${sessionToken}`,
        origin: "https://dashboard.test",
        "sec-fetch-site": "same-origin",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": `${terminalWebSocketProtocol}, ${connectionToken}`,
        "sec-websocket-version": "13",
        upgrade: "websocket",
    });
    for (const [name, value] of Object.entries(overrides.headers ?? {})) {
        if (value === undefined) headers.delete(name);
        else headers.set(name, value);
    }
    return new Request(
        `https://dashboard.test${overrides.path ?? `/api/terminal/sessions/${sessionId}/socket`}`,
        { headers, method: overrides.method ?? "GET" }
    );
}

interface UpgradeFixture extends TerminalSocketUpgradeServer {
    data?: TerminalSocketConnection;
    headers?: Headers;
}

function upgradeFixture(accept = true): UpgradeFixture {
    const fixture: UpgradeFixture = {
        upgrade(_request, options) {
            fixture.data = options.data;
            fixture.headers = new Headers(options.headers);
            return accept;
        },
    };
    return fixture;
}

function peerFixture(
    options: {
        readonly binaryStatuses?: readonly number[];
        readonly textStatuses?: readonly number[];
    } = {}
) {
    const binary: Uint8Array[] = [];
    const binaryStatuses = [...(options.binaryStatuses ?? [])];
    const closed: Array<{ readonly code?: number; readonly reason?: string }> = [];
    const text: string[] = [];
    const textStatuses = [...(options.textStatuses ?? [])];
    return {
        binary,
        closed,
        peer: {
            close(code?: number, reason?: string) {
                closed.push({ code, reason });
            },
            sendBinary(data: Uint8Array) {
                binary.push(new Uint8Array(data));
                return binaryStatuses.shift() ?? data.byteLength;
            },
            sendText(data: string) {
                text.push(data);
                return textStatuses.shift() ?? data.length;
            },
        },
        text,
    };
}

function terminalUrl(path = `/api/terminal/sessions/${sessionId}/socket`): URL {
    return new URL(`https://dashboard.test${path}`);
}

async function settleMicrotasks(): Promise<void> {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("terminal WebSocket raw boundary", () => {
    test("authenticates one ticket and relays sequenced PTY bytes and bounded controls", async () => {
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            browserOrigin: "https://dashboard.test",
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();

        expect(
            await boundary.handle(
                request(),
                new URL(
                    `https://dashboard.test/api/terminal/sessions/${sessionId}/socket`
                ),
                upgrade
            )
        ).toEqual({ kind: "upgraded" });
        expect(broker.attachCalls).toEqual([
            {
                connectionToken,
                owner: { authenticatorId: sessionSelector, id: userId },
                sessionId,
            },
        ]);
        expect(upgrade.headers?.get("sec-websocket-protocol")).toBe(
            terminalWebSocketProtocol
        );
        expect(upgrade.headers?.get("sec-websocket-protocol")).not.toContain(
            connectionToken
        );

        const peer = peerFixture();
        upgrade.data?.open(peer.peer);
        expect(JSON.parse(peer.text[0] ?? "null")).toMatchObject({
            session: { sessionId },
            type: "ready",
        });
        expect(peer.binary).toHaveLength(1);
        const output = peer.binary[0]!;
        expect(output[0]).toBe(terminalBinaryOutputKind);
        expect(new DataView(output.buffer).getBigUint64(1, false)).toBe(1n);
        expect(output.slice(terminalBinaryOutputHeaderBytes)).toEqual(
            Uint8Array.from([27, 91, 109])
        );

        upgrade.data?.message(Uint8Array.from([0x03]));
        upgrade.data?.message(
            JSON.stringify({ dimensions: { columns: 120, rows: 40 }, type: "resize" })
        );
        upgrade.data?.message(JSON.stringify({ signal: "SIGINT", type: "signal" }));
        upgrade.data?.message(JSON.stringify({ nonce: 7, type: "ping" }));
        expect(relay.calls).toEqual([
            "resume-output",
            "input:03",
            "resize:120x40",
            "signal:SIGINT",
            "ping",
        ]);
        expect(JSON.parse(peer.text.at(-1) ?? "null")).toEqual({
            nonce: 7,
            type: "pong",
        });

        broker.callbacks?.onControl({
            exitCode: 130,
            reason: "exited",
            signalCode: "SIGINT",
            type: "exit",
        });
        expect(JSON.parse(peer.text.at(-1) ?? "null")).toMatchObject({
            exitCode: 130,
            reason: "exited",
            sessionId,
            signal: "SIGINT",
            type: "exit",
        });
        expect(peer.closed).toEqual([{ code: 1000, reason: "Terminal ended" }]);
    });

    test("preserves text control frames and binary PTY input through the Bun adapter", async () => {
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        if (upgrade.data === undefined) throw new Error("Expected upgraded connection");
        const peer = peerFixture();
        const socket = Object.freeze({ data: upgrade.data, ...peer.peer });
        boundary.websocket.open(socket);

        boundary.websocket.message(
            socket,
            JSON.stringify({
                dimensions: { columns: 132, rows: 43 },
                type: "resize",
            })
        );
        const inputBuffer = Uint8Array.from([0, 255, 0]);
        boundary.websocket.message(socket, inputBuffer.subarray(1, 2));

        expect(relay.calls).toEqual(["resume-output", "resize:132x43", "input:ff"]);
        boundary.shutdown();
    });

    test("fails closed when the worker binds a different terminal session", async () => {
        const relay = relayFixture();
        const baseBroker = brokerFixture(relay.relay).broker;
        const broker: InteractiveTerminalBrokerClient = Object.freeze({
            ...baseBroker,
            attach(input: Parameters<InteractiveTerminalBrokerClient["attach"]>[0]) {
                input.callbacks.onControl({
                    replayAvailableFromSequence: 1,
                    resumed: false,
                    session: { ...session, sessionId: userId },
                    type: "ready",
                });
                return Promise.resolve(relay.relay);
            },
        });
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();

        const result = await boundary.handle(request(), terminalUrl(), upgrade);

        expect(result.kind).toBe("response");
        if (result.kind === "response") expect(result.response.status).toBe(503);
        expect(upgrade.data).toBeUndefined();
        expect(relay.calls).toContain("terminate");
    });

    test("rejects cross-origin, query-secret, and malformed upgrades before consuming a ticket", async () => {
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            browserOrigin: "https://dashboard.test",
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();

        const queryPath = `/api/terminal/sessions/${sessionId}/socket?token=${connectionToken}`;
        const cases = [
            {
                expectedStatus: 403,
                request: request({ headers: { origin: "https://attacker.test" } }),
                url: terminalUrl(),
            },
            {
                expectedStatus: 403,
                request: request({ headers: { "sec-fetch-site": "cross-site" } }),
                url: terminalUrl(),
            },
            {
                expectedStatus: 400,
                request: request({ path: queryPath }),
                url: terminalUrl(queryPath),
            },
            {
                expectedStatus: 400,
                request: request({
                    headers: {
                        "sec-websocket-protocol": `${connectionToken}, ${terminalWebSocketProtocol}`,
                    },
                }),
                url: terminalUrl(),
            },
            {
                expectedStatus: 400,
                request: request({ headers: { "sec-websocket-key": "invalid" } }),
                url: terminalUrl(),
            },
        ];
        for (const candidate of cases) {
            const result = await boundary.handle(
                candidate.request,
                candidate.url,
                upgrade
            );
            expect(result.kind).toBe("response");
            if (result.kind === "response") {
                expect(result.response.status).toBe(candidate.expectedStatus);
                expect(result.response.headers.get("cache-control")).toBe("no-store");
            }
        }
        expect(broker.attachCalls).toHaveLength(0);
    });

    test("permits only one unambiguous browser session", async () => {
        const broker = brokerFixture(relayFixture().relay);
        let authenticationCalls = 0;
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => {
                authenticationCalls += 1;
                return authenticatedResolution();
            },
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const requests = [
            request({
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    cookie: undefined,
                },
            }),
            request({ headers: { authorization: `Bearer ${sessionToken}` } }),
        ];

        for (const unauthorizedRequest of requests) {
            const result = await boundary.handle(
                unauthorizedRequest,
                terminalUrl(),
                upgradeFixture()
            );
            expect(result.kind).toBe("response");
            if (result.kind === "response") expect(result.response.status).toBe(401);
        }
        expect(authenticationCalls).toBe(0);
        expect(broker.attachCalls).toHaveLength(0);
    });

    test("requires a session principal, terminal write capability, and recent MFA", async () => {
        const automationPrincipal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: "019fc968-1a9b-7772-8f1b-d5b863b0e7b4",
            capabilities: ["terminal:write"],
            id: "terminal-automation",
            kind: "automation",
        };
        const cases = [
            {
                lifecycle: authenticationLifecycle(),
                principal: automationPrincipal,
                status: 403,
            },
            {
                lifecycle: authenticationLifecycle(),
                principal: { ...principal, capabilities: [] },
                status: 403,
            },
            {
                lifecycle: authenticationLifecycle("step-up-required"),
                principal,
                status: 403,
            },
        ] as const;

        for (const candidate of cases) {
            const broker = brokerFixture(relayFixture().relay);
            const boundary = createTerminalSocketBoundary({
                authenticateCredential: () =>
                    authenticatedResolution({ principal: candidate.principal }),
                authenticationLifecycle: candidate.lifecycle,
                broker: broker.broker,
                nowMs: () => nowMs,
            });
            const result = await boundary.handle(
                request(),
                terminalUrl(),
                upgradeFixture()
            );
            expect(result.kind).toBe("response");
            if (result.kind === "response") {
                expect(result.response.status).toBe(candidate.status);
            }
            expect(broker.attachCalls).toHaveLength(0);
        }

        const changedSessionBoundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle("session-changed"),
            broker: brokerFixture(relayFixture().relay).broker,
            nowMs: () => nowMs,
        });
        const changedSession = await changedSessionBoundary.handle(
            request(),
            terminalUrl(),
            upgradeFixture()
        );
        expect(changedSession.kind).toBe("response");
        if (changedSession.kind === "response") {
            expect(changedSession.response.status).toBe(401);
            expect(changedSession.response.headers.get("set-cookie")).toContain(
                "Max-Age=0"
            );
        }
    });

    test("renews the same session lease and terminates when capability is revoked", async () => {
        const renewedPrincipal = {
            ...principal,
            authorizationVersion: 2,
        };
        const revokedPrincipal = {
            ...principal,
            authorizationVersion: 3,
            capabilities: [] as const,
        };
        const renewedResolution = authenticatedResolution({
            expiresAtMs: nowMs + 20_000,
            principal: renewedPrincipal,
            revalidate: () =>
                Promise.resolve(authenticatedResolution({ principal: revokedPrincipal })),
        });
        const scheduled: Array<{
            readonly callback: () => void;
            cancelled: boolean;
            readonly delayMs: number;
        }> = [];
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () =>
                authenticatedResolution({
                    revalidate: () => Promise.resolve(renewedResolution),
                }),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
            scheduler: {
                schedule(callback, delayMs) {
                    const entry = { callback, cancelled: false, delayMs };
                    scheduled.push(entry);
                    return {
                        cancel() {
                            entry.cancelled = true;
                        },
                    };
                },
            },
        });
        const upgrade = upgradeFixture();
        expect(await boundary.handle(request(), terminalUrl(), upgrade)).toEqual({
            kind: "upgraded",
        });
        const peer = peerFixture();
        upgrade.data?.open(peer.peer);
        expect(scheduled[0]?.delayMs).toBe(10_000);

        scheduled[0]?.callback();
        await settleMicrotasks();
        expect(peer.closed).toHaveLength(0);
        expect(scheduled[1]?.delayMs).toBe(20_000);

        scheduled[1]?.callback();
        await settleMicrotasks();
        expect(relay.calls).toContain("terminate");
        expect(peer.closed).toContainEqual({
            code: 1008,
            reason: "Terminal authentication expired",
        });
    });

    test("rechecks recent MFA on every authentication lease", async () => {
        const scheduled: Array<() => void> = [];
        let recentMfaChecks = 0;
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(() => {
                recentMfaChecks += 1;
                return recentMfaChecks === 1 ? "authorized" : "step-up-required";
            }),
            broker: broker.broker,
            nowMs: () => nowMs,
            scheduler: {
                schedule(callback) {
                    scheduled.push(callback);
                    return { cancel() {} };
                },
            },
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        const peer = peerFixture();
        upgrade.data?.open(peer.peer);

        scheduled[0]?.();
        await settleMicrotasks();
        expect(recentMfaChecks).toBe(2);
        expect(relay.calls).toContain("terminate");
        expect(peer.closed).toContainEqual({
            code: 1008,
            reason: "Terminal authentication expired",
        });
    });

    test("accepts the full PTY payload budget and pauses output on socket backpressure", async () => {
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        const peer = peerFixture({ binaryStatuses: [-1] });
        upgrade.data?.open(peer.peer);
        expect(relay.calls).not.toContain("resume-output");
        expect(peer.binary).toHaveLength(1);
        expect(broker.callbacks?.onOutput(2, Uint8Array.from([1, 2, 3]))).toBe(
            "accepted"
        );
        expect(peer.binary).toHaveLength(1);

        upgrade.data?.drain();
        expect(relay.calls).toContain("resume-output");
        expect(peer.binary).toHaveLength(2);
        expect(
            broker.callbacks?.onOutput(
                3,
                new Uint8Array(terminalServerMessageMaximumBytes)
            )
        ).toBe("accepted");
        expect(peer.binary.at(-1)?.byteLength).toBe(
            terminalServerMessageMaximumBytes + terminalBinaryOutputHeaderBytes
        );
        expect(peer.closed).toHaveLength(0);
        boundary.shutdown();
    });

    test("flushes terminal exit after backpressure and a broker close", async () => {
        const authentication = Promise.withResolvers<AuthenticationResolution>();
        const scheduled: Array<{
            readonly callback: () => void;
            cancelled: boolean;
            readonly delayMs: number;
        }> = [];
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () =>
                authenticatedResolution({ revalidate: () => authentication.promise }),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
            scheduler: {
                schedule(callback, delayMs) {
                    const entry = { callback, cancelled: false, delayMs };
                    scheduled.push(entry);
                    return {
                        cancel() {
                            entry.cancelled = true;
                        },
                    };
                },
            },
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        const peer = peerFixture({ binaryStatuses: [-1] });
        upgrade.data?.open(peer.peer);
        scheduled[0]?.callback();
        await settleMicrotasks();

        broker.callbacks?.onControl({
            exitCode: 0,
            reason: "exited",
            signalCode: null,
            type: "exit",
        });
        broker.callbacks?.onClose();
        const relayCallsAtExit = [...relay.calls];
        expect(broker.callbacks?.onOutput(2, Uint8Array.from([4, 5, 6]))).toBe(
            "backpressured"
        );
        broker.callbacks?.onControl({ reason: "runtime-limit", type: "closed" });
        upgrade.data?.message(Uint8Array.from([7, 8, 9]));
        upgrade.data?.message(JSON.stringify({ nonce: 9, type: "ping" }));
        await settleMicrotasks();

        expect(relay.calls).toEqual(relayCallsAtExit);
        expect(peer.closed).toHaveLength(0);
        expect(peer.text).toHaveLength(1);
        expect(JSON.parse(peer.text[0] ?? "null")).toMatchObject({ type: "ready" });
        const flushTimer = scheduled.find(({ delayMs }) => delayMs === 5000);
        expect(flushTimer).toBeDefined();

        upgrade.data?.drain();

        expect(peer.text).toHaveLength(2);
        expect(JSON.parse(peer.text[1] ?? "null")).toMatchObject({ type: "exit" });
        expect(peer.closed).toEqual([{ code: 1000, reason: "Terminal ended" }]);
        expect(flushTimer?.cancelled).toBeTrue();
        expect(relay.calls).not.toContain("terminate");
        broker.callbacks?.onClose();
        upgrade.data?.drain();
        flushTimer?.callback();
        expect(peer.closed).toHaveLength(1);
        authentication.resolve(authenticatedResolution());
    });

    test("flushes a terminal broker error before closing a backpressured socket", async () => {
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        const peer = peerFixture({ binaryStatuses: [-1] });
        upgrade.data?.open(peer.peer);

        broker.callbacks?.onControl({ reason: "backpressure", type: "closed" });
        broker.callbacks?.onClose();
        expect(peer.closed).toHaveLength(0);

        upgrade.data?.drain();

        expect(JSON.parse(peer.text.at(-1) ?? "null")).toEqual({
            code: "capacity",
            message: "Terminal session ended",
            type: "error",
        });
        expect(peer.closed).toEqual([{ code: 1000, reason: "Terminal ended" }]);
    });

    test("fails the transport when the terminal close frame cannot drain in time", async () => {
        const scheduled: Array<{
            readonly callback: () => void;
            cancelled: boolean;
            readonly delayMs: number;
        }> = [];
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
            scheduler: {
                schedule(callback, delayMs) {
                    const entry = { callback, cancelled: false, delayMs };
                    scheduled.push(entry);
                    return {
                        cancel() {
                            entry.cancelled = true;
                        },
                    };
                },
            },
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        const peer = peerFixture({ binaryStatuses: [-1] });
        upgrade.data?.open(peer.peer);

        broker.callbacks?.onControl({
            exitCode: 0,
            reason: "exited",
            signalCode: null,
            type: "exit",
        });
        const flushTimer = scheduled.find(({ delayMs }) => delayMs === 5000);
        expect(flushTimer).toBeDefined();
        expect(peer.closed).toHaveLength(0);

        flushTimer?.callback();

        expect(peer.text).toHaveLength(1);
        expect(JSON.parse(peer.text[0] ?? "null")).toMatchObject({ type: "ready" });
        expect(peer.closed).toEqual([{ code: 1011, reason: "Terminal unavailable" }]);
        expect(relay.calls).toContain("terminate");
        broker.callbacks?.onClose();
        upgrade.data?.drain();
        flushTimer?.callback();
        expect(peer.closed).toHaveLength(1);
    });

    test("bounds worker output queued before Bun opens the socket", async () => {
        const relay = relayFixture();
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        let disposition: "accepted" | "backpressured" = "accepted";

        for (let sequence = 2; sequence < 40; sequence += 1) {
            disposition =
                broker.callbacks?.onOutput(
                    sequence,
                    new Uint8Array(terminalServerMessageMaximumBytes)
                ) ?? "backpressured";
            if (disposition === "backpressured") break;
        }

        expect(disposition).toBe("backpressured");
        expect(relay.calls).toContain("terminate");
        const peer = peerFixture();
        upgrade.data?.open(peer.peer);
        expect(peer.closed).toContainEqual({
            code: 1011,
            reason: "Terminal unavailable",
        });
    });

    test("queues binary input in order across relay backpressure and drain", async () => {
        const relay = relayFixture([
            "backpressured",
            "accepted",
            "backpressured",
            "accepted",
        ]);
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        if (upgrade.data === undefined) throw new Error("Expected upgraded connection");
        const peer = peerFixture();
        const socket = Object.freeze({ data: upgrade.data, ...peer.peer });
        boundary.websocket.open(socket);

        boundary.websocket.message(socket, Uint8Array.from([1]));
        boundary.websocket.message(socket, Uint8Array.from([2]));
        boundary.websocket.message(socket, Uint8Array.from([3]));
        expect(relay.calls).toEqual(["resume-output", "input:01"]);

        broker.callbacks?.onInputDrain();
        expect(relay.calls).toEqual([
            "resume-output",
            "input:01",
            "input:02",
            "input:03",
        ]);
        boundary.websocket.message(socket, Uint8Array.from([4]));
        broker.callbacks?.onInputDrain();
        expect(relay.calls).toEqual([
            "resume-output",
            "input:01",
            "input:02",
            "input:03",
            "input:04",
        ]);
        expect(peer.closed).toHaveLength(0);
        boundary.shutdown();
    });

    test("waits for the broker drain callback after accepted PTY acknowledgements", async () => {
        const relay = relayFixture([
            "backpressured",
            "accepted",
            "backpressured",
            "backpressured",
            "accepted",
        ]);
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        if (upgrade.data === undefined) throw new Error("Expected upgraded connection");
        const peer = peerFixture();
        const socket = Object.freeze({ data: upgrade.data, ...peer.peer });
        boundary.websocket.open(socket);

        boundary.websocket.message(socket, Uint8Array.from([1]));
        boundary.websocket.message(socket, Uint8Array.from([2]));
        boundary.websocket.message(socket, Uint8Array.from([3]));
        expect(relay.calls).toEqual(["resume-output", "input:01"]);

        broker.callbacks?.onControl({
            acceptedBytes: 1,
            status: "accepted",
            type: "input-status",
        });
        expect(relay.calls).toEqual(["resume-output", "input:01"]);
        broker.callbacks?.onInputDrain();
        expect(relay.calls).toEqual([
            "resume-output",
            "input:01",
            "input:02",
            "input:03",
        ]);

        boundary.websocket.message(socket, Uint8Array.from([4]));
        broker.callbacks?.onControl({
            acceptedBytes: 1,
            status: "accepted",
            type: "input-status",
        });
        expect(relay.calls.at(-1)).toBe("input:03");
        broker.callbacks?.onInputDrain();
        expect(relay.calls).toEqual([
            "resume-output",
            "input:01",
            "input:02",
            "input:03",
            "input:04",
        ]);

        broker.callbacks?.onControl({
            acceptedBytes: 1,
            status: "accepted",
            type: "input-status",
        });
        broker.callbacks?.onInputDrain();
        boundary.websocket.message(socket, Uint8Array.from([5]));
        expect(relay.calls.at(-1)).toBe("input:05");
        expect(peer.closed).toHaveLength(0);
        boundary.shutdown();
    });

    test("terminates and clears queued binary input on bounded overflow", async () => {
        const relay = relayFixture(["backpressured"]);
        const broker = brokerFixture(relay.relay);
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: broker.broker,
            nowMs: () => nowMs,
        });
        const upgrade = upgradeFixture();
        await boundary.handle(request(), terminalUrl(), upgrade);
        if (upgrade.data === undefined) throw new Error("Expected upgraded connection");
        const peer = peerFixture();
        const socket = Object.freeze({ data: upgrade.data, ...peer.peer });
        boundary.websocket.open(socket);
        boundary.websocket.message(socket, Uint8Array.from([1]));
        const fullInputFrame = new Uint8Array(terminalClientMessageMaximumBytes);

        for (
            let queuedBytes = 0;
            queuedBytes < terminalSocketBufferedMaximumBytes;
            queuedBytes += fullInputFrame.byteLength
        ) {
            boundary.websocket.message(socket, fullInputFrame);
        }
        expect(peer.closed).toHaveLength(0);
        boundary.websocket.message(socket, Uint8Array.from([2]));

        expect(relay.calls).toEqual(["resume-output", "input:01", "terminate"]);
        expect(peer.closed).toContainEqual({
            code: 1009,
            reason: "Terminal input exceeded its budget",
        });
        const finalizedCalls = [...relay.calls];
        broker.callbacks?.onInputDrain();
        expect(relay.calls).toEqual(finalizedCalls);
    });

    test("terminates on oversized or malformed frames", async () => {
        const cases: Array<{
            readonly act: (
                connection: TerminalSocketConnection,
                callbacks: TerminalBrokerRelayCallbacks
            ) => void;
            readonly closeCode: number;
        }> = [
            {
                act: (_connection, callbacks) => {
                    callbacks.onOutput(
                        2,
                        new Uint8Array(terminalServerMessageMaximumBytes + 1)
                    );
                },
                closeCode: 1011,
            },
            {
                act: (connection) => connection.message("{not-json"),
                closeCode: 1002,
            },
            {
                act: (connection) => connection.message(new Uint8Array()),
                closeCode: 1009,
            },
            {
                act: (connection) =>
                    connection.message(
                        new Uint8Array(terminalClientMessageMaximumBytes + 1)
                    ),
                closeCode: 1009,
            },
        ];

        for (const candidate of cases) {
            const relay = relayFixture();
            const broker = brokerFixture(relay.relay);
            const boundary = createTerminalSocketBoundary({
                authenticateCredential: () => authenticatedResolution(),
                authenticationLifecycle: authenticationLifecycle(),
                broker: broker.broker,
                nowMs: () => nowMs,
            });
            const upgrade = upgradeFixture();
            await boundary.handle(request(), terminalUrl(), upgrade);
            const peer = peerFixture();
            upgrade.data?.open(peer.peer);
            if (upgrade.data !== undefined && broker.callbacks !== undefined) {
                candidate.act(upgrade.data, broker.callbacks);
            }
            expect(relay.calls).toContain("terminate");
            expect(peer.closed.at(-1)?.code).toBe(candidate.closeCode);
        }
    });

    test("detaches transport loss but terminates policy, explicit, and shutdown closes", async () => {
        const createConnected = async () => {
            const relay = relayFixture();
            const broker = brokerFixture(relay.relay);
            const boundary = createTerminalSocketBoundary({
                authenticateCredential: () => authenticatedResolution(),
                authenticationLifecycle: authenticationLifecycle(),
                broker: broker.broker,
                nowMs: () => nowMs,
            });
            const upgrade = upgradeFixture();
            await boundary.handle(request(), terminalUrl(), upgrade);
            const peer = peerFixture();
            upgrade.data?.open(peer.peer);
            return { boundary, peer, relay, upgrade };
        };

        const disconnected = await createConnected();
        disconnected.upgrade.data?.networkClosed();
        expect(disconnected.relay.calls).toContain("detach");
        expect(disconnected.relay.calls).not.toContain("terminate");

        const policyClosed = await createConnected();
        policyClosed.upgrade.data?.transportClosed(1009);
        expect(policyClosed.relay.calls).toContain("terminate");
        expect(policyClosed.relay.calls).not.toContain("detach");

        const explicitlyClosed = await createConnected();
        explicitlyClosed.upgrade.data?.message(JSON.stringify({ type: "close" }));
        expect(explicitlyClosed.relay.calls).toContain("terminate");
        expect(explicitlyClosed.relay.calls).not.toContain("detach");
        expect(explicitlyClosed.peer.closed).toContainEqual({
            code: 1000,
            reason: "Terminal ended by operator",
        });

        const stopped = await createConnected();
        stopped.boundary.shutdown();
        expect(stopped.relay.calls).toContain("terminate");
        expect(stopped.peer.closed).toContainEqual({
            code: 1012,
            reason: "Server restarting",
        });
        const afterShutdown = await stopped.boundary.handle(
            request(),
            terminalUrl(),
            upgradeFixture()
        );
        expect(afterShutdown.kind).toBe("response");
        if (afterShutdown.kind === "response") {
            expect(afterShutdown.response.status).toBe(503);
        }
    });

    test("does not consume or upgrade tickets across shutdown races", async () => {
        const authenticationStarted = Promise.withResolvers<void>();
        const authentication = Promise.withResolvers<AuthenticationResolution>();
        const authenticationBroker = brokerFixture(relayFixture().relay);
        const authenticationBoundary = createTerminalSocketBoundary({
            authenticateCredential: () => {
                authenticationStarted.resolve();
                return authentication.promise;
            },
            authenticationLifecycle: authenticationLifecycle(),
            broker: authenticationBroker.broker,
            nowMs: () => nowMs,
        });
        const pendingAuthentication = authenticationBoundary.handle(
            request(),
            terminalUrl(),
            upgradeFixture()
        );
        await authenticationStarted.promise;
        authenticationBoundary.shutdown();
        authentication.resolve(authenticatedResolution());
        const authenticationResult = await pendingAuthentication;
        expect(authenticationResult.kind).toBe("response");
        if (authenticationResult.kind === "response") {
            expect(authenticationResult.response.status).toBe(503);
        }
        expect(authenticationBroker.attachCalls).toHaveLength(0);

        const attachStarted = Promise.withResolvers<void>();
        const finishAttach = Promise.withResolvers<void>();
        const relay = relayFixture();
        let upgraded = false;
        const baseBroker = brokerFixture(relay.relay).broker;
        const delayedBroker: InteractiveTerminalBrokerClient = Object.freeze({
            ...baseBroker,
            async attach() {
                attachStarted.resolve();
                await finishAttach.promise;
                return relay.relay;
            },
        });
        const attachBoundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: delayedBroker,
            nowMs: () => nowMs,
        });
        const pendingAttach = attachBoundary.handle(request(), terminalUrl(), {
            upgrade() {
                upgraded = true;
                return true;
            },
        });
        await attachStarted.promise;
        attachBoundary.shutdown();
        finishAttach.resolve();
        const attachResult = await pendingAttach;
        expect(attachResult.kind).toBe("response");
        if (attachResult.kind === "response") {
            expect(attachResult.response.status).toBe(503);
        }
        expect(upgraded).toBe(false);
        expect(relay.calls).toContain("terminate");
    });

    test("maps a consumed or expired ticket to an uncached 410", async () => {
        const expiredBroker = brokerFixture(
            relayFixture().relay,
            new TerminalSessionBrokerError("gone")
        );
        const expiredBoundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: expiredBroker.broker,
            nowMs: () => nowMs,
        });
        const expired = await expiredBoundary.handle(
            request(),
            terminalUrl(),
            upgradeFixture()
        );
        expect(expired.kind).toBe("response");
        if (expired.kind === "response") {
            expect(expired.response.status).toBe(410);
            expect(expired.response.headers.get("cache-control")).toBe("no-store");
            expect(await expired.response.text()).not.toContain(connectionToken);
        }
    });

    test("publishes Bun WebSocket budgets without compression", () => {
        const boundary = createTerminalSocketBoundary({
            authenticateCredential: () => authenticatedResolution(),
            authenticationLifecycle: authenticationLifecycle(),
            broker: brokerFixture(relayFixture().relay).broker,
        });
        const bunCompatibleHandler: WebSocketHandler<TerminalSocketConnection> =
            boundary.websocket;
        const bunUpgradeCompatibility: Server<TerminalSocketConnection> extends TerminalSocketUpgradeServer
            ? true
            : false = true;

        expect(bunUpgradeCompatibility).toBe(true);
        expect(bunCompatibleHandler.maxPayloadLength).toBe(
            terminalClientMessageMaximumBytes
        );
        expect(boundary.websocket.backpressureLimit).toBe(
            terminalSocketBufferedMaximumBytes
        );
        expect(boundary.websocket.closeOnBackpressureLimit).toBe(true);
        expect(boundary.websocket.perMessageDeflate).toBe(false);
        expect(boundary.websocket.sendPings).toBe(true);
    });
});
