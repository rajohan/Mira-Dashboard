import { Data, Deferred, Effect, Scope } from "effect";

import {
    createScenarioBytes,
    decodeClientFrames,
    encodeServerFrame,
    maximumRawWebSocketHandshakeBytes,
    maximumRawWebSocketPeerBytes,
    parseUpgradeRequest,
    type RawWebSocketScenario,
} from "./rawWebSocketProtocol.ts";

export class RawWebSocketFixtureError extends Data.TaggedError(
    "RawWebSocketFixtureError"
)<{
    readonly cause?: unknown;
    readonly operation: string;
}> {}

interface FixtureSharedState {
    acceptedConnections: number;
    activeConnections: number;
    closedConnections: number;
    drainCount: number;
    failure: string | undefined;
    peerCloseCode: number | undefined;
    sentBytes: number;
    writeAttempts: number;
}

interface FixtureSocketState {
    readonly shared: FixtureSharedState;
    closed: boolean;
    handshakeBytes: Buffer;
    inboundFrames: Buffer;
    outboundBytes: Buffer;
    outboundOffset: number;
    peerPongDeferred: Deferred.Deferred<void>;
    serverCloseSent: boolean;
    upgradeResponseBytes: number;
    upgradedDeferred: Deferred.Deferred<void>;
    upgradedNotified: boolean;
    upgraded: boolean;
}

export interface RawWebSocketFixture {
    readonly acceptedConnections: number;
    readonly activeConnections: number;
    readonly awaitAccepted: Effect.Effect<void>;
    readonly awaitClosed: Effect.Effect<void>;
    readonly awaitPeerPong: Effect.Effect<void>;
    readonly awaitUpgraded: Effect.Effect<void>;
    readonly closedConnections: number;
    readonly drainCount: number;
    readonly failure: string | undefined;
    readonly peerCloseCode: number | undefined;
    readonly sentBytes: number;
    readonly url: string;
    readonly writeAttempts: number;
}

function createSocketState(
    shared: FixtureSharedState,
    peerPongDeferred: Deferred.Deferred<void>,
    upgradedDeferred: Deferred.Deferred<void>
): FixtureSocketState {
    return {
        closed: false,
        handshakeBytes: Buffer.alloc(0),
        inboundFrames: Buffer.alloc(0),
        outboundBytes: Buffer.alloc(0),
        outboundOffset: 0,
        peerPongDeferred,
        serverCloseSent: false,
        shared,
        upgradeResponseBytes: 0,
        upgradedDeferred,
        upgradedNotified: false,
        upgraded: false,
    };
}

function scenarioSendsClose(scenario: RawWebSocketScenario): boolean {
    return scenario === "close-before-message" || scenario === "message-then-close";
}

function recordFixtureFailure(
    socket: Bun.Socket<FixtureSocketState>,
    cause: unknown
): void {
    socket.data.shared.failure =
        cause instanceof Error ? cause.message : "Unknown WebSocket fixture failure";
    socket.terminate();
}

function writePending(socket: Bun.Socket<FixtureSocketState>): void {
    const state = socket.data;
    if (state.closed || socket.readyState <= 0) return;
    while (state.outboundOffset < state.outboundBytes.byteLength) {
        state.shared.writeAttempts += 1;
        const written = socket.write(
            state.outboundBytes,
            state.outboundOffset,
            state.outboundBytes.byteLength - state.outboundOffset
        );
        if (written < 0) return;
        if (written === 0) return;
        state.outboundOffset += written;
        state.shared.sentBytes += written;
        if (
            !state.upgradedNotified &&
            state.outboundOffset >= state.upgradeResponseBytes
        ) {
            state.upgradedNotified = true;
            Deferred.doneUnsafe(state.upgradedDeferred, Effect.void);
        }
    }
    socket.flush();
}

function decodePeerCloseCode(payload: Buffer): number | undefined {
    if (payload.byteLength === 0) return undefined;
    if (payload.byteLength === 1) {
        throw new Error("Raw WebSocket fixture received a one-byte close payload");
    }
    return payload.readUInt16BE(0);
}

function handlePeerFrames(socket: Bun.Socket<FixtureSocketState>, bytes: Buffer): void {
    const state = socket.data;
    if (
        state.inboundFrames.byteLength + bytes.byteLength >
        maximumRawWebSocketPeerBytes
    ) {
        throw new Error("Raw WebSocket fixture peer stream exceeded its byte budget");
    }
    state.inboundFrames = Buffer.concat([state.inboundFrames, bytes]);
    const decoded = decodeClientFrames(state.inboundFrames);
    state.inboundFrames = decoded.remaining;
    for (const frame of decoded.frames) {
        if (frame.opcode === 0x08) {
            state.shared.peerCloseCode ??= decodePeerCloseCode(frame.payload);
            if (state.serverCloseSent) {
                socket.end();
            } else {
                state.serverCloseSent = true;
                socket.end(encodeServerFrame(0x08, frame.payload));
            }
            return;
        }
        if (frame.opcode === 0x09 && frame.fin) {
            socket.write(encodeServerFrame(10, frame.payload));
        }
        if (frame.opcode === 10 && frame.fin) {
            Deferred.doneUnsafe(state.peerPongDeferred, Effect.void);
        }
    }
}

