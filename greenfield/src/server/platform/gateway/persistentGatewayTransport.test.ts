import { describe, expect, test } from "bun:test";

import { Effect, Layer, Redacted } from "effect";

import { captureFailure } from "../../test/support/promise.ts";
import {
    persistentGatewayAuthenticatedFrameMaximumBytes,
    persistentGatewayBufferedAmountMaximumBytes,
    persistentGatewayBufferedAmountPolicyMaximumBytes,
    type PersistentGatewayAdminMethod,
    type PersistentGatewayReadWriteMethod,
} from "./persistentGatewayProtocol.ts";
import {
    createPersistentGatewayTransport,
    createPersistentGatewayTaskNotificationTransport,
    PersistentGatewayAbortError,
    PersistentGatewayCapacityError,
    persistentGatewayCronJobChangedReason,
    type PersistentGatewayConnectionSnapshot,
    type PersistentGatewayDeliveredEvent,
    type PersistentGatewayEventGap,
    type PersistentGatewayRequestOptions,
    PersistentGatewayRequestError,
    type PersistentGatewayScheduler,
    PersistentGatewayTimeoutError,
    type PersistentGatewayTransport,
    type PersistentGatewayTransportOptions,
    persistentGatewayTransportLifecycleLayer,
    PersistentGatewayUnknownOutcomeError,
    PersistentGatewayUnavailableError,
} from "./persistentGatewayTransport.ts";

const fixtureToken = "transport-fixture-secret-token";
const fixtureEventId = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";
const fixtureIdempotencyKey = `tasks-notify-${fixtureEventId}`;

interface ScheduledTask {
    readonly atMs: number;
    readonly callback: () => void;
    readonly id: number;
}

class ManualScheduler implements PersistentGatewayScheduler {
    readonly #tasks = new Map<number, ScheduledTask>();
    #nextId = 1;
    #nowMs = 1000;

    get nowMs(): number {
        return this.#nowMs;
    }

    clearTimeout(handle: unknown): void {
        if (typeof handle === "number") this.#tasks.delete(handle);
    }

    setTimeout(callback: () => void, delayMs: number): number {
        const id = this.#nextId;
        this.#nextId += 1;
        this.#tasks.set(id, {
            atMs: this.#nowMs + delayMs,
            callback,
            id,
        });
        return id;
    }

    advance(milliseconds: number): void {
        const target = this.#nowMs + milliseconds;
        while (true) {
            const next = [...this.#tasks.values()]
                .filter((task) => task.atMs <= target)
                .toSorted(
                    (left, right) => left.atMs - right.atMs || left.id - right.id
                )[0];
            if (next === undefined) break;
            this.#tasks.delete(next.id);
            this.#nowMs = next.atMs;
            next.callback();
        }
        this.#nowMs = target;
    }
}

interface CloseCall {
    readonly code?: number;
    readonly reason?: string;
}

class ControlledWebSocket extends EventTarget {
    bufferedAmount = 0;
    readonly closeCalls: CloseCall[] = [];
    readyState: number = WebSocket.CONNECTING;
    readonly sent: string[] = [];

    close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason });
        this.readyState = WebSocket.CLOSING;
    }

    fail(): void {
        this.dispatchEvent(new Event("error"));
    }

    finishClose(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
    }

    open(): void {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
    }

    receive(value: unknown): void {
        this.receiveRaw(JSON.stringify(value));
    }

    receiveRaw(value: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data: value }));
    }

    send(value: string): void {
        this.sent.push(value);
    }
}

class SocketHarness {
    readonly sockets: ControlledWebSocket[] = [];
    readonly urls: string[] = [];

    create = (url: string): WebSocket => {
        this.urls.push(url);
        const socket = new ControlledWebSocket();
        this.sockets.push(socket);
        return socket as unknown as WebSocket;
    };
}

interface TestRequestFrame {
    readonly id: string;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly type: "req";
}

type TestLane = "admin" | "task-notification-worker" | "web-read";

function scopesForTestLane(lane: TestLane): readonly string[] {
    switch (lane) {
        case "admin": {
            return ["operator.admin"];
        }
        case "task-notification-worker": {
            return ["operator.write"];
        }
        case "web-read": {
            return ["operator.read"];
        }
    }
}

function sentFrame(socket: ControlledWebSocket, index: number): TestRequestFrame {
    const encoded = socket.sent[index];
    if (encoded === undefined) throw new Error("Expected a sent Gateway frame");
    const value: unknown = JSON.parse(encoded);
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as Readonly<Record<string, unknown>>).id !== "string" ||
        typeof (value as Readonly<Record<string, unknown>>).method !== "string"
    ) {
        throw new Error("Expected a request frame");
    }
    return value as unknown as TestRequestFrame;
}

function helloPayload(input: {
    readonly connectionId: string;
    readonly events?: readonly string[];
    readonly maxBufferedBytes?: number;
    readonly maxPayload?: number;
    readonly methods: readonly string[];
    readonly scopes: readonly string[];
    readonly tickIntervalMs?: number;
}): Readonly<Record<string, unknown>> {
    return {
        auth: { role: "operator", scopes: input.scopes },
        features: {
            events: input.events ?? ["tick", "cron", "sessions.changed"],
            methods: input.methods,
        },
        policy: {
            maxBufferedBytes: input.maxBufferedBytes ?? 4 * 1024 * 1024,
            maxPayload:
                input.maxPayload ?? persistentGatewayAuthenticatedFrameMaximumBytes,
            tickIntervalMs: input.tickIntervalMs ?? 100,
        },
        protocol: 4,
        server: {
            connId: input.connectionId,
            version: "2026.7.2-beta.7",
        },
        snapshot: {
            health: { ok: true },
            presence: [],
            stateVersion: { health: 1, presence: 1 },
        },
        type: "hello-ok",
    };
}

