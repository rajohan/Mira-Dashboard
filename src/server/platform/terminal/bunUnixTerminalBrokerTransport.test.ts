import { describe, expect, test } from "bun:test";

import {
    encodeTerminalBrokerControl,
    terminalBrokerReadChunkMaximumBytes,
} from "../../../shared/terminalBrokerProtocol.ts";
import {
    BunTerminalBrokerClientChannel,
    connectBunTerminalBrokerChannel,
    requestBunTerminalBrokerResponse,
    type BunUnixTerminalBrokerSocketConnector,
} from "./bunUnixTerminalBrokerTransport.ts";
import type { TerminalBrokerClientChannel } from "./terminalBrokerClient.ts";

class FakeSocket {
    public closeCalls = 0;
    public readonly writes = [0, -1];

    public close(): void {
        this.closeCalls += 1;
    }

    public pause(): void {}

    public resume(): void {}

    public write(): number {
        return this.writes.shift() ?? -1;
    }
}

class SynchronousOverflowChannel implements TerminalBrokerClientChannel {
    public closeCalls = 0;
    public closed = false;
    public handlers:
        | Parameters<TerminalBrokerClientChannel["setHandlers"]>[0]
        | undefined;

    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.closeCalls += 1;
        this.handlers?.onClose();
    }

    public pause(): void {}

    public resume(): void {}

    public send(): "accepted" {
        this.handlers?.onData(
            encodeTerminalBrokerControl({
                requestId: "request-1",
                type: "result",
                value: null,
            })
        );
        this.handlers?.onData(new Uint8Array(terminalBrokerReadChunkMaximumBytes));
        return "accepted";
    }

    public setHandlers(
        handlers: Parameters<TerminalBrokerClientChannel["setHandlers"]>[0]
    ): void {
        this.handlers = handlers;
    }
}

describe("Bun terminal broker client channel", () => {
    test("publishes one close when a pending drain write fails", () => {
        const socket = new FakeSocket();
        const channel = new BunTerminalBrokerClientChannel(
            socket as unknown as Bun.Socket<unknown>
        );
        let closeCalls = 0;
        let drainCalls = 0;
        channel.setHandlers({
            onClose: () => {
                closeCalls += 1;
            },
            onData: () => {},
            onDrain: () => {
                drainCalls += 1;
            },
        });

        expect(channel.send(new Uint8Array([1, 2, 3]))).toBe("backpressured");
        channel.notifyDrain();
        channel.notifyClose();
        channel.close();

        expect(socket.closeCalls).toBe(1);
        expect(closeCalls).toBe(1);
        expect(drainCalls).toBe(0);
        expect(channel.send(new Uint8Array([4]))).toBe("closed");
    });

    test("closes only a late connection after the connect race is aborted", async () => {
        const lateConnection = Promise.withResolvers<Bun.Socket<unknown>>();
        const connector: BunUnixTerminalBrokerSocketConnector = {
            connect: () => lateConnection.promise,
        };
        const controller = new AbortController();
        const connecting = connectBunTerminalBrokerChannel(
            "/tmp/terminal-broker.sock",
            1000,
            connector,
            controller.signal
        );

        controller.abort();
        let failure: unknown;
        try {
            await connecting;
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({ message: "Terminal broker transport failed" });
        const lateSocket = new FakeSocket();
        lateConnection.resolve(lateSocket as unknown as Bun.Socket<unknown>);
        await Promise.resolve();
        await Promise.resolve();
        expect(lateSocket.closeCalls).toBe(1);

        const winningSocket = new FakeSocket();
        const winner = await connectBunTerminalBrokerChannel(
            "/tmp/terminal-broker.sock",
            1000,
            {
                connect: () =>
                    Promise.resolve(winningSocket as unknown as Bun.Socket<unknown>),
            }
        );
        expect(winningSocket.closeCalls).toBe(0);
        winner.close();
        expect(winningSocket.closeCalls).toBe(1);
    });

    test("rejects a valid response followed by synchronous overflow", async () => {
        const channel = new SynchronousOverflowChannel();
        let failure: unknown;

        try {
            await requestBunTerminalBrokerResponse(
                channel,
                encodeTerminalBrokerControl({
                    owner: { authenticatorId: "auth-1", id: "user-1" },
                    requestId: "request-1",
                    type: "get-active",
                })
            );
        } catch (error) {
            failure = error;
        }

        expect(failure).toMatchObject({ message: "Terminal broker transport failed" });
        expect(channel.closeCalls).toBe(1);
    });
});
