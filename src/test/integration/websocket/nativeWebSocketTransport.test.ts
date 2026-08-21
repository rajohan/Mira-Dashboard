import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Fiber, Result } from "effect";

import {
    closedLoopbackWebSocketUrl,
    maximumNativeWebSocketMessageBytes,
    NativeWebSocketCloseError,
    NativeWebSocketClosedError,
    NativeWebSocketMessageLimitError,
    observeNativeWebSocket,
    withNativeWebSocketDeadline,
    type NativeWebSocketObservationError,
} from "./nativeWebSocketTransport.ts";
import { rawWebSocketFixtureResource } from "./rawWebSocketFixture.ts";
import {
    createFragmentedUtf8Evidence,
    fragmentedUtf8Message,
    maximumRawWebSocketFixtureOutboundBytes,
    oversizedScenarioMessageBytes,
    type RawWebSocketScenario,
} from "./rawWebSocketProtocol.ts";

interface RejectedScenarioEvidence {
    readonly activeConnections: number;
    readonly error: NativeWebSocketObservationError;
    readonly failure: string | undefined;
    readonly peerCloseCode: number | undefined;
}

interface NonCooperatingCloseFixture {
    readonly activeConnections: number;
    readonly closeAttempts: number;
    readonly factory: (url: string) => WebSocket;
    readonly terminationAttempts: number;
}

function createNonCooperatingCloseFixture(): NonCooperatingCloseFixture {
    let activeConnections = 0;
    let closeAttempts = 0;
    let terminationAttempts = 0;

    class NonCooperatingWebSocket extends EventTarget {
        readonly bufferedAmount = 0;
        private state: number = WebSocket.OPEN;

        get readyState(): number {
            return this.state;
        }

        constructor() {
            super();
            activeConnections += 1;
            queueMicrotask(() => {
                this.dispatchEvent(new Event("open"));
                this.dispatchEvent(
                    new MessageEvent("message", {
                        data: "close timeout evidence",
                    })
                );
            });
        }

        close(): void {
            closeAttempts += 1;
        }

        terminate(): void {
            terminationAttempts += 1;
            if (this.state === WebSocket.CLOSED) return;
            this.state = WebSocket.CLOSED;
            activeConnections -= 1;
            this.dispatchEvent(
                new CloseEvent("close", {
                    code: 1006,
                    reason: "fixture terminated",
                    wasClean: false,
                })
            );
        }
    }

    return {
        factory: (url) => {
            void url;
            return new NonCooperatingWebSocket() as unknown as WebSocket;
        },
        get activeConnections() {
            return activeConnections;
        },
        get closeAttempts() {
            return closeAttempts;
        },
        get terminationAttempts() {
            return terminationAttempts;
        },
    };
}

async function runRejectedScenario(
    scenario: RawWebSocketScenario
): Promise<RejectedScenarioEvidence> {
    return Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixture = yield* rawWebSocketFixtureResource(scenario);
                const outcome = yield* observeNativeWebSocket(fixture.url).pipe(
                    Effect.result
                );
                yield* withNativeWebSocketDeadline(
                    fixture.awaitClosed,
                    `await-${scenario}-close`
                );
                if (Result.isSuccess(outcome)) {
                    return yield* Effect.die(
                        new Error(`${scenario} unexpectedly delivered a message`)
                    );
                }
                return {
                    activeConnections: fixture.activeConnections,
                    error: outcome.failure,
                    failure: fixture.failure,
                    peerCloseCode: fixture.peerCloseCode,
                };
            })
        )
    );
}

