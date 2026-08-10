import * as v from "valibot";

import {
    terminalClientMessageMaximumBytes,
    terminalSocketBufferedMaximumBytes,
    type TerminalDimensions,
    terminalSessionSummarySchema,
    type TerminalSessionSummary,
} from "../../../contracts/terminal.ts";
import { type JsonObject } from "../../../shared/json.ts";
import {
    encodeTerminalBrokerControl,
    encodeTerminalBrokerInput,
    TerminalBrokerFrameDecoder,
    TerminalBrokerProtocolError,
} from "../../../shared/terminalBrokerProtocol.ts";
import {
    TerminalSessionBrokerError,
    type TerminalSessionBroker,
    type TerminalSessionOwner,
} from "../../domains/terminal/brokerPort.ts";

const brokerFailureReasons = [
    "capacity",
    "conflict",
    "gone",
    "not-found",
    "unavailable",
] as const;
const responseSchema = v.variant("type", [
    v.strictObject({
        reason: v.picklist(brokerFailureReasons),
        requestId: v.string(),
        type: v.literal("failure"),
    }),
    v.strictObject({
        requestId: v.string(),
        type: v.literal("result"),
        value: v.unknown(),
    }),
]);

export interface TerminalBrokerClientTransport {
    connect(signal?: AbortSignal): Promise<TerminalBrokerClientChannel>;
    request(frame: Uint8Array, signal?: AbortSignal): Promise<readonly Uint8Array[]>;
}

export interface TerminalBrokerClientChannel {
    close(): void;
    pause(): void;
    resume(): void;
    send(data: Uint8Array): "accepted" | "backpressured" | "closed";
    setHandlers(handlers: {
        readonly onClose: () => void;
        readonly onData: (data: Uint8Array) => void;
        readonly onDrain: () => void;
    }): void;
}

export type TerminalBrokerRelayControl =
    | Readonly<{
          replayAvailableFromSequence: number;
          resumed: boolean;
          session: TerminalSessionSummary;
          type: "ready";
      }>
    | Readonly<{ type: "input-drain" }>
    | Readonly<{
          exitCode: number;
          reason:
              | "disconnected"
              | "exited"
              | "idle-timeout"
              | "operator"
              | "runtime-limit";
          signalCode: string | null;
          type: "exit";
      }>
    | Readonly<{
          acceptedBytes: number;
          status: "accepted" | "backpressured" | "closed";
          type: "input-status";
      }>
    | Readonly<{
          reason: "backpressure" | "idle-timeout" | "operator" | "runtime-limit";
          type: "closed";
      }>;

export interface TerminalBrokerRelayCallbacks {
    readonly onClose: () => void;
    readonly onControl: (event: TerminalBrokerRelayControl) => void;
    readonly onInputDrain: () => void;
    readonly onOutput: (
        sequence: number,
        data: Uint8Array
    ) => "accepted" | "backpressured";
}

export interface TerminalBrokerRelay {
    detach(): void;
    input(data: Uint8Array): "accepted" | "backpressured" | "closed";
    ping(): "accepted" | "backpressured" | "closed";
    resize(dimensions: TerminalDimensions): "accepted" | "backpressured" | "closed";
    resumeOutput(): void;
    signal(
        signal: "SIGHUP" | "SIGINT" | "SIGTERM"
    ): "accepted" | "backpressured" | "closed";
    terminate(): void;
}

export interface InteractiveTerminalBrokerClient extends TerminalSessionBroker {
    attach(input: {
        readonly callbacks: TerminalBrokerRelayCallbacks;
        readonly connectionToken: string;
        readonly owner: TerminalSessionOwner;
        readonly sessionId: string;
        readonly signal?: AbortSignal;
    }): Promise<TerminalBrokerRelay>;
}

export interface TerminalBrokerClientDependencies {
    readonly generateRequestId?: () => string;
    readonly transport: TerminalBrokerClientTransport;
}

function control(value: unknown): Uint8Array {
    return encodeTerminalBrokerControl(value as JsonObject);
}

function brokerFailure(error: unknown): TerminalSessionBrokerError {
    return error instanceof TerminalSessionBrokerError
        ? error
        : new TerminalSessionBrokerError("unavailable");
}

function decodeResponse(
    chunks: readonly Uint8Array[],
    expectedRequestId: string
): unknown {
    const decoder = new TerminalBrokerFrameDecoder();
    const frames = chunks.flatMap((chunk) => decoder.push(chunk));
    decoder.finish();
    if (frames.length !== 1 || frames[0]?.kind !== "control") {
        throw new TerminalBrokerProtocolError();
    }
    const response = v.parse(responseSchema, frames[0].message);
    if (response.requestId !== expectedRequestId) {
        throw new TerminalBrokerProtocolError();
    }
    if (response.type === "failure") {
        throw new TerminalSessionBrokerError(response.reason);
    }
    return response.value;
}