/**
 * Starts one raw loopback TCP server that performs a bounded RFC 6455 handshake.
 * Listener and accepted-socket ownership end with the enclosing Effect scope.
 * @param scenario Raw frame sequence sent after a successful native upgrade.
 * @returns Scoped fixture state and coordination effects.
 */
export function rawWebSocketFixtureResource(
    scenario: RawWebSocketScenario
): Effect.Effect<RawWebSocketFixture, RawWebSocketFixtureError, Scope.Scope> {
    return Effect.gen(function* () {
        const accepted = yield* Deferred.make<void>();
        const upgraded = yield* Deferred.make<void>();
        const peerPong = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const shared: FixtureSharedState = {
            acceptedConnections: 0,
            activeConnections: 0,
            closedConnections: 0,
            drainCount: 0,
            failure: undefined,
            peerCloseCode: undefined,
            sentBytes: 0,
            writeAttempts: 0,
        };
        const listener = yield* Effect.acquireRelease(
            Effect.try({
                catch: (cause) =>
                    new RawWebSocketFixtureError({
                        cause,
                        operation: "start-listener",
                    }),
                try: () =>
                    Bun.listen<FixtureSocketState>({
                        data: createSocketState(shared, peerPong, upgraded),
                        hostname: "127.0.0.1",
                        port: 0,
                        socket: {
                            binaryType: "buffer",
                            close(socket) {
                                const state = socket.data;
                                if (state.closed) return;
                                state.closed = true;
                                state.shared.activeConnections -= 1;
                                state.shared.closedConnections += 1;
                                Deferred.doneUnsafe(closed, Effect.void);
                            },
                            data(socket, bytes) {
                                try {
                                    const state = socket.data;
                                    if (state.upgraded) {
                                        handlePeerFrames(socket, bytes);
                                        return;
                                    }
                                    if (
                                        state.handshakeBytes.byteLength +
                                            bytes.byteLength >
                                        maximumRawWebSocketHandshakeBytes
                                    ) {
                                        throw new Error(
                                            "Raw WebSocket fixture handshake exceeded its byte budget"
                                        );
                                    }
                                    state.handshakeBytes = Buffer.concat([
                                        state.handshakeBytes,
                                        bytes,
                                    ]);
                                    const upgrade = parseUpgradeRequest(
                                        state.handshakeBytes
                                    );
                                    if (upgrade === undefined) return;
                                    state.upgraded = true;
                                    state.serverCloseSent = scenarioSendsClose(scenario);
                                    state.outboundBytes = Buffer.concat([
                                        upgrade.response,
                                        createScenarioBytes(scenario),
                                    ]);
                                    state.upgradeResponseBytes =
                                        upgrade.response.byteLength;
                                    state.handshakeBytes = Buffer.alloc(0);
                                    writePending(socket);
                                    if (upgrade.remaining.byteLength > 0) {
                                        handlePeerFrames(socket, upgrade.remaining);
                                    }
                                } catch (error) {
                                    recordFixtureFailure(socket, error);
                                }
                            },
                            drain(socket) {
                                socket.data.shared.drainCount += 1;
                                try {
                                    writePending(socket);
                                } catch (error) {
                                    recordFixtureFailure(socket, error);
                                }
                            },
                            error(socket, error) {
                                recordFixtureFailure(socket, error);
                            },
                            open(socket) {
                                socket.data = createSocketState(
                                    shared,
                                    peerPong,
                                    upgraded
                                );
                                socket.data.shared.acceptedConnections += 1;
                                socket.data.shared.activeConnections += 1;
                                Deferred.doneUnsafe(accepted, Effect.void);
                            },
                        },
                    }),
            }),
            (ownedListener) =>
                Effect.sync(() => {
                    ownedListener.stop(true);
                })
        );
        return Object.freeze({
            awaitAccepted: Deferred.await(accepted),
            awaitClosed: Deferred.await(closed),
            awaitPeerPong: Deferred.await(peerPong),
            awaitUpgraded: Deferred.await(upgraded),
            url: `ws://127.0.0.1:${listener.port}/qualification`,
            get acceptedConnections() {
                return shared.acceptedConnections;
            },
            get activeConnections() {
                return shared.activeConnections;
            },
            get closedConnections() {
                return shared.closedConnections;
            },
            get drainCount() {
                return shared.drainCount;
            },
            get failure() {
                return shared.failure;
            },
            get peerCloseCode() {
                return shared.peerCloseCode;
            },
            get sentBytes() {
                return shared.sentBytes;
            },
            get writeAttempts() {
                return shared.writeAttempts;
            },
        });
    });
}
