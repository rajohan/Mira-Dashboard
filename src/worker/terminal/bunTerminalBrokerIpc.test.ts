import { describe, expect, test } from "bun:test";

import { BunTerminalBrokerByteConnection } from "./bunTerminalBrokerIpc.ts";

class FakeSocket {
    public closeCalls = 0;
    public readonly writes = [0, -1];

    public close(): void {
        this.closeCalls += 1;
    }

    public write(): number {
        return this.writes.shift() ?? -1;
    }
}

describe("Bun terminal broker worker connection", () => {
    test("publishes one close when a pending drain write fails", () => {
        const socket = new FakeSocket();
        const connection = new BunTerminalBrokerByteConnection(
            socket as unknown as Bun.Socket<unknown>
        );
        let closeCalls = 0;
        let drainCalls = 0;
        connection.setHandlers({
            onClose: () => {
                closeCalls += 1;
            },
            onData: () => {},
            onDrain: () => {
                drainCalls += 1;
            },
        });

        expect(connection.send(new Uint8Array([1, 2, 3]))).toBe("backpressured");
        connection.notifyDrain();
        connection.notifyClose();
        connection.close();

        expect(socket.closeCalls).toBe(1);
        expect(closeCalls).toBe(1);
        expect(drainCalls).toBe(0);
        expect(connection.send(new Uint8Array([4]))).toBe("closed");
    });
});