function completeHandshake(
    socket: ControlledWebSocket,
    input: {
        readonly connectionId?: string;
        readonly lane: TestLane;
        readonly maxBufferedBytes?: number;
        readonly maxPayload?: number;
        readonly methods: readonly string[];
        readonly tickIntervalMs?: number;
    }
): TestRequestFrame {
    const methods =
        input.lane === "web-read"
            ? [...new Set([...input.methods, "sessions.subscribe"])]
            : input.methods;
    socket.open();
    socket.receive({
        event: "connect.challenge",
        payload: { nonce: "fixture-nonce" },
        type: "event",
    });
    const connect = sentFrame(socket, 0);
    socket.receive({
        id: connect.id,
        ok: true,
        payload: helloPayload({
            connectionId: input.connectionId ?? "connection-1",
            maxBufferedBytes: input.maxBufferedBytes,
            maxPayload: input.maxPayload,
            methods,
            scopes: scopesForTestLane(input.lane),
            tickIntervalMs: input.tickIntervalMs,
        }),
        type: "res",
    });
    if (input.lane === "web-read") {
        const subscription = sentFrame(socket, 1);
        expect(subscription).toMatchObject({
            method: "sessions.subscribe",
            params: {},
            type: "req",
        });
        socket.receive({
            id: subscription.id,
            ok: true,
            payload: { subscribed: true },
            type: "res",
        });
        // Preserve the historical request indices for tests that focus on the
        // post-handshake data plane. Dedicated tests retain and assert this frame.
        socket.sent.splice(1, 1);
    }
    return connect;
}

function createFixtureTransport(
    harness: SocketHarness,
    scheduler: ManualScheduler,
    overrides: Partial<PersistentGatewayTransportOptions> = {}
): PersistentGatewayTransport {
    let requestId = 0;
    return createPersistentGatewayTransport({
        clientVersion: "0.0.0",
        createRequestId: () => {
            requestId += 1;
            return `request-${requestId}`;
        },
        gracefulStopTimeoutMs: 500,
        handshakeTimeoutMs: 500,
        instanceId: "dashboard-process-1",
        nowMs: () => scheduler.nowMs,
        random: () => 0.5,
        reconnect: {
            factor: 2,
            initialDelayMs: 100,
            jitterRatio: 0.2,
            maximumDelayMs: 1000,
        },
        requestTimeoutMs: 100,
        scheduler,
        tickTimeoutMultiplier: 2,
        token: Redacted.make(fixtureToken, { label: "test-gateway-token" }),
        url: "ws://127.0.0.1:18789",
        webSocketFactory: harness.create,
        ...overrides,
    });
}