describe("Bun native WebSocket RFC 6455 integration", () => {
    test("reassembles continuation frames with a UTF-8 code point split across payloads", async () => {
        const split = createFragmentedUtf8Evidence();
        expect(Buffer.concat(split.fragments).equals(split.completeBytes)).toBe(true);
        expect(split.splitCodePointBytes).toEqual(Buffer.from("🦀", "utf8"));
        const decoder = new TextDecoder("utf-8", { fatal: true });
        expect(() => decoder.decode(split.fragments[0])).toThrow();
        expect(() => decoder.decode(split.fragments[1])).toThrow();
        expect(() => decoder.decode(split.fragments[2])).toThrow();

        const evidence = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const fixture = yield* rawWebSocketFixtureResource("fragmented-utf8");
                    const observation = yield* observeNativeWebSocket(fixture.url);
                    yield* withNativeWebSocketDeadline(
                        fixture.awaitClosed,
                        "await-fragmented-close"
                    );
                    return {
                        activeConnections: fixture.activeConnections,
                        acceptedConnections: fixture.acceptedConnections,
                        failure: fixture.failure,
                        observation,
                        peerCloseCode: fixture.peerCloseCode,
                        runtime: {
                            revision: Bun.revision,
                            version: Bun.version,
                        },
                        sentBytes: fixture.sentBytes,
                        writeAttempts: fixture.writeAttempts,
                    };
                })
            )
        );

        expect(evidence).toMatchObject({
            acceptedConnections: 1,
            activeConnections: 0,
            failure: undefined,
            observation: {
                bufferedAmount: 0,
                eventCounts: {
                    closes: 0,
                    errors: 0,
                    messages: 1,
                    opens: 1,
                },
                message: fragmentedUtf8Message,
                messageBytes: Buffer.byteLength(fragmentedUtf8Message, "utf8"),
            },
            peerCloseCode: 1000,
        });
        expect(evidence.runtime.revision).toMatch(/^[a-f\d]{40}$/u);
        expect(evidence.runtime.version).toMatch(/^1\.4\.0/u);
        expect(evidence.sentBytes).toBeGreaterThan(split.completeBytes.byteLength);
        expect(evidence.sentBytes).toBeLessThan(maximumRawWebSocketFixtureOutboundBytes);
        expect(evidence.writeAttempts).toBeGreaterThanOrEqual(1);
    });

    test("rejects orphan and interleaved continuation sequences without a message", async () => {
        for (const scenario of [
            "orphan-continuation",
            "interleaved-text-fragments",
        ] as const) {
            const evidence = await runRejectedScenario(scenario);
            expect(evidence.error).toBeInstanceOf(NativeWebSocketClosedError);
            if (!(evidence.error instanceof NativeWebSocketClosedError)) continue;
            expect(evidence.error.eventCounts).toMatchObject({
                closes: 1,
                errors: 0,
                messages: 0,
                opens: 1,
            });
            expect(evidence.error).toMatchObject({
                code: 1002,
                reason: "Protocol error - unexpected opcode",
                wasClean: false,
            });
            expect(evidence.activeConnections).toBe(0);
            expect(evidence.failure).toBeUndefined();
        }
    });

    test("rejects an invalid oversized 64-bit frame declaration before allocation", async () => {
        const evidence = await runRejectedScenario("invalid-64-bit-length");
        expect(evidence.error).toBeInstanceOf(NativeWebSocketClosedError);
        if (!(evidence.error instanceof NativeWebSocketClosedError)) return;
        expect(evidence.error.eventCounts).toMatchObject({
            closes: 1,
            errors: 0,
            messages: 0,
            opens: 1,
        });
        expect(evidence.error).toMatchObject({
            code: 1009,
            reason: "Message too big",
            wasClean: false,
        });
        expect(evidence.activeConnections).toBe(0);
        expect(evidence.failure).toBeUndefined();
    });

    test("bounds an otherwise valid assembled native text message and closes with 1009", async () => {
        const evidence = await runRejectedScenario("oversized-text");
        expect(evidence.error).toBeInstanceOf(NativeWebSocketMessageLimitError);
        if (!(evidence.error instanceof NativeWebSocketMessageLimitError)) return;
        expect(evidence.error).toMatchObject({
            actualBytes: oversizedScenarioMessageBytes,
            eventCounts: {
                closes: 0,
                errors: 0,
                messages: 1,
                opens: 1,
            },
            maximumBytes: maximumNativeWebSocketMessageBytes,
        });
        expect(evidence.peerCloseCode).toBe(1009);
        expect(evidence.activeConnections).toBe(0);
        expect(evidence.failure).toBeUndefined();
    });

    test("normalizes a clean peer close before any message", async () => {
        const evidence = await runRejectedScenario("close-before-message");
        expect(evidence.error).toBeInstanceOf(NativeWebSocketClosedError);
        if (!(evidence.error instanceof NativeWebSocketClosedError)) return;
        expect(evidence.error).toMatchObject({
            code: 1000,
            eventCounts: {
                closes: 1,
                errors: 0,
                messages: 0,
                opens: 1,
            },
            reason: "fixture complete",
            wasClean: true,
        });
        expect(evidence.peerCloseCode).toBe(1000);
        expect(evidence.failure).toBeUndefined();
    });

    test("keeps the first complete message as the outcome when close follows immediately", async () => {
        const evidence = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const fixture =
                        yield* rawWebSocketFixtureResource("message-then-close");
                    const observation = yield* observeNativeWebSocket(fixture.url);
                    yield* withNativeWebSocketDeadline(
                        fixture.awaitClosed,
                        "await-first-outcome-close"
                    );
                    return {
                        activeConnections: fixture.activeConnections,
                        failure: fixture.failure,
                        observation,
                        peerCloseCode: fixture.peerCloseCode,
                    };
                })
            )
        );
        expect(evidence).toEqual({
            activeConnections: 0,
            failure: undefined,
            observation: {
                bufferedAmount: 0,
                eventCounts: {
                    closes: 0,
                    errors: 0,
                    messages: 1,
                    opens: 1,
                },
                message: "first outcome wins",
                messageBytes: 18,
            },
            peerCloseCode: 1000,
        });
    });

    test("interrupts a silent native socket and releases the scoped TCP connection", async () => {
        const evidence = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const fixture = yield* rawWebSocketFixtureResource("silent");
                    const fiber = yield* observeNativeWebSocket(fixture.url).pipe(
                        Effect.forkChild
                    );
                    yield* withNativeWebSocketDeadline(
                        fixture.awaitPeerPong,
                        "await-silent-pong"
                    );
                    yield* Fiber.interrupt(fiber);
                    yield* withNativeWebSocketDeadline(
                        fixture.awaitClosed,
                        "await-interrupted-close"
                    );
                    return {
                        acceptedConnections: fixture.acceptedConnections,
                        activeConnections: fixture.activeConnections,
                        closedConnections: fixture.closedConnections,
                        failure: fixture.failure,
                        peerCloseCode: fixture.peerCloseCode,
                    };
                })
            )
        );
        expect(evidence).toEqual({
            acceptedConnections: 1,
            activeConnections: 0,
            closedConnections: 1,
            failure: undefined,
            peerCloseCode: 1000,
        });
    });

    test("reports a scenario failure when scoped native close does not cooperate", async () => {
        const fixture = createNonCooperatingCloseFixture();
        const exit = await Effect.runPromiseExit(
            observeNativeWebSocket("ws://127.0.0.1/integration", fixture.factory)
        );

        expect(Exit.isFailure(exit)).toBeTrue();
        if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons.find(Cause.isFailReason);
            expect(failure?.error).toBeInstanceOf(NativeWebSocketCloseError);
            expect(failure?.error).toMatchObject({
                operation: "await-graceful-close",
                readyState: WebSocket.OPEN,
            });
        }
        expect(fixture).toMatchObject({
            activeConnections: 0,
            closeAttempts: 1,
            terminationAttempts: 1,
        });
    });

    test("fails one native connection refusal and never reconnects", async () => {
        const evidence = await Effect.runPromise(
            Effect.gen(function* () {
                const url = yield* closedLoopbackWebSocketUrl();
                let attempts = 0;
                const outcome = yield* observeNativeWebSocket(url, (target) => {
                    attempts += 1;
                    return new WebSocket(target);
                }).pipe(Effect.result);
                yield* Effect.yieldNow;
                if (Result.isSuccess(outcome)) {
                    return yield* Effect.die(
                        new Error("Connection refusal unexpectedly delivered a message")
                    );
                }
                return { attempts, error: outcome.failure };
            })
        );
        expect(evidence.attempts).toBe(1);
        expect(evidence.error).toBeInstanceOf(NativeWebSocketClosedError);
        if (!(evidence.error instanceof NativeWebSocketClosedError)) return;
        expect(evidence.error.eventCounts).toMatchObject({
            closes: 1,
            errors: 1,
            messages: 0,
            opens: 0,
        });
    });
});
