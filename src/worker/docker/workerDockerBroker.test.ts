import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    DockerBrokerFrameDecoder,
    encodeDockerBrokerFrame,
    parseDockerBrokerRequest,
    parseDockerBrokerResponse,
} from "../../contracts/dockerBroker.ts";
import type {
    FixedDockerOperationPayload,
    FixedDockerOperationResult,
    FixedDockerOperations,
} from "./fixedDockerOperations.ts";
import {
    startWorkerDockerBroker,
    WorkerDockerBrokerError,
    type WorkerDockerBroker,
} from "./workerDockerBroker.ts";

const requestId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const sourceRevision = "a".repeat(64);
const containerId = "1".repeat(64);
const imageId = `sha256:${"2".repeat(64)}`;
const directories: string[] = [];
const brokers: WorkerDockerBroker[] = [];

interface OperationsHarness {
    readonly logInputs: unknown[];
    readonly operations: FixedDockerOperations;
    readonly pruneInputs: unknown[];
}

function operationsHarness(): OperationsHarness {
    const logInputs: unknown[] = [];
    const pruneInputs: unknown[] = [];
    return {
        logInputs,
        operations: {
            execute(
                payload: FixedDockerOperationPayload
            ): Promise<FixedDockerOperationResult> {
                return Promise.resolve({
                    operation: payload.operation,
                    status: "completed",
                    targetCount: 1,
                });
            },
            previewPrune(input) {
                pruneInputs.push(input);
                return Promise.resolve({
                    estimatedReclaimableBytes: 25,
                    items: [{ id: imageId, references: [], sizeBytes: 25 }],
                    sourceRevision: input.sourceRevision,
                    target: "images",
                });
            },
            readContainerLogs(input) {
                logInputs.push(input);
                return Promise.resolve({
                    containerId: input.containerId,
                    lines: ["redacted output"],
                    observedAtMs: 1_700_000_000_000,
                    redacted: true,
                    sourceRevision: input.sourceRevision,
                    truncated: false,
                });
            },
        },
        pruneInputs,
    };
}

function socketFixture(): { readonly directory: string; readonly socketPath: string } {
    const directory = mkdtempSync(path.join(tmpdir(), "mira-docker-broker-"));
    chmodSync(directory, 0o700);
    directories.push(directory);
    return { directory, socketPath: path.join(directory, "docker.sock") };
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
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
            reject(new Error("Broker test exchange timed out"));
        }, 2000);
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error === undefined) resolve(concatenate(output));
            else reject(error);
        };
        void Bun.connect<{ readonly marker: "broker-test-client" }>({
            data: { marker: "broker-test-client" },
            socket: {
                binaryType: "uint8array",
                close() {
                    finish();
                },
                data(_socket, data) {
                    output.push(new Uint8Array(data));
                },
                error() {
                    finish(new Error("Broker test socket failed"));
                },
                open(socket) {
                    for (const chunk of chunks) socket.write(chunk);
                },
            },
            unix: socketPath,
        }).catch(() => finish(new Error("Broker test connection failed")));
    });
}

function openIdleConnection(
    socketPath: string,
    initialBytes?: Uint8Array
): Promise<{
    readonly closed: Promise<void>;
    readonly socket: Bun.Socket<{ readonly marker: "idle-broker-test-client" }>;
}> {
    const closed = Promise.withResolvers<void>();
    return new Promise((resolve, reject) => {
        void Bun.connect<{ readonly marker: "idle-broker-test-client" }>({
            data: { marker: "idle-broker-test-client" },
            socket: {
                close() {
                    closed.resolve();
                },
                data() {},
                error() {
                    reject(new Error("Idle broker test socket failed"));
                },
                open(socket) {
                    if (initialBytes !== undefined) socket.write(initialBytes);
                    resolve({ closed: closed.promise, socket });
                },
            },
            unix: socketPath,
        }).catch(() => reject(new Error("Idle broker test connection failed")));
    });
}

function decodeResponse(frame: Uint8Array) {
    const decoder = new DockerBrokerFrameDecoder();
    const values = decoder.push(frame);
    decoder.finish();
    expect(values).toHaveLength(1);
    return parseDockerBrokerResponse(values[0]);
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
    try {
        await operation;
    } catch (error) {
        return error;
    }
    throw new Error("Expected broker operation to fail");
}

