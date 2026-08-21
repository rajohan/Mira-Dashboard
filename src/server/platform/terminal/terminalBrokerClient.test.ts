import { describe, expect, test } from "bun:test";

import {
    encodeTerminalBrokerControl,
    encodeTerminalBrokerOutput,
    TerminalBrokerFrameDecoder,
} from "../../../shared/terminalBrokerProtocol.ts";
import { TerminalSessionBrokerError } from "../../domains/terminal/brokerPort.ts";
import {
    createTerminalBrokerClient,
    type TerminalBrokerClientChannel,
    type TerminalBrokerClientTransport,
} from "./terminalBrokerClient.ts";

const owner = Object.freeze({ authenticatorId: "auth-session", id: "user-1" });
const sessionId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const summary = Object.freeze({
    dimensions: { columns: 100, rows: 30 },
    expiresAtMs: 1_800_001_800_000,
    idleExpiresAtMs: 1_800_000_600_000,
    location: { path: "/", rootId: "dashboard" },
    nextSequence: 1,
    replayAvailableFromSequence: 1,
    sessionId,
    startedAtMs: 1_800_000_000_000,
    state: "awaiting-connection" as const,
});

function decodeSingleControl(frame: Uint8Array) {
    const decoder = new TerminalBrokerFrameDecoder();
    const frames = decoder.push(frame);
    decoder.finish();
    expect(frames).toHaveLength(1);
    const decoded = frames[0];
    if (decoded?.kind !== "control") throw new Error("Expected control frame");
    return decoded.message;
}

function requiredRequestId(message: Record<string, unknown>): string {
    if (typeof message.requestId !== "string") {
        throw new TypeError("Expected request ID");
    }
    return message.requestId;
}

class FakeChannel implements TerminalBrokerClientChannel {
    public handlers:
        | {
              readonly onClose: () => void;
              readonly onData: (data: Uint8Array) => void;
              readonly onDrain: () => void;
          }
        | undefined;
    public readonly sent: Uint8Array[] = [];
    public closeCalls = 0;
    public pauseCalls = 0;
    public resumeCalls = 0;
    public sendDisposition: "accepted" | "backpressured" | "closed" = "accepted";
    public onSend: ((data: Uint8Array) => void) | undefined;

    public close(): void {
        this.closeCalls += 1;
    }

    public emit(data: Uint8Array): void {
        this.handlers?.onData(data);
    }

    public pause(): void {
        this.pauseCalls += 1;
    }

    public resume(): void {
        this.resumeCalls += 1;
    }

    public send(data: Uint8Array) {
        this.sent.push(new Uint8Array(data));
        this.onSend?.(data);
        return this.sendDisposition;
    }

    public setHandlers(handlers: NonNullable<FakeChannel["handlers"]>): void {
        this.handlers = handlers;
    }
}