function parseControlEvent(message: JsonObject): TerminalBrokerRelayControl {
    const type = message.type;
    if (type === "ready") {
        return Object.freeze({
            replayAvailableFromSequence: v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
                message.replayAvailableFromSequence
            ),
            resumed: v.parse(v.boolean(), message.resumed),
            session: v.parse(terminalSessionSummarySchema, message.session),
            type,
        });
    }
    if (type === "input-drain") return Object.freeze({ type });
    if (type === "exit") {
        return Object.freeze({
            exitCode: v.parse(v.pipe(v.number(), v.safeInteger()), message.exitCode),
            reason: v.parse(
                v.picklist([
                    "disconnected",
                    "exited",
                    "idle-timeout",
                    "operator",
                    "runtime-limit",
                ]),
                message.reason
            ),
            signalCode: v.parse(v.nullable(v.string()), message.signalCode),
            type,
        });
    }
    if (type === "input-status") {
        return Object.freeze({
            acceptedBytes: v.parse(
                v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
                message.acceptedBytes
            ),
            status: v.parse(
                v.picklist(["accepted", "backpressured", "closed"]),
                message.status
            ),
            type,
        });
    }
    if (type === "closed") {
        return Object.freeze({
            reason: v.parse(
                v.picklist(["backpressure", "idle-timeout", "operator", "runtime-limit"]),
                message.reason
            ),
            type,
        });
    }
    throw new TerminalBrokerProtocolError();
}

/**
 * Creates the web-process client for lifecycle RPC and attached PTY relay IPC.
 * @param dependencies Request ID and injected byte transport boundaries.
 * @returns Web-process lifecycle client and attach relay.
 */