afterEach(async () => {
    for (const broker of brokers.splice(0)) await broker.stop().catch(() => {});
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("worker Docker read broker", () => {
    test("binds only a protected canonical socket and stops idempotently", async () => {
        const fixture = socketFixture();
        const broker = await startWorkerDockerBroker({
            operations: operationsHarness().operations,
            socketPath: fixture.socketPath,
        });
        brokers.push(broker);

        expect(broker.socketPath).toBe(fixture.socketPath);
        const status = lstatSync(fixture.socketPath);
        const userId = process.getuid?.();
        if (userId === undefined) throw new Error("Expected Linux user id");
        expect(status.isSocket()).toBe(true);
        expect(status.uid).toBe(userId);
        expect(status.nlink).toBe(1);
        expect(status.mode & 0o777).toBe(0o600);

        const firstStop = broker.stop();
        const secondStop = broker.stop();
        expect(secondStop).toBe(firstStop);
        await firstStop;
        expect(() => lstatSync(fixture.socketPath)).toThrow();
    });

    test("rejects unsafe directories, non-canonical names, and stale regular files", async () => {
        const wrongMode = socketFixture();
        chmodSync(wrongMode.directory, 0o750);
        expect(
            await captureFailure(
                startWorkerDockerBroker({
                    operations: operationsHarness().operations,
                    socketPath: wrongMode.socketPath,
                })
            )
        ).toBeInstanceOf(WorkerDockerBrokerError);

        const wrongName = socketFixture();
        expect(
            await captureFailure(
                startWorkerDockerBroker({
                    operations: operationsHarness().operations,
                    socketPath: path.join(wrongName.directory, "other.sock"),
                })
            )
        ).toBeInstanceOf(WorkerDockerBrokerError);

        const staleFile = socketFixture();
        writeFileSync(staleFile.socketPath, "do-not-remove", { mode: 0o600 });
        expect(
            await captureFailure(
                startWorkerDockerBroker({
                    operations: operationsHarness().operations,
                    socketPath: staleFile.socketPath,
                })
            )
        ).toBeInstanceOf(WorkerDockerBrokerError);
        expect(await Bun.file(staleFile.socketPath).text()).toBe("do-not-remove");
    });

    test("accepts one fragmented source-bound request and returns one sanitized frame", async () => {
        const fixture = socketFixture();
        const harness = operationsHarness();
        const broker = await startWorkerDockerBroker({
            operations: harness.operations,
            socketPath: fixture.socketPath,
        });
        brokers.push(broker);
        const request = parseDockerBrokerRequest({
            id: requestId,
            input: { containerId, sourceRevision, tail: 2 },
            operation: "container-logs",
        });
        const frame = encodeDockerBrokerFrame(request);

        const responseFrame = await rawExchange(
            fixture.socketPath,
            [...frame].map((byte) => new Uint8Array([byte]))
        );

        expect(decodeResponse(responseFrame)).toEqual({
            id: requestId,
            operation: "container-logs",
            result: {
                containerId,
                lines: ["redacted output"],
                observedAtMs: 1_700_000_000_000,
                redacted: true,
                sourceRevision,
                truncated: false,
            },
            status: "ok",
        });
        expect(harness.logInputs).toEqual([{ containerId, sourceRevision, tail: 2 }]);
    });

    test("expires idle handshakes before they can occupy every connection slot", async () => {
        const fixture = socketFixture();
        const harness = operationsHarness();
        const broker = await startWorkerDockerBroker({
            operations: harness.operations,
            socketPath: fixture.socketPath,
        });
        brokers.push(broker);
        const idleConnections = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
                openIdleConnection(
                    fixture.socketPath,
                    index % 2 === 0 ? undefined : new Uint8Array([0])
                )
            )
        );

        await Promise.all(idleConnections.map(({ closed }) => closed));
        expect(idleConnections).toHaveLength(8);
        const request = parseDockerBrokerRequest({
            id: requestId,
            input: { containerId, sourceRevision, tail: 2 },
            operation: "container-logs",
        });
        const responseFrame = await rawExchange(fixture.socketPath, [
            encodeDockerBrokerFrame(request),
        ]);

        expect(decodeResponse(responseFrame).status).toBe("ok");
        expect(harness.logInputs).toEqual([{ containerId, sourceRevision, tail: 2 }]);
        for (const { socket } of idleConnections) socket.close();
    }, 10_000);

    test("closes invalid, multi-frame, and trailing-partial requests without dispatch", async () => {
        const fixture = socketFixture();
        const harness = operationsHarness();
        const broker = await startWorkerDockerBroker({
            operations: harness.operations,
            socketPath: fixture.socketPath,
        });
        brokers.push(broker);
        const request = parseDockerBrokerRequest({
            id: requestId,
            input: { containerId, sourceRevision, tail: 2 },
            operation: "container-logs",
        });
        const frame = encodeDockerBrokerFrame(request);
        const twoFrames = concatenate([frame, frame]);
        const trailingPartial = concatenate([frame, new Uint8Array([0])]);
        const invalid = new Uint8Array([0, 0, 0, 1, 255]);

        for (const bytes of [twoFrames, trailingPartial, invalid]) {
            expect(await rawExchange(fixture.socketPath, [bytes])).toHaveLength(0);
        }
        expect(harness.logInputs).toEqual([]);
        expect(harness.pruneInputs).toEqual([]);
    });
});