describe("terminal broker web client", () => {
    test("encodes lifecycle RPC and parses fragmented bounded responses", async () => {
        const requests: Record<string, unknown>[] = [];
        const transport: TerminalBrokerClientTransport = {
            connect: () => Promise.reject(new Error("unused")),
            request(frame) {
                const request = decodeSingleControl(frame);
                requests.push(request);
                const response = encodeTerminalBrokerControl({
                    requestId: requiredRequestId(request),
                    type: "result",
                    value: request.type === "get-active" ? summary : null,
                });
                return Promise.resolve([
                    response.slice(0, 3),
                    response.slice(3, 11),
                    response.slice(11),
                ]);
            },
        };
        const client = createTerminalBrokerClient({
            generateRequestId: () => "request-1",
            transport,
        });

        expect(await client.getActive(owner)).toEqual(summary);
        expect(requests).toEqual([{ owner, requestId: "request-1", type: "get-active" }]);
        await client.terminate({ owner, sessionId });
        expect(requests[1]).toEqual({
            input: { owner, sessionId },
            requestId: "request-1",
            type: "terminate",
        });
    });

    test("maps broker failures to constant domain errors without response content", async () => {
        const transport: TerminalBrokerClientTransport = {
            connect: () => Promise.reject(new Error("unused")),
            request(frame) {
                const request = decodeSingleControl(frame);
                return Promise.resolve([
                    encodeTerminalBrokerControl({
                        reason: "capacity",
                        requestId: requiredRequestId(request),
                        type: "failure",
                    }),
                ]);
            },
        };
        const client = createTerminalBrokerClient({
            generateRequestId: () => "request-2",
            transport,
        });

        let failure: unknown;
        try {
            await client.reserve({
                absoluteStartingDirectory: "/private/path",
                dimensions: { columns: 100, rows: 30 },
                location: { path: "/", rootId: "dashboard" },
                owner,
                sessionId,
                ticket: {
                    afterSequence: 0,
                    expiresAtMs: 1_800_000_060_000,
                    prefix: "a".repeat(32),
                    validatorHash: "b".repeat(64),
                },
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(TerminalSessionBrokerError);
        expect(failure).toMatchObject({
            message: "Terminal broker operation failed",
            reason: "capacity",
        });
        expect(JSON.stringify(failure)).not.toContain("private/path");
    });

    test("closes an attached channel when aborted before broker readiness", async () => {
        const channel = new FakeChannel();
        const attachSent = Promise.withResolvers<void>();
        channel.onSend = (data) => {
            if (decodeSingleControl(data).type === "attach") attachSent.resolve();
        };
        let closed = 0;
        const controller = new AbortController();
        const client = createTerminalBrokerClient({
            transport: {
                connect: () => Promise.resolve(channel),
                request: () => Promise.reject(new Error("unused")),
            },
        });
        const attaching = client.attach({
            callbacks: {
                onClose: () => {
                    closed += 1;
                },
                onControl: () => {},
                onInputDrain: () => {},
                onOutput: () => "accepted",
            },
            connectionToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
            owner,
            sessionId,
            signal: controller.signal,
        });
        await attachSent.promise;

        controller.abort(new DOMException("private abort reason", "AbortError"));

        let failure: unknown;
        try {
            await attaching;
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            message: "Terminal broker operation failed",
            reason: "unavailable",
        });
        expect(closed).toBe(1);
        expect(channel.closeCalls).toBe(1);
    });

    test("presents the raw token once, relays raw frames, and pauses incoming output", async () => {
        const channel = new FakeChannel();
        const controller = new AbortController();
        const controls: unknown[] = [];
        const outputs: { data: Uint8Array; sequence: number }[] = [];
        let closed = 0;
        let drains = 0;
        channel.onSend = (data) => {
            const message = decodeSingleControl(data);
            if (message.type !== "attach") return;
            queueMicrotask(() => {
                channel.emit(
                    encodeTerminalBrokerControl({
                        replayAvailableFromSequence: 1,
                        resumed: false,
                        session: { ...summary, state: "connected" },
                        type: "ready",
                    })
                );
            });
        };
        const client = createTerminalBrokerClient({
            transport: {
                connect: () => Promise.resolve(channel),
                request: () => Promise.reject(new Error("unused")),
            },
        });
        const rawToken = `${"a".repeat(32)}.${"b".repeat(64)}`;
        const relay = await client.attach({
            callbacks: {
                onClose: () => {
                    closed += 1;
                },
                onControl: (event) => controls.push(event),
                onInputDrain: () => {
                    drains += 1;
                },
                onOutput(sequence, data) {
                    outputs.push({ data: new Uint8Array(data), sequence });
                    return "backpressured";
                },
            },
            connectionToken: rawToken,
            owner,
            sessionId,
            signal: controller.signal,
        });
        channel.onSend = undefined;
        const attach = decodeSingleControl(channel.sent[0] ?? new Uint8Array());
        expect(attach).toEqual({ owner, rawToken, sessionId, type: "attach" });
        expect(controls[0]).toMatchObject({
            replayAvailableFromSequence: 1,
            resumed: false,
            type: "ready",
        });
        controller.abort();
        expect(channel.closeCalls).toBe(0);

        const output = encodeTerminalBrokerOutput(7, new Uint8Array([27, 91, 109, 255]));
        channel.emit(output.slice(0, 5));
        channel.emit(output.slice(5));
        expect(outputs).toEqual([
            { data: new Uint8Array([27, 91, 109, 255]), sequence: 7 },
        ]);
        expect(channel.pauseCalls).toBe(1);
        relay.resumeOutput();
        expect(channel.resumeCalls).toBe(1);

        expect(relay.input(new Uint8Array([0, 4, 27]))).toBe("accepted");
        const inputDecoder = new TerminalBrokerFrameDecoder();
        expect(inputDecoder.push(channel.sent.at(-1) ?? new Uint8Array())).toEqual([
            { data: new Uint8Array([0, 4, 27]), kind: "input" },
        ]);
        channel.handlers?.onDrain();
        expect(drains).toBe(0);
        channel.emit(
            encodeTerminalBrokerControl({
                acceptedBytes: 3,
                status: "accepted",
                type: "input-status",
            })
        );
        expect(controls.at(-1)).toEqual({
            acceptedBytes: 3,
            status: "accepted",
            type: "input-status",
        });
        channel.emit(encodeTerminalBrokerControl({ type: "input-drain" }));
        expect(drains).toBe(0);
        relay.detach();
        expect(closed).toBe(1);
        expect(channel.closeCalls).toBe(1);
        expect(JSON.stringify(channel.sent.slice(1))).not.toContain(rawToken);
    });

    test("closes on an input acknowledgement that does not match its frame", async () => {
        const channel = new FakeChannel();
        channel.onSend = (data) => {
            const message = decodeSingleControl(data);
            if (message.type !== "attach") return;
            queueMicrotask(() => {
                channel.emit(
                    encodeTerminalBrokerControl({
                        replayAvailableFromSequence: 1,
                        resumed: false,
                        session: { ...summary, state: "connected" },
                        type: "ready",
                    })
                );
            });
        };
        let closed = 0;
        const client = createTerminalBrokerClient({
            transport: {
                connect: () => Promise.resolve(channel),
                request: () => Promise.reject(new Error("unused")),
            },
        });
        const relay = await client.attach({
            callbacks: {
                onClose: () => {
                    closed += 1;
                },
                onControl: () => {},
                onInputDrain: () => {},
                onOutput: () => "accepted",
            },
            connectionToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
            owner,
            sessionId,
        });
        channel.onSend = undefined;

        expect(relay.input(new Uint8Array([1, 2, 3]))).toBe("accepted");
        channel.emit(
            encodeTerminalBrokerControl({
                acceptedBytes: 2,
                status: "accepted",
                type: "input-status",
            })
        );

        expect(closed).toBe(1);
        expect(channel.closeCalls).toBe(1);
        expect(relay.input(new Uint8Array([4]))).toBe("closed");
    });

    test("does not release newer transport pressure on an older accepted acknowledgement", async () => {
        const channel = new FakeChannel();
        channel.onSend = (data) => {
            const message = decodeSingleControl(data);
            if (message.type !== "attach") return;
            queueMicrotask(() => {
                channel.emit(
                    encodeTerminalBrokerControl({
                        replayAvailableFromSequence: 1,
                        resumed: false,
                        session: { ...summary, state: "connected" },
                        type: "ready",
                    })
                );
            });
        };
        let drains = 0;
        const client = createTerminalBrokerClient({
            transport: {
                connect: () => Promise.resolve(channel),
                request: () => Promise.reject(new Error("unused")),
            },
        });
        const relay = await client.attach({
            callbacks: {
                onClose: () => {},
                onControl: () => {},
                onInputDrain: () => {
                    drains += 1;
                },
                onOutput: () => "accepted",
            },
            connectionToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
            owner,
            sessionId,
        });
        channel.onSend = undefined;

        expect(relay.input(new Uint8Array([1]))).toBe("accepted");
        channel.sendDisposition = "backpressured";
        expect(relay.input(new Uint8Array([2, 3]))).toBe("backpressured");
        channel.handlers?.onDrain();
        channel.emit(
            encodeTerminalBrokerControl({
                acceptedBytes: 1,
                status: "accepted",
                type: "input-status",
            })
        );
        expect(drains).toBe(0);

        channel.emit(
            encodeTerminalBrokerControl({
                acceptedBytes: 2,
                status: "accepted",
                type: "input-status",
            })
        );
        expect(drains).toBe(1);
        relay.detach();
    });

    test("ignores an unsolicited PTY drain before later input backpressure", async () => {
        const channel = new FakeChannel();
        channel.onSend = (data) => {
            const message = decodeSingleControl(data);
            if (message.type !== "attach") return;
            queueMicrotask(() => {
                channel.emit(
                    encodeTerminalBrokerControl({
                        replayAvailableFromSequence: 1,
                        resumed: false,
                        session: { ...summary, state: "connected" },
                        type: "ready",
                    })
                );
            });
        };
        let drains = 0;
        const client = createTerminalBrokerClient({
            transport: {
                connect: () => Promise.resolve(channel),
                request: () => Promise.reject(new Error("unused")),
            },
        });
        const relay = await client.attach({
            callbacks: {
                onClose: () => {},
                onControl: () => {},
                onInputDrain: () => {
                    drains += 1;
                },
                onOutput: () => "accepted",
            },
            connectionToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
            owner,
            sessionId,
        });
        channel.onSend = undefined;

        channel.emit(encodeTerminalBrokerControl({ type: "input-drain" }));
        expect(relay.input(new Uint8Array([1]))).toBe("accepted");
        channel.emit(
            encodeTerminalBrokerControl({
                acceptedBytes: 1,
                status: "backpressured",
                type: "input-status",
            })
        );
        expect(drains).toBe(0);

        channel.emit(encodeTerminalBrokerControl({ type: "input-drain" }));
        expect(drains).toBe(1);
        relay.detach();
    });

    test("waits for both IPC and PTY pressure to drain in either order", async () => {
        const channel = new FakeChannel();
        channel.onSend = (data) => {
            const message = decodeSingleControl(data);
            if (message.type !== "attach") return;
            queueMicrotask(() => {
                channel.emit(
                    encodeTerminalBrokerControl({
                        replayAvailableFromSequence: 1,
                        resumed: false,
                        session: { ...summary, state: "connected" },
                        type: "ready",
                    })
                );
            });
        };
        let drains = 0;
        const client = createTerminalBrokerClient({
            transport: {
                connect: () => Promise.resolve(channel),
                request: () => Promise.reject(new Error("unused")),
            },
        });
        const relay = await client.attach({
            callbacks: {
                onClose: () => {},
                onControl: () => {},
                onInputDrain: () => {
                    drains += 1;
                },
                onOutput: () => "accepted",
            },
            connectionToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
            owner,
            sessionId,
        });
        channel.onSend = undefined;
        channel.sendDisposition = "backpressured";

        expect(relay.input(new Uint8Array([1]))).toBe("backpressured");
        channel.emit(
            encodeTerminalBrokerControl({
                acceptedBytes: 1,
                status: "backpressured",
                type: "input-status",
            })
        );
        channel.emit(encodeTerminalBrokerControl({ type: "input-drain" }));
        expect(drains).toBe(0);
        channel.handlers?.onDrain();
        expect(drains).toBe(1);

        expect(relay.input(new Uint8Array([2]))).toBe("backpressured");
        channel.emit(
            encodeTerminalBrokerControl({
                acceptedBytes: 1,
                status: "backpressured",
                type: "input-status",
            })
        );
        channel.handlers?.onDrain();
        expect(drains).toBe(1);
        channel.emit(encodeTerminalBrokerControl({ type: "input-drain" }));
        expect(drains).toBe(2);
        relay.detach();
    });
});