export function createTerminalBrokerClient(
    dependencies: TerminalBrokerClientDependencies
): InteractiveTerminalBrokerClient {
    const generateRequestId =
        dependencies.generateRequestId ?? (() => Bun.randomUUIDv7());

    async function request(
        type: "get-active" | "prepare-resume" | "reserve" | "terminate",
        body: Readonly<Record<string, unknown>>,
        signal?: AbortSignal
    ): Promise<unknown> {
        if (signal?.aborted) throw brokerFailure(signal.reason);
        const requestId = generateRequestId();
        try {
            const chunks = await dependencies.transport.request(
                control({ ...body, requestId, type }),
                signal
            );
            return decodeResponse(chunks, requestId);
        } catch (error) {
            throw brokerFailure(error);
        }
    }

    const client: InteractiveTerminalBrokerClient = {
        async attach(input) {
            const abortSignal = input.signal;
            const callbacks = input.callbacks;
            const owner = input.owner;
            const sessionId = input.sessionId;
            if (abortSignal?.aborted) throw brokerFailure(abortSignal.reason);
            const channel = await dependencies.transport
                .connect(abortSignal)
                .catch((error: unknown) => {
                    throw brokerFailure(error);
                });
            const decoder = new TerminalBrokerFrameDecoder();
            let closed = false;
            const pendingInputAcknowledgements: Array<{
                readonly bytes: number;
                readonly causedTransportBackpressure: boolean;
            }> = [];
            let pendingInputAcknowledgementBytes = 0;
            let pendingTransportBackpressureAcknowledgements = 0;
            let transportInputBackpressured = false;
            let ptyInputBackpressured = false;
            let inputDrainNeeded = false;
            let resolveReady: (() => void) | undefined;
            let rejectReady: ((error: TerminalSessionBrokerError) => void) | undefined;
            const ready = new Promise<void>((resolve, reject) => {
                resolveReady = resolve;
                rejectReady = reject;
            });
            const close = (): void => {
                if (closed) return;
                closed = true;
                pendingInputAcknowledgements.length = 0;
                pendingInputAcknowledgementBytes = 0;
                pendingTransportBackpressureAcknowledgements = 0;
                transportInputBackpressured = false;
                ptyInputBackpressured = false;
                inputDrainNeeded = false;
                rejectReady?.(new TerminalSessionBrokerError("unavailable"));
                rejectReady = undefined;
                callbacks.onClose();
                channel.close();
            };
            const publishInputDrainIfReady = (): void => {
                if (
                    closed ||
                    !inputDrainNeeded ||
                    transportInputBackpressured ||
                    ptyInputBackpressured ||
                    pendingTransportBackpressureAcknowledgements > 0
                ) {
                    return;
                }
                inputDrainNeeded = false;
                callbacks.onInputDrain();
            };
            channel.setHandlers({
                onClose: close,
                onData(data) {
                    try {
                        for (const frame of decoder.push(data)) {
                            if (frame.kind === "output") {
                                if (
                                    callbacks.onOutput(frame.sequence, frame.data) ===
                                    "backpressured"
                                ) {
                                    channel.pause();
                                }
                                continue;
                            }
                            if (frame.kind !== "control") {
                                throw new TerminalBrokerProtocolError();
                            }
                            if (frame.message.type === "failure") {
                                const reason = v.parse(
                                    v.picklist(brokerFailureReasons),
                                    frame.message.reason
                                );
                                rejectReady?.(new TerminalSessionBrokerError(reason));
                                rejectReady = undefined;
                                close();
                                return;
                            }
                            const event = parseControlEvent(frame.message);
                            if (event.type === "input-status") {
                                const expected = pendingInputAcknowledgements.shift();
                                if (
                                    expected === undefined ||
                                    (event.status === "closed"
                                        ? event.acceptedBytes !== 0
                                        : event.acceptedBytes !== expected.bytes)
                                ) {
                                    throw new TerminalBrokerProtocolError();
                                }
                                pendingInputAcknowledgementBytes -= expected.bytes;
                                if (expected.causedTransportBackpressure) {
                                    pendingTransportBackpressureAcknowledgements -= 1;
                                }
                                if (event.status === "backpressured") {
                                    inputDrainNeeded = true;
                                    ptyInputBackpressured = true;
                                }
                            }
                            callbacks.onControl(event);
                            if (event.type === "ready") {
                                resolveReady?.();
                                resolveReady = undefined;
                                rejectReady = undefined;
                            } else if (
                                event.type === "input-drain" &&
                                ptyInputBackpressured
                            ) {
                                ptyInputBackpressured = false;
                            }
                            if (
                                event.type === "input-status" ||
                                event.type === "input-drain"
                            ) {
                                publishInputDrainIfReady();
                            }
                        }
                    } catch {
                        close();
                    }
                },
                onDrain() {
                    transportInputBackpressured = false;
                    publishInputDrainIfReady();
                },
            });
            const attachDisposition = channel.send(
                control({
                    owner,
                    rawToken: input.connectionToken,
                    sessionId,
                    type: "attach",
                })
            );
            if (attachDisposition === "closed") {
                close();
                throw new TerminalSessionBrokerError("unavailable");
            }
            await ready;

            const sendControl = (
                message: JsonObject
            ): "accepted" | "backpressured" | "closed" =>
                closed ? "closed" : channel.send(control(message));
            const relay: TerminalBrokerRelay = {
                detach() {
                    if (closed) return;
                    channel.send(control({ type: "detach" }));
                    close();
                },
                input(data) {
                    if (
                        closed ||
                        data.byteLength < 1 ||
                        data.byteLength > terminalClientMessageMaximumBytes ||
                        pendingInputAcknowledgements.length >=
                            terminalSocketBufferedMaximumBytes /
                                terminalClientMessageMaximumBytes ||
                        pendingInputAcknowledgementBytes + data.byteLength >
                            terminalSocketBufferedMaximumBytes
                    ) {
                        close();
                        return "closed";
                    }
                    const disposition = channel.send(encodeTerminalBrokerInput(data));
                    if (disposition !== "closed") {
                        const causedTransportBackpressure =
                            disposition === "backpressured";
                        pendingInputAcknowledgements.push({
                            bytes: data.byteLength,
                            causedTransportBackpressure,
                        });
                        pendingInputAcknowledgementBytes += data.byteLength;
                        if (causedTransportBackpressure) {
                            transportInputBackpressured = true;
                            inputDrainNeeded = true;
                            pendingTransportBackpressureAcknowledgements += 1;
                        }
                    }
                    return disposition;
                },
                ping: () => sendControl({ type: "ping" }),
                resize: (dimensions) => sendControl({ dimensions, type: "resize" }),
                resumeOutput() {
                    if (!closed) channel.resume();
                },
                signal: (terminalSignal) =>
                    sendControl({ signal: terminalSignal, type: "signal" }),
                terminate() {
                    if (closed) return;
                    channel.send(control({ type: "terminate-attached" }));
                    close();
                },
            };
            return Object.freeze(relay);
        },
        async getActive(owner, signal) {
            const value = await request("get-active", { owner }, signal);
            return value === null
                ? undefined
                : v.parse(terminalSessionSummarySchema, value);
        },
        async prepareResume(input, signal) {
            return v.parse(
                terminalSessionSummarySchema,
                await request("prepare-resume", { input }, signal)
            );
        },
        async reserve(input, signal) {
            return v.parse(
                terminalSessionSummarySchema,
                await request("reserve", { input }, signal)
            );
        },
        async terminate(input, signal) {
            await request("terminate", { input }, signal);
        },
    };
    return Object.freeze(client);
}
