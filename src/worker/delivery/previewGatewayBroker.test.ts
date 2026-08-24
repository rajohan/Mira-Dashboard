import { afterEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import {
    encodePreviewGatewayBrokerFrame,
    parsePreviewGatewayBrokerResponse,
    PreviewGatewayBrokerFrameDecoder,
    startPreviewGatewayBroker,
    type PreviewGatewayBroker,
    type PreviewGatewayBrokerScheduler,
} from "./previewGatewayBroker.ts";
import {
    buildPreviewGatewaySocketSpecification,
    createPreviewGatewayCapability,
} from "./previewGatewayProxy.ts";

const operationId = "019fd974-54a2-74dd-a64b-d4186f8d8801";
const requestId = "019fd974-54a2-74dd-a64b-d4186f8d8802";
const temporaryDirectories: string[] = [];
const brokers: PreviewGatewayBroker[] = [];

class ManualHandshakeScheduler implements PreviewGatewayBrokerScheduler {
    readonly entries: Array<{
        readonly callback: () => void;
        cancelled: boolean;
        readonly delayMs: number;
    }> = [];

    schedule(callback: () => void, delayMs: number) {
        const entry = { callback, cancelled: false, delayMs };
        this.entries.push(entry);
        return {
            cancel() {
                entry.cancelled = true;
            },
        };
    }

    expirePending(): void {
        for (const entry of this.entries) {
            if (!entry.cancelled) entry.callback();
        }
    }
}

afterEach(async () => {
    for (const broker of brokers.splice(0)) await broker.stop().catch(() => {});
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

async function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "mira-preview-gateway-broker-"));
    temporaryDirectories.push(root);
    const stateRoot = path.join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const capability = await createPreviewGatewayCapability({
        capabilityRoot: stateRoot,
    });
    return {
        capability,
        specification: buildPreviewGatewaySocketSpecification(capability),
    };
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function rawExchange(
    socketPath: string,
    chunks: readonly Uint8Array[]
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const output: Uint8Array[] = [];
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("Preview Gateway broker test timed out"));
        }, 3000);
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error === undefined) resolve(concatenate(output));
            else reject(error);
        };
        void Bun.connect<{ marker: "preview-gateway-test" }>({
            data: { marker: "preview-gateway-test" },
            socket: {
                binaryType: "uint8array",
                close() {
                    finish();
                },
                data(_socket, data) {
                    output.push(new Uint8Array(data));
                },
                error() {
                    finish(new Error("Preview Gateway broker connection failed"));
                },
                open(socket) {
                    for (const chunk of chunks) socket.write(chunk);
                },
            },
            unix: socketPath,
        }).catch(() => finish(new Error("Preview Gateway broker connection failed")));
    });
}

function openIdleConnection(
    socketPath: string
): Promise<{ readonly closed: Promise<void> }> {
    const closed = Promise.withResolvers<void>();
    return new Promise((resolve, reject) => {
        let opened = false;
        const fail = (): void => {
            const error = new Error("Preview Gateway idle connection failed");
            if (opened) closed.reject(error);
            else reject(error);
        };
        void Bun.connect<{ marker: "preview-gateway-idle-test" }>({
            data: { marker: "preview-gateway-idle-test" },
            socket: {
                close() {
                    if (opened) closed.resolve();
                    else fail();
                },
                data() {},
                error: fail,
                open() {
                    opened = true;
                    resolve({ closed: closed.promise });
                },
            },
            unix: socketPath,
        }).catch(fail);
    });
}

function decodeResponse(frame: Uint8Array, bodyMaximumBytes: number) {
    const decoder = new PreviewGatewayBrokerFrameDecoder();
    const values = decoder.push(frame);
    decoder.finish();
    expect(values).toHaveLength(1);
    return parsePreviewGatewayBrokerResponse(values[0], bodyMaximumBytes);
}

describe("preview Gateway Unix broker", () => {
    test("binds a private socket and forwards one fragmented bounded request", async () => {
        const context = await fixture();
        const requests: unknown[] = [];
        const broker = await startPreviewGatewayBroker({
            operationId,
            port: {
                invoke(request) {
                    requests.push(request);
                    return Promise.resolve({ body: new Uint8Array([4, 5, 6]) });
                },
            },
            specification: context.specification,
        });
        brokers.push(broker);
        const status = lstatSync(broker.socketPath);
        expect(status.isSocket()).toBe(true);
        expect(status.nlink).toBe(1);
        expect(status.mode & 0o777).toBe(0o600);

        const requestFrame = encodePreviewGatewayBrokerFrame({
            body: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64url"),
            id: requestId,
            operation: "session-status",
        });
        const responseFrame = await rawExchange(
            broker.socketPath,
            [...requestFrame].map((byte) => new Uint8Array([byte]))
        );

        expect(
            decodeResponse(responseFrame, context.specification.bodyMaximumBytes)
        ).toEqual({
            body: new Uint8Array([4, 5, 6]),
            id: requestId,
            status: "ok",
        });
        expect(requests).toEqual([
            {
                body: new Uint8Array([1, 2, 3]),
                capability: context.capability.token,
                operation: "session-status",
            },
        ]);
        expect(JSON.stringify(requests)).not.toContain("upstream-token");
    });

    test("expires all eight idle handshakes before accepting later work", async () => {
        const context = await fixture();
        const scheduler = new ManualHandshakeScheduler();
        const broker = await startPreviewGatewayBroker({
            operationId,
            port: {
                invoke: () => Promise.resolve({ body: new Uint8Array([9]) }),
            },
            scheduler,
            specification: context.specification,
        });
        brokers.push(broker);
        const connections = await Promise.all(
            Array.from({ length: 8 }, () => openIdleConnection(broker.socketPath))
        );
        expect(scheduler.entries.map(({ delayMs }) => delayMs)).toEqual(
            Array.from({ length: 8 }, () => 2000)
        );
        scheduler.expirePending();
        await Promise.all(connections.map(({ closed }) => closed));
        expect(scheduler.entries.every(({ cancelled }) => cancelled)).toBe(true);

        const frame = encodePreviewGatewayBrokerFrame({
            body: "",
            id: requestId,
            operation: "chat-history",
        });
        expect(
            decodeResponse(
                await rawExchange(broker.socketPath, [frame]),
                context.specification.bodyMaximumBytes
            )
        ).toEqual({ body: new Uint8Array([9]), id: requestId, status: "ok" });
    });

    test("does not replace unsafe files and stops exact ownership idempotently", async () => {
        const context = await fixture();
        writeFileSync(context.specification.socketPath, "keep", { mode: 0o600 });
        const error = await rejectionError(
            startPreviewGatewayBroker({
                operationId,
                port: {
                    invoke: () => Promise.resolve({ body: new Uint8Array() }),
                },
                specification: context.specification,
            })
        );
        expect(error.message).toBe("Preview Gateway broker failed");
        expect(await Bun.file(context.specification.socketPath).text()).toBe("keep");

        rmSync(context.specification.socketPath);
        chmodSync(path.dirname(context.specification.socketPath), 0o700);
        const broker = await startPreviewGatewayBroker({
            operationId,
            port: {
                invoke: () => Promise.resolve({ body: new Uint8Array() }),
            },
            specification: context.specification,
        });
        const firstStop = broker.stop();
        expect(broker.stop()).toBe(firstStop);
        await firstStop;
        expect(() => lstatSync(context.specification.socketPath)).toThrow();
    });
});