function createFixtureTaskNotificationTransport(
    harness: SocketHarness,
    scheduler: ManualScheduler,
    overrides: Partial<PersistentGatewayTransportOptions> = {}
) {
    let requestId = 0;
    return createPersistentGatewayTaskNotificationTransport({
        clientVersion: "0.0.0",
        createRequestId: () => {
            requestId += 1;
            return `request-${requestId}`;
        },
        gracefulStopTimeoutMs: 500,
        handshakeTimeoutMs: 500,
        instanceId: "dashboard-worker-1",
        nowMs: () => scheduler.nowMs,
        random: () => 0.5,
        reconnect: {
            factor: 2,
            initialDelayMs: 100,
            jitterRatio: 0.2,
            maximumDelayMs: 1000,
        },
        requestTimeoutMs: 100,
        scheduler,
        tickTimeoutMultiplier: 2,
        token: Redacted.make(fixtureToken, { label: "test-gateway-token" }),
        url: "ws://127.0.0.1:18789",
        webSocketFactory: harness.create,
        ...overrides,
    });
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function stopConnected(
    transport: PersistentGatewayTransport,
    socket: ControlledWebSocket
): Promise<void> {
    const stopping = transport.stop();
    expect(transport.snapshot.phase).toBe("stopping");
    socket.finishClose();
    await stopping;
    expect(transport.snapshot.phase).toBe("stopped");
}

type RuntimeRequest = (
    method: string,
    parameters: Readonly<Record<string, unknown>>,
    options?: PersistentGatewayRequestOptions
) => Promise<unknown>;

describe("persistent native Gateway transport", () => {
    test("handshakes once, projects live state, correlates requests, and delivers events", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const states: PersistentGatewayConnectionSnapshot[] = [];
        const events: PersistentGatewayDeliveredEvent[] = [];
        transport.subscribe({
            onEvent: (event) => events.push(event),
            onState: (snapshot) => states.push(snapshot),
        });
        transport.subscribe({
            onState: () => {
                throw new Error("listener defects stay isolated");
            },
        });

        transport.start();
        expect(transport.snapshot).toMatchObject({
            connectionGeneration: 1,
            phase: "connecting",
            reconnectAttempt: 0,
        });
        expect(harness.urls).toEqual(["ws://127.0.0.1:18789/"]);
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        const connect = completeHandshake(socket, {
            connectionId: "persistent-connection-1",
            lane: "web-read",
            methods: ["sessions.list"],
        });

        expect(connect.params).toMatchObject({
            auth: { token: fixtureToken },
            role: "operator",
            scopes: ["operator.read"],
        });
        expect(transport.snapshot).toEqual({
            connectedAtMs: 1000,
            connectionGeneration: 1,
            lastActivityAtMs: 1000,
            lastKnownGood: {
                connectedAtMs: 1000,
                connectionId: "persistent-connection-1",
                protocol: 4,
                serverVersion: "2026.7.2-beta.7",
            },
            phase: "connected",
            reconnectAttempt: 0,
        });

        socket.receive({
            event: "sessions.changed",
            payload: { reason: "fixture" },
            seq: 1,
            type: "event",
        });
        const secretShapedEventPayload = "Bearer transport-secret-shaped-payload";
        socket.receive({
            event: "cron",
            payload: {
                credential: secretShapedEventPayload,
                nested: { token: secretShapedEventPayload },
            },
            seq: 2,
            type: "event",
        });
        expect(events).toEqual([
            {
                connectionGeneration: 1,
                frame: {
                    event: "sessions.changed",
                    seq: 1,
                    type: "event",
                },
                receivedAtMs: 1000,
            },
            {
                connectionGeneration: 1,
                frame: { event: "cron", seq: 2, type: "event" },
                receivedAtMs: 1000,
            },
        ]);
        expect(JSON.stringify(events)).not.toContain(secretShapedEventPayload);

        const result = transport.request("sessions.list", { limit: 20 });
        const request = sentFrame(socket, 1);
        expect(request).toMatchObject({
            method: "sessions.list",
            params: { limit: 20 },
            type: "req",
        });
        socket.receive({
            id: request.id,
            ok: true,
            payload: { sessions: [] },
            type: "res",
        });
        expect(await result).toEqual({ sessions: [] });
        expect(states.map((snapshot) => snapshot.phase)).toContain("connected");

        await stopConnected(transport, socket);
    });

    test("consumes sequenced irrelevant broadcasts without exposing payloads or closing", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const events: PersistentGatewayDeliveredEvent[] = [];
        transport.subscribe({ onEvent: (event) => events.push(event) });
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "web-read",
            maxBufferedBytes: persistentGatewayBufferedAmountPolicyMaximumBytes,
            methods: ["sessions.list"],
        });

        scheduler.advance(1);
        socket.receive({
            event: "node.presence",
            payload: { privateProviderShape: "targeted" },
            type: "event",
        });
        expect(transport.snapshot).toMatchObject({
            lastActivityAtMs: 1001,
            phase: "connected",
        });
        expect(transport.snapshot.lastEventSequence).toBeUndefined();

        const irrelevantEvents = [
            "update.available",
            "config.changed",
            "skills.changed",
            "voicewake.changed",
            "node.presence",
            "session.message",
            "session.tool",
            "task.suggestion",
            "talk.event",
        ];
        for (const [index, event] of irrelevantEvents.entries()) {
            scheduler.advance(1);
            socket.receive({
                event,
                payload: { privateProviderShape: `irrelevant-${index}` },
                seq: index + 1,
                type: "event",
            });
        }
        expect(socket.closeCalls).toHaveLength(0);
        expect(transport.snapshot).toMatchObject({
            lastActivityAtMs: 1000 + irrelevantEvents.length + 1,
            lastEventSequence: irrelevantEvents.length,
            phase: "connected",
        });
        expect(events).toEqual([]);

        socket.receive({
            event: "sessions.changed",
            payload: { reason: "fixture" },
            seq: irrelevantEvents.length + 1,
            type: "event",
        });
        expect(events).toHaveLength(1);
        expect(events[0]?.frame).toEqual({
            event: "sessions.changed",
            seq: irrelevantEvents.length + 1,
            type: "event",
        });
        expect(JSON.stringify(events)).not.toContain("privateProviderShape");

        socket.receive({
            event: "talk.event",
            payload: { privateProviderShape: "targeted-after-baseline" },
            type: "event",
        });
        expect(transport.snapshot.lastEventSequence).toBe(irrelevantEvents.length + 1);
        expect(socket.closeCalls).toHaveLength(0);

        await stopConnected(transport, socket);
    });

    test("consumes a maximum-size irrelevant payload flood without retaining provider data", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const events: PersistentGatewayDeliveredEvent[] = [];
        transport.subscribe({ onEvent: (event) => events.push(event) });
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "web-read",
            methods: ["sessions.list"],
        });

        const secretShapedPayload = "Bearer maximum-frame-private-value";
        const prefix = `{"event":"session.message","payload":{"credential":"${secretShapedPayload}","padding":"`;
        const suffix = '"},"type":"event"}';
        const paddingLength =
            persistentGatewayAuthenticatedFrameMaximumBytes -
            prefix.length -
            suffix.length;
        const maximumFrame = `${prefix}${"x".repeat(paddingLength)}${suffix}`;
        expect(maximumFrame.length).toBe(persistentGatewayAuthenticatedFrameMaximumBytes);
        socket.receiveRaw(maximumFrame);
        for (let index = 0; index < 64; index += 1) {
            socket.receive({
                event: index % 2 === 0 ? "session.message" : "session.tool",
                payload: { credential: secretShapedPayload, index },
                type: "event",
            });
        }

        expect(socket.closeCalls).toHaveLength(0);
        expect(events).toEqual([]);
        expect(transport.snapshot.phase).toBe("connected");
        expect(JSON.stringify({ events, snapshot: transport.snapshot })).not.toContain(
            secretShapedPayload
        );
        await stopConnected(transport, socket);
    });

    test("requires the first broadcast sequence to be one and rejects duplicate challenges", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const gaps: PersistentGatewayEventGap[] = [];
        transport.subscribe({ onEventGap: (gap) => gaps.push(gap) });
        transport.start();
        const firstSocket = harness.sockets[0];
        if (firstSocket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(firstSocket, {
            lane: "web-read",
            methods: ["sessions.list"],
        });
        firstSocket.receive({
            event: "config.changed",
            payload: {},
            seq: 2,
            type: "event",
        });
        expect(gaps).toEqual([
            {
                connectionGeneration: 1,
                expectedSequence: 1,
                receivedSequence: 2,
            },
        ]);
        firstSocket.finishClose();

        scheduler.advance(100);
        const secondSocket = harness.sockets[1];
        if (secondSocket === undefined) throw new Error("Expected a reconnect socket");
        completeHandshake(secondSocket, {
            lane: "web-read",
            methods: ["sessions.list"],
        });
        secondSocket.receive({
            event: "connect.challenge",
            payload: { nonce: "duplicate" },
            type: "event",
        });
        expect(secondSocket.closeCalls).toEqual([
            { code: 1008, reason: "duplicate gateway challenge" },
        ]);
        secondSocket.finishClose();
        expect(transport.snapshot).toMatchObject({
            lastFailure: "protocol",
            nextReconnectAtMs: undefined,
            phase: "degraded",
        });
        await transport.stop();
    });

    test("subscribes after each hello and reconnects when the subscription is rejected", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const events: PersistentGatewayDeliveredEvent[] = [];
        transport.subscribe({ onEvent: (event) => events.push(event) });
        transport.start();
        const firstSocket = harness.sockets[0];
        if (firstSocket === undefined) throw new Error("Expected the first socket");
        firstSocket.open();
        firstSocket.receive({
            event: "connect.challenge",
            payload: { nonce: "fixture-nonce" },
            type: "event",
        });
        const firstConnect = sentFrame(firstSocket, 0);
        firstSocket.receive({
            id: firstConnect.id,
            ok: true,
            payload: helloPayload({
                connectionId: "subscription-generation-1",
                methods: ["sessions.list", "sessions.subscribe"],
                scopes: ["operator.read"],
            }),
            type: "res",
        });
        const firstSubscription = sentFrame(firstSocket, 1);
        expect(firstSubscription).toMatchObject({
            method: "sessions.subscribe",
            params: {},
        });
        expect(transport.snapshot.phase).toBe("connecting");
        firstSocket.receive({
            error: { code: "UNAVAILABLE", message: "fixture rejection" },
            id: firstSubscription.id,
            ok: false,
            type: "res",
        });
        expect(firstSocket.closeCalls).toEqual([
            { code: 1008, reason: "gateway subscription rejected" },
        ]);
        firstSocket.finishClose();
        expect(transport.snapshot).toMatchObject({
            lastFailure: "upstream",
            phase: "degraded",
        });

        scheduler.advance(100);
        const secondSocket = harness.sockets[1];
        if (secondSocket === undefined) throw new Error("Expected a reconnect socket");
        secondSocket.open();
        secondSocket.receive({
            event: "connect.challenge",
            payload: { nonce: "fixture-nonce-2" },
            type: "event",
        });
        const secondConnect = sentFrame(secondSocket, 0);
        secondSocket.receive({
            id: secondConnect.id,
            ok: true,
            payload: helloPayload({
                connectionId: "subscription-generation-2",
                methods: ["sessions.list", "sessions.subscribe"],
                scopes: ["operator.read"],
            }),
            type: "res",
        });
        const secondSubscription = sentFrame(secondSocket, 1);
        expect(secondSubscription).toMatchObject({
            method: "sessions.subscribe",
            params: {},
        });
        secondSocket.receive({
            id: secondSubscription.id,
            ok: true,
            payload: { subscribed: true },
            type: "res",
        });
        expect(transport.snapshot).toMatchObject({
            connectionGeneration: 2,
            lastKnownGood: { connectionId: "subscription-generation-2" },
            phase: "connected",
        });
        secondSocket.receive({
            event: "sessions.changed",
            payload: { reason: "subscribed-reconnect" },
            seq: 1,
            type: "event",
        });
        expect(events.map((event) => event.frame.event)).toEqual(["sessions.changed"]);

        await stopConnected(transport, secondSocket);
    });

    test("degrades and reconnects when the required session subscription times out", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        socket.open();
        socket.receive({
            event: "connect.challenge",
            payload: { nonce: "fixture-nonce" },
            type: "event",
        });
        const connect = sentFrame(socket, 0);
        socket.receive({
            id: connect.id,
            ok: true,
            payload: helloPayload({
                connectionId: "subscription-timeout",
                methods: ["sessions.list", "sessions.subscribe"],
                scopes: ["operator.read"],
            }),
            type: "res",
        });
        expect(sentFrame(socket, 1).method).toBe("sessions.subscribe");
        expect(transport.snapshot.phase).toBe("connecting");
        scheduler.advance(500);
        expect(socket.closeCalls).toEqual([
            { code: 1008, reason: "gateway handshake timeout" },
        ]);
        socket.finishClose();
        expect(transport.snapshot).toMatchObject({
            lastFailure: "handshake-timeout",
            phase: "degraded",
        });
        scheduler.advance(100);
        expect(harness.sockets).toHaveLength(2);
        const reconnectSocket = harness.sockets[1];
        if (reconnectSocket === undefined) throw new Error("Expected reconnect lane");
        const stopping = transport.stop();
        reconnectSocket.finishClose();
        await stopping;
    });

    test("accepts the installed 50 MiB buffer policy while retaining the 4 MiB local ceiling", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "web-read",
            maxBufferedBytes: persistentGatewayBufferedAmountPolicyMaximumBytes,
            methods: ["sessions.list"],
        });

        socket.bufferedAmount = persistentGatewayBufferedAmountMaximumBytes;
        expect(
            await captureFailure(() => transport.request("sessions.list", { limit: 1 }))
        ).toBeInstanceOf(PersistentGatewayCapacityError);
        expect(transport.snapshot.phase).toBe("connected");

        socket.bufferedAmount = 0;
        const request = transport.request("sessions.list", { limit: 1 });
        const frame = sentFrame(socket, 1);
        socket.receive({
            id: frame.id,
            ok: true,
            payload: { sessions: [] },
            type: "res",
        });
        expect(await request).toEqual({ sessions: [] });
        await stopConnected(transport, socket);
    });

    test("exposes a strict task-notification chat sender instead of generic chat.send", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTaskNotificationTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "task-notification-worker",
            methods: ["chat.send"],
            tickIntervalMs: 6000,
        });

        const runtimeRequest = (
            transport as unknown as { readonly request: RuntimeRequest }
        ).request.bind(transport);
        expect(
            await captureFailure(() =>
                runtimeRequest("chat.send", {
                    idempotencyKey: fixtureIdempotencyKey,
                    message: "unsafe generic send",
                    sessionKey: "agent:main:main",
                })
            )
        ).toBeInstanceOf(PersistentGatewayUnavailableError);
        expect(socket.sent).toHaveLength(1);

        const controller = new AbortController();
        const send = transport.taskNotificationSender.send(
            {
                idempotencyKey: fixtureIdempotencyKey,
                message: "Task Example was updated.",
                sessionKey: "agent:main:main",
            },
            controller.signal
        );
        const request = sentFrame(socket, 1);
        expect(request).toEqual({
            id: request.id,
            method: "chat.send",
            params: {
                idempotencyKey: fixtureIdempotencyKey,
                message: "Task Example was updated.",
                sessionKey: "agent:main:main",
            },
            type: "req",
        });
        socket.receive({
            id: request.id,
            ok: true,
            payload: {
                runId: fixtureIdempotencyKey,
                serverTiming: { receivedToAckMs: 1 },
                status: "started",
            },
            type: "res",
        });
        await send;

        expect(
            await captureFailure(() =>
                transport.taskNotificationSender.send(
                    {
                        idempotencyKey: "arbitrary-key",
                        message: "Task Example was updated.",
                        sessionKey: "agent:main:main",
                    },
                    controller.signal
                )
            )
        ).toBeInstanceOf(PersistentGatewayUnavailableError);
        expect(socket.sent).toHaveLength(2);

        const incompatible = transport.taskNotificationSender.send(
            {
                idempotencyKey: fixtureIdempotencyKey,
                message: "Task Example was updated again.",
                sessionKey: "agent:main:main",
            },
            controller.signal
        );
        const incompatibleRequest = sentFrame(socket, 2);
        socket.receive({
            id: incompatibleRequest.id,
            ok: true,
            payload: { runId: "different-run", status: "started" },
            type: "res",
        });
        expect(await captureFailure(() => incompatible)).toBeInstanceOf(
            PersistentGatewayUnavailableError
        );

        const unsupported = transport.taskNotificationSender.send(
            {
                idempotencyKey: fixtureIdempotencyKey,
                message: "Task Example was updated again.",
                sessionKey: "agent:main:main",
            },
            controller.signal
        );
        const unsupportedRequest = sentFrame(socket, 3);
        socket.receive({
            id: unsupportedRequest.id,
            ok: true,
            payload: { runId: fixtureIdempotencyKey, status: "timeout" },
            type: "res",
        });
        expect(await captureFailure(() => unsupported)).toBeInstanceOf(
            PersistentGatewayUnavailableError
        );

        const stopping = transport.stop();
        socket.finishClose();
        await stopping;
    });

    test("settles an idempotent task-notification retry after a lost chat-send acknowledgement", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTaskNotificationTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "task-notification-worker",
            methods: ["chat.send"],
            tickIntervalMs: 60_000,
        });

        const controller = new AbortController();
        const firstAttempt = transport.taskNotificationSender.send(
            {
                idempotencyKey: fixtureIdempotencyKey,
                message: "Task Example was updated.",
                sessionKey: "agent:main:main",
            },
            controller.signal
        );
        const firstRequest = sentFrame(socket, 1);
        expect(firstRequest.params).toMatchObject({
            idempotencyKey: fixtureIdempotencyKey,
        });
        scheduler.advance(10_000);
        expect(await captureFailure(() => firstAttempt)).toEqual(
            new PersistentGatewayTimeoutError("chat.send")
        );

        const inFlightRetry = transport.taskNotificationSender.send(
            {
                idempotencyKey: fixtureIdempotencyKey,
                message: "Task Example was updated.",
                sessionKey: "agent:main:main",
            },
            controller.signal
        );
        const inFlightRequest = sentFrame(socket, 2);
        socket.receive({
            id: inFlightRequest.id,
            ok: true,
            payload: { runId: fixtureIdempotencyKey, status: "in_flight" },
            type: "res",
        });
        await inFlightRetry;

        const completedRetry = transport.taskNotificationSender.send(
            {
                idempotencyKey: fixtureIdempotencyKey,
                message: "Task Example was updated.",
                sessionKey: "agent:main:main",
            },
            controller.signal
        );
        const completedRequest = sentFrame(socket, 3);
        socket.receive({
            id: completedRequest.id,
            ok: true,
            payload: { runId: fixtureIdempotencyKey, status: "ok" },
            type: "res",
        });
        await completedRetry;

        const stopping = transport.stop();
        socket.finishClose();
        await stopping;
    });

    test("bounds admission, retires deadline ids, and reconnects after an unknown response", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler, {
            pendingRequestMaximum: 1,
            requestTimeoutMs: 20,
        });
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "web-read",
            methods: ["sessions.list"],
        });

        const first = transport.request("sessions.list", { limit: 1 });
        const firstFrame = sentFrame(socket, 1);
        expect(
            await captureFailure(() => transport.request("sessions.list", { limit: 2 }))
        ).toBeInstanceOf(PersistentGatewayCapacityError);
        scheduler.advance(20);
        expect(await captureFailure(() => first)).toEqual(
            new PersistentGatewayTimeoutError("sessions.list")
        );

        socket.receive({
            id: firstFrame.id,
            ok: true,
            payload: { sessions: [] },
            type: "res",
        });
        expect(socket.closeCalls).toHaveLength(0);
        expect(transport.snapshot.phase).toBe("connected");
        socket.receive({
            id: "never-issued-by-this-generation",
            ok: true,
            payload: { sessions: [] },
            type: "res",
        });
        expect(socket.closeCalls).toEqual([
            { code: 1008, reason: "unmatched gateway response" },
        ]);
        socket.finishClose();
        expect(transport.snapshot).toMatchObject({
            lastFailure: "protocol",
            phase: "degraded",
            reconnectAttempt: 1,
        });
        expect(transport.snapshot.nextReconnectAtMs).toBe(1120);

        await transport.stop();
        scheduler.advance(1000);
        expect(harness.sockets).toHaveLength(1);
    });

    test("guards generations, detects event gaps, jitters reconnects, and retains LKG", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const gaps: PersistentGatewayEventGap[] = [];
        transport.subscribe({ onEventGap: (gap) => gaps.push(gap) });
        transport.start();
        const firstSocket = harness.sockets[0];
        if (firstSocket === undefined) throw new Error("Expected the first socket");
        completeHandshake(firstSocket, {
            connectionId: "known-good-1",
            lane: "web-read",
            methods: ["sessions.list"],
        });
        firstSocket.receive({ event: "tick", seq: 1, type: "event" });
        firstSocket.receive({ event: "tick", seq: 3, type: "event" });

        expect(gaps).toEqual([
            {
                connectionGeneration: 1,
                expectedSequence: 2,
                receivedSequence: 3,
            },
        ]);
        expect(firstSocket.closeCalls).toEqual([
            { code: 1008, reason: "gateway event sequence gap" },
        ]);
        firstSocket.finishClose();
        expect(transport.snapshot).toMatchObject({
            lastFailure: "event-gap",
            lastKnownGood: { connectionId: "known-good-1" },
            nextReconnectAtMs: 1100,
            phase: "degraded",
            reconnectAttempt: 1,
        });

        scheduler.advance(99);
        expect(harness.sockets).toHaveLength(1);
        scheduler.advance(1);
        expect(harness.sockets).toHaveLength(2);
        expect(transport.snapshot).toMatchObject({
            connectionGeneration: 2,
            phase: "connecting",
        });

        firstSocket.receive({ event: "tick", seq: 4, type: "event" });
        expect(transport.snapshot.phase).toBe("connecting");
        const secondSocket = harness.sockets[1];
        if (secondSocket === undefined) throw new Error("Expected the second socket");
        completeHandshake(secondSocket, {
            connectionId: "known-good-2",
            lane: "web-read",
            methods: ["sessions.list"],
        });
        expect(transport.snapshot).toMatchObject({
            connectionGeneration: 2,
            lastKnownGood: { connectionId: "known-good-2" },
            phase: "connected",
            reconnectAttempt: 0,
        });

        await stopConnected(transport, secondSocket);
    });

    test("uses valid traffic for the negotiated tick watchdog and reconnects when silent", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "web-read",
            methods: ["sessions.list"],
            tickIntervalMs: 50,
        });

        scheduler.advance(90);
        socket.receive({ event: "tick", type: "event" });
        scheduler.advance(99);
        expect(socket.closeCalls).toHaveLength(0);
        scheduler.advance(1);
        expect(socket.closeCalls).toEqual([
            { code: 4000, reason: "gateway tick timeout" },
        ]);
        socket.finishClose();
        expect(transport.snapshot).toMatchObject({
            lastFailure: "tick-timeout",
            phase: "degraded",
            reconnectAttempt: 1,
        });

        await transport.stop();
    });

    test("graceful stop also owns and closes active one-shot admin lanes", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const admin = transport.requestAdmin("cron.run", { id: "cron-job-1" });
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");
        socket.open();

        const stopping = transport.stop();
        expect(transport.snapshot.phase).toBe("stopping");
        expect(socket.closeCalls).toEqual([
            { code: 1000, reason: "gateway lane complete" },
        ]);
        socket.finishClose();
        await stopping;
        expect(transport.snapshot.phase).toBe("stopped");
        expect(await captureFailure(() => admin)).toBeInstanceOf(
            PersistentGatewayUnavailableError
        );
        scheduler.advance(60_000);
        expect(harness.sockets).toHaveLength(1);
    });

    test("classifies terminal credential rejection without retrying or exposing detail", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        socket.open();
        socket.receive({
            event: "connect.challenge",
            payload: { nonce: "fixture-nonce" },
            type: "event",
        });
        const connect = sentFrame(socket, 0);
        socket.receive({
            error: {
                code: "INVALID_REQUEST",
                details: {
                    code: "AUTH_TOKEN_MISMATCH",
                    submittedCredential: fixtureToken,
                },
                message: `credential rejected: ${fixtureToken}`,
            },
            id: connect.id,
            ok: false,
            type: "res",
        });
        expect(socket.closeCalls).toEqual([
            { code: 1008, reason: "gateway connect rejected" },
        ]);
        socket.finishClose();
        expect(transport.snapshot).toMatchObject({
            lastFailure: "authentication",
            phase: "degraded",
        });
        expect(transport.snapshot.nextReconnectAtMs).toBeUndefined();
        expect(JSON.stringify(transport.snapshot)).not.toContain(fixtureToken);
        scheduler.advance(60_000);
        expect(harness.sockets).toHaveLength(1);
        await transport.stop();
    });

    test("runs each exact admin mutation on a fresh admin-only socket and waits for close", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler, {
            adminConcurrencyMaximum: 1,
        });
        const admin = transport.requestAdmin("cron.run", { id: "cron-job-1" });
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");

        const connect = completeHandshake(socket, {
            lane: "admin",
            methods: ["cron.run"],
        });
        expect(connect.params).toMatchObject({
            auth: { token: fixtureToken },
            scopes: ["operator.admin"],
        });
        const request = sentFrame(socket, 1);
        expect(request).toMatchObject({
            method: "cron.run",
            params: { id: "cron-job-1" },
        });
        expect(
            await captureFailure(() =>
                transport.requestAdmin("cron.run", { id: "cron-job-2" })
            )
        ).toBeInstanceOf(PersistentGatewayCapacityError);

        let settlement = "pending";
        void admin.then(
            () => {
                settlement = "resolved";
                return null;
            },
            () => {
                settlement = "rejected";
                return null;
            }
        );
        socket.receive({
            id: request.id,
            ok: true,
            payload: { accepted: true },
            type: "res",
        });
        await flushMicrotasks();
        expect(socket.closeCalls).toEqual([
            { code: 1000, reason: "gateway lane complete" },
        ]);
        expect(String(settlement)).toBe("pending");
        socket.finishClose();
        expect(await admin).toEqual({ accepted: true });
        expect(String(settlement)).toBe("resolved");

        const runtimeAdmin = transport.requestAdmin.bind(transport) as RuntimeRequest;
        expect(
            await captureFailure(() => runtimeAdmin("config.patch", { raw: true }))
        ).toBeInstanceOf(PersistentGatewayUnavailableError);
        expect(harness.sockets).toHaveLength(1);
        await transport.stop();
    });

    test("returns a confirmed admin ACK while retaining ownership until native close", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler, {
            adminConcurrencyMaximum: 1,
            gracefulStopTimeoutMs: 50,
        });
        const admin = transport.requestAdmin("cron.run", { id: "cron-job-1" });
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");
        completeHandshake(socket, { lane: "admin", methods: ["cron.run"] });
        const request = sentFrame(socket, 1);
        socket.receive({
            id: request.id,
            ok: true,
            payload: { accepted: true },
            type: "res",
        });
        await flushMicrotasks();
        expect(socket.closeCalls).toEqual([
            { code: 1000, reason: "gateway lane complete" },
        ]);

        scheduler.advance(50);
        expect(await admin).toEqual({ accepted: true });
        expect(
            await captureFailure(() =>
                transport.requestAdmin("cron.run", { id: "cron-job-2" })
            )
        ).toBeInstanceOf(PersistentGatewayCapacityError);
        expect(harness.sockets).toHaveLength(1);

        let stopSettlement = "pending";
        const stopping = transport.stop();
        void stopping.then(() => {
            stopSettlement = "resolved";
            return null;
        });
        await flushMicrotasks();
        expect(String(stopSettlement)).toBe("pending");
        socket.finishClose();
        await stopping;
        expect(String(stopSettlement)).toBe("resolved");
        expect(transport.snapshot.phase).toBe("stopped");
    });

    test("preserves an admin request error and releases its permit only on native close", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler, {
            adminConcurrencyMaximum: 1,
            gracefulStopTimeoutMs: 50,
        });
        const admin = transport.requestAdmin("cron.run", { id: "cron-job-1" });
        const capturedAdminFailure = captureFailure(() => admin);
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");
        completeHandshake(socket, { lane: "admin", methods: ["cron.run"] });
        const request = sentFrame(socket, 1);
        socket.receive({
            error: {
                code: "UNAVAILABLE",
                message: "fixture upstream failure",
                retryable: true,
            },
            id: request.id,
            ok: false,
            type: "res",
        });
        await flushMicrotasks();
        scheduler.advance(50);
        expect(await capturedAdminFailure).toEqual(
            new PersistentGatewayRequestError({
                code: "UNAVAILABLE",
                retryable: true,
            })
        );
        expect(
            await captureFailure(() =>
                transport.requestAdmin("cron.run", { id: "cron-job-2" })
            )
        ).toBeInstanceOf(PersistentGatewayCapacityError);

        socket.finishClose();
        const nextAdmin = transport.requestAdmin("cron.run", { id: "cron-job-2" });
        const capturedNextFailure = captureFailure(() => nextAdmin);
        expect(harness.sockets).toHaveLength(2);
        const nextSocket = harness.sockets[1];
        if (nextSocket === undefined) throw new Error("Expected replacement admin lane");
        const stopping = transport.stop();
        nextSocket.finishClose();
        await stopping;
        expect(await capturedNextFailure).toBeInstanceOf(
            PersistentGatewayUnavailableError
        );
    });

    test("keeps a pre-dispatch admin abort definitive", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const controller = new AbortController();
        const admin = transport.requestAdmin(
            "cron.run",
            { id: "cron-job-1" },
            { signal: controller.signal }
        );
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");

        controller.abort(new Error(`must not escape ${fixtureToken}`));
        socket.finishClose();
        const error = await captureFailure(() => admin);
        expect(error).toEqual(new PersistentGatewayAbortError());
        expect(String(error)).not.toContain(fixtureToken);
        await transport.stop();
    });

    test("classifies a post-dispatch admin abort as an unknown outcome", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const controller = new AbortController();
        const admin = transport.requestAdmin(
            "cron.run",
            { id: "cron-job-1" },
            { signal: controller.signal }
        );
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");
        completeHandshake(socket, {
            lane: "admin",
            methods: ["cron.run"],
        });

        controller.abort(new Error(`must not escape ${fixtureToken}`));
        expect(socket.closeCalls).toEqual([
            { code: 1000, reason: "gateway request aborted" },
        ]);
        socket.finishClose();
        const error = await captureFailure(() => admin);
        expect(error).toEqual(new PersistentGatewayUnknownOutcomeError());
        expect(String(error)).not.toContain(fixtureToken);
        await transport.stop();
    });

    test("classifies post-dispatch timeout, close, and malformed frames as unknown outcomes", async () => {
        for (const failure of ["timeout", "close", "malformed"] as const) {
            const scheduler = new ManualScheduler();
            const harness = new SocketHarness();
            const transport = createFixtureTransport(harness, scheduler);
            const admin = transport.requestAdmin("cron.run", { id: "cron-job-1" });
            const capturedFailure = captureFailure(() => admin);
            const socket = harness.sockets[0];
            if (socket === undefined) throw new Error("Expected one admin socket");
            completeHandshake(socket, { lane: "admin", methods: ["cron.run"] });
            expect(sentFrame(socket, 1).method).toBe("cron.run");

            if (failure === "timeout") {
                scheduler.advance(100);
                await flushMicrotasks();
                socket.finishClose();
            } else if (failure === "malformed") {
                socket.receiveRaw("{");
                socket.finishClose();
            } else {
                socket.finishClose();
            }

            expect(await capturedFailure).toEqual(
                new PersistentGatewayUnknownOutcomeError()
            );
            await transport.stop();
        }
    });

    test("sanitizes upstream errors and never exposes credentials in URL, state, or errors", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const admin = transport.requestAdmin("sessions.reset", {
            key: "agent:main:main",
        });
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");
        completeHandshake(socket, {
            lane: "admin",
            methods: ["sessions.reset"],
        });
        const request = sentFrame(socket, 1);
        socket.receive({
            error: {
                code: "UNAVAILABLE",
                details: { credential: fixtureToken, reason: "not-allowlisted" },
                message: `upstream included ${fixtureToken}`,
                retryable: true,
                retryAfterMs: 250,
            },
            id: request.id,
            ok: false,
            type: "res",
        });
        await flushMicrotasks();
        socket.finishClose();
        const error = await captureFailure(() => admin);
        expect(error).toEqual(
            new PersistentGatewayRequestError({
                code: "UNAVAILABLE",
                retryable: true,
                retryAfterMs: 250,
            })
        );
        expect(JSON.stringify(error)).not.toContain(fixtureToken);
        expect(String(error)).not.toContain(fixtureToken);
        expect(JSON.stringify(transport.snapshot)).not.toContain(fixtureToken);
        expect(harness.urls).toEqual(["ws://127.0.0.1:18789/"]);
        expect(harness.urls[0]).not.toContain(fixtureToken);
        await transport.stop();
    });

    test("preserves only the audited session-changed reason discriminant", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const admin = transport.requestAdmin("sessions.delete", {
            deleteTranscript: true,
            expectedSessionId: "session-generation-1",
            key: "agent:main:subagent:child",
        });
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");
        completeHandshake(socket, {
            lane: "admin",
            methods: ["sessions.delete"],
        });
        const request = sentFrame(socket, 1);
        socket.receive({
            error: {
                code: "INVALID_REQUEST",
                details: {
                    credential: fixtureToken,
                    reason: "session-changed",
                    raw: `must not escape ${fixtureToken}`,
                },
                message: `must not escape ${fixtureToken}`,
            },
            id: request.id,
            ok: false,
            type: "res",
        });
        await flushMicrotasks();
        socket.finishClose();

        const error = await captureFailure(() => admin);
        expect(error).toEqual(
            new PersistentGatewayRequestError({
                code: "INVALID_REQUEST",
                reason: "session-changed",
            })
        );
        expect(JSON.stringify(error)).not.toContain(fixtureToken);
        expect(String(error)).not.toContain(fixtureToken);
        await transport.stop();
    });

    test("canonicalizes only the audited cron definition conflict detail", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const admin = transport.requestAdmin("cron.update", {
            expectedConfigRevision: "definition-revision-1",
            id: "cron-job-1",
            patch: { enabled: false },
        });
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected one admin socket");
        completeHandshake(socket, {
            lane: "admin",
            methods: ["cron.update"],
        });
        const request = sentFrame(socket, 1);
        socket.receive({
            error: {
                code: "INVALID_REQUEST",
                details: {
                    actualConfigRevision: `must not escape ${fixtureToken}`,
                    code: "CRON_JOB_CHANGED",
                    expectedConfigRevision: "definition-revision-1",
                },
                message: `must not escape ${fixtureToken}`,
            },
            id: request.id,
            ok: false,
            type: "res",
        });
        await flushMicrotasks();
        socket.finishClose();

        const error = await captureFailure(() => admin);
        expect(error).toEqual(
            new PersistentGatewayRequestError({
                code: "INVALID_REQUEST",
                reason: persistentGatewayCronJobChangedReason,
            })
        );
        expect(JSON.stringify(error)).not.toContain(fixtureToken);
        expect(String(error)).not.toContain(fixtureToken);
        await transport.stop();
    });

    test("fails closed on binary and oversized pre-auth frames without reconnecting", async () => {
        for (const frame of [new Uint8Array([1, 2, 3]), "x".repeat(4 * 1024 + 1)]) {
            const scheduler = new ManualScheduler();
            const harness = new SocketHarness();
            const transport = createFixtureTransport(harness, scheduler);
            transport.start();
            const socket = harness.sockets[0];
            if (socket === undefined) throw new Error("Expected the persistent socket");
            socket.open();
            socket.receiveRaw(frame);
            expect(socket.closeCalls).toEqual([
                { code: 1008, reason: "invalid gateway frame" },
            ]);
            socket.finishClose();
            expect(transport.snapshot).toMatchObject({
                lastFailure: "protocol",
                nextReconnectAtMs: undefined,
                phase: "degraded",
            });
            scheduler.advance(60_000);
            expect(harness.sockets).toHaveLength(1);
            await transport.stop();
        }
    });

    test("honors negotiated payload bounds and aborts individual pending requests", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "web-read",
            maxBufferedBytes: 1024,
            maxPayload: 1024,
            methods: ["sessions.list", "sessions.send"],
        });

        expect(
            await captureFailure(() =>
                transport.request("sessions.list", {
                    limit: 1,
                    padding: "x".repeat(2000),
                })
            )
        ).toBeInstanceOf(PersistentGatewayCapacityError);
        expect(transport.snapshot.phase).toBe("connected");

        const controller = new AbortController();
        const pending = transport.request(
            "sessions.list",
            { limit: 1 },
            { signal: controller.signal }
        );
        controller.abort();
        expect(await captureFailure(() => pending)).toEqual(
            new PersistentGatewayAbortError()
        );
        expect(transport.snapshot.phase).toBe("connected");

        await stopConnected(transport, socket);
    });

    test("graceful stop rejects pending work, waits for native close, and never reconnects", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        transport.start();
        const socket = harness.sockets[0];
        if (socket === undefined) throw new Error("Expected the persistent socket");
        completeHandshake(socket, {
            lane: "web-read",
            methods: ["sessions.list"],
        });
        const pending = transport.request("sessions.list", { limit: 1 });

        let settlement = "pending";
        const stopping = transport.stop();
        void stopping.then(
            () => {
                settlement = "resolved";
                return null;
            },
            () => {
                settlement = "rejected";
                return null;
            }
        );
        expect(transport.snapshot.phase).toBe("stopping");
        expect(socket.closeCalls).toEqual([
            { code: 1000, reason: "gateway lane complete" },
        ]);
        expect(await captureFailure(() => pending)).toBeInstanceOf(
            PersistentGatewayUnavailableError
        );
        await flushMicrotasks();
        expect(String(settlement)).toBe("pending");

        socket.finishClose();
        await stopping;
        expect(String(settlement)).toBe("resolved");
        expect(transport.snapshot.phase).toBe("stopped");
        expect(transport.stop()).toBe(stopping);
        scheduler.advance(60_000);
        expect(harness.sockets).toHaveLength(1);
        expect(() => transport.start()).toThrow(TypeError);
    });

    test("keeps the public generic method unions narrow at runtime", async () => {
        const scheduler = new ManualScheduler();
        const harness = new SocketHarness();
        const transport = createFixtureTransport(harness, scheduler);
        const runtimeReadWrite = transport.request.bind(transport) as RuntimeRequest;
        const runtimeAdmin = transport.requestAdmin.bind(transport) as (
            method: string,
            parameters: Readonly<Record<string, unknown>>,
            options?: PersistentGatewayRequestOptions
        ) => Promise<unknown>;

        for (const method of [
            "config.get",
            "config.patch",
            "cron.add",
            "exec.approvals.set",
            "sessions.branches.switch",
            "sessions.compaction.restore",
            "sessions.create",
            "sessions.dispatch",
            "sessions.patch",
            "sessions.reclaim",
            "sessions.rewind",
        ]) {
            expect(
                await captureFailure(() => runtimeReadWrite(method, {}))
            ).toBeInstanceOf(PersistentGatewayUnavailableError);
            expect(await captureFailure(() => runtimeAdmin(method, {}))).toBeInstanceOf(
                PersistentGatewayUnavailableError
            );
        }
        expect(harness.sockets).toHaveLength(0);
        await transport.stop();
    });

    test("binds start and stop to a service-free Effect layer scope", async () => {
        const calls: string[] = [];
        const transport: PersistentGatewayTransport = {
            request: () => Promise.reject(new PersistentGatewayUnavailableError()),
            requestAdmin: () => Promise.reject(new PersistentGatewayUnavailableError()),
            snapshot: {
                connectionGeneration: 0,
                phase: "stopped",
                reconnectAttempt: 0,
            },
            start: () => {
                calls.push("start");
            },
            stop: () => {
                calls.push("stop");
                return Promise.resolve();
            },
            subscribe: () => () => {},
        };

        await Effect.runPromise(
            Effect.scoped(
                Layer.build(persistentGatewayTransportLifecycleLayer(transport))
            )
        );
        expect(calls).toEqual(["start", "stop"]);
    });
});

// Compile-time locks: callers cannot widen either generic lane without editing protocol types.
const _readWriteMethod: PersistentGatewayReadWriteMethod = "sessions.list";
const _adminMethod: PersistentGatewayAdminMethod = "cron.run";
void _readWriteMethod;
void _adminMethod;
