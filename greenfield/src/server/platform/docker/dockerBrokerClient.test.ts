import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import {
    encodeDockerBrokerFrame,
    type DockerBrokerResponse,
} from "../../../contracts/dockerBroker.ts";
import {
    FixedDockerOperationsError,
    type FixedDockerOperationPayload,
    type FixedDockerOperationResult,
    type FixedDockerOperations,
} from "../../../worker/docker/fixedDockerOperations.ts";
import {
    startWorkerDockerBroker,
    type WorkerDockerBroker,
} from "../../../worker/docker/workerDockerBroker.ts";
import { DockerWorkerReadPortError } from "../../domains/docker/service.ts";
import { createDockerBrokerClient } from "./dockerBrokerClient.ts";

const requestId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const sourceRevision = "a".repeat(64);
const containerId = "1".repeat(64);
const directories: string[] = [];
const brokers: WorkerDockerBroker[] = [];
const listeners: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

function fixture(): { readonly directory: string; readonly socketPath: string } {
    const directory = mkdtempSync(path.join(tmpdir(), "mira-docker-client-"));
    chmodSync(directory, 0o700);
    directories.push(directory);
    return { directory, socketPath: path.join(directory, "docker.sock") };
}

function successfulOperations(): FixedDockerOperations & {
    readonly logInputs: unknown[];
    readonly pruneInputs: unknown[];
} {
    const logInputs: unknown[] = [];
    const pruneInputs: unknown[] = [];
    return {
        execute(
            payload: FixedDockerOperationPayload
        ): Promise<FixedDockerOperationResult> {
            return Promise.resolve({
                operation: payload.operation,
                status: "completed",
                targetCount: 1,
            });
        },
        logInputs,
        previewPrune(input) {
            pruneInputs.push(input);
            return Promise.resolve({
                estimatedReclaimableBytes: 40,
                items: [{ name: "cache-data", sizeBytes: 40 }],
                sourceRevision: input.sourceRevision,
                target: "volumes",
            });
        },
        pruneInputs,
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
    };
}

function withReadFailure(error: Error): FixedDockerOperations {
    return {
        execute(): Promise<FixedDockerOperationResult> {
            return Promise.reject(error);
        },
        previewPrune(): Promise<never> {
            return Promise.reject(error);
        },
        readContainerLogs(): Promise<never> {
            return Promise.reject(error);
        },
    };
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
    try {
        await operation;
    } catch (error) {
        return error;
    }
    throw new Error("Expected Docker broker client operation to fail");
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

function startResponseServer(socketPath: string, response: Uint8Array): void {
    const listener = Bun.listen<{ replied: boolean }>({
        data: { replied: false },
        socket: {
            data(socket) {
                if (socket.data.replied) return;
                socket.data.replied = true;
                socket.end(response);
            },
            open(socket) {
                socket.data = { replied: false };
            },
        },
        unix: socketPath,
    });
    chmodSync(socketPath, 0o600);
    listeners.push(listener);
}

function logsResponse(overrides: Partial<DockerBrokerResponse> = {}): Uint8Array {
    return encodeDockerBrokerFrame({
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
        ...overrides,
    } as DockerBrokerResponse);
}

afterEach(async () => {
    for (const broker of brokers.splice(0)) await broker.stop().catch(() => {});
    for (const listener of listeners.splice(0)) listener.stop(true);
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("Docker broker web client", () => {
    test("round-trips source-bound log and prune reads over the protected socket", async () => {
        const paths = fixture();
        const operations = successfulOperations();
        const broker = await startWorkerDockerBroker({
            operations,
            socketPath: paths.socketPath,
        });
        brokers.push(broker);
        const client = createDockerBrokerClient({
            directory: paths.directory,
            generateId: () => requestId,
            socketPath: paths.socketPath,
        });

        expect(
            await client.readContainerLogs({
                containerId,
                sourceRevision,
                tail: 3,
            })
        ).toEqual({
            containerId,
            lines: ["redacted output"],
            observedAtMs: 1_700_000_000_000,
            redacted: true,
            sourceRevision,
            truncated: false,
        });
        expect(await client.previewPrune({ sourceRevision, target: "volumes" })).toEqual({
            estimatedReclaimableBytes: 40,
            items: [{ name: "cache-data", sizeBytes: 40 }],
            sourceRevision,
            target: "volumes",
        });
        expect(operations.logInputs).toEqual([{ containerId, sourceRevision, tail: 3 }]);
        expect(operations.pruneInputs).toEqual([{ sourceRevision, target: "volumes" }]);
    });

    test("maps fixed and unknown worker failures to constant sanitized reasons", async () => {
        const cases = [
            {
                error: new FixedDockerOperationsError("conflict"),
                reason: "conflict",
            },
            {
                error: new FixedDockerOperationsError("not-found"),
                reason: "not-found",
            },
            {
                error: new FixedDockerOperationsError("unknown-outcome"),
                reason: "unavailable",
            },
            {
                error: new Error("password=private-worker-failure"),
                reason: "unavailable",
            },
        ] as const;

        for (const [index, fixtureCase] of cases.entries()) {
            const paths = fixture();
            const broker = await startWorkerDockerBroker({
                operations: withReadFailure(fixtureCase.error),
                socketPath: paths.socketPath,
            });
            brokers.push(broker);
            const failure = await captureFailure(
                createDockerBrokerClient({
                    directory: paths.directory,
                    generateId: () => `019fe7a8-03fe-700${index}-8ea2-874b1ea1b40e`,
                    socketPath: paths.socketPath,
                }).readContainerLogs({ containerId, sourceRevision, tail: 2 })
            );

            expect(failure).toBeInstanceOf(DockerWorkerReadPortError);
            expect(failure).toMatchObject({
                message: "Docker worker read failed",
                reason: fixtureCase.reason,
            });
            expect(JSON.stringify(failure)).not.toContain("private-worker-failure");
            expect(inspect(failure)).not.toContain("private-worker-failure");
            expect((failure as Error).cause).toBeUndefined();
        }
    });

    test("rejects unsafe directory and socket modes before connecting", async () => {
        const paths = fixture();
        const operations = successfulOperations();
        const broker = await startWorkerDockerBroker({
            operations,
            socketPath: paths.socketPath,
        });
        brokers.push(broker);
        const client = createDockerBrokerClient({
            directory: paths.directory,
            generateId: () => requestId,
            socketPath: paths.socketPath,
        });

        chmodSync(paths.directory, 0o750);
        let failure = await captureFailure(
            client.readContainerLogs({ containerId, sourceRevision, tail: 2 })
        );
        expect(failure).toMatchObject({ reason: "unavailable" });
        expect(operations.logInputs).toEqual([]);
        chmodSync(paths.directory, 0o700);

        chmodSync(paths.socketPath, 0o660);
        failure = await captureFailure(
            client.readContainerLogs({ containerId, sourceRevision, tail: 2 })
        );
        expect(failure).toMatchObject({ reason: "unavailable" });
        expect(operations.logInputs).toEqual([]);
        chmodSync(paths.socketPath, 0o600);
    });

    test("enforces the bounded client deadline and closes a silent worker", async () => {
        const paths = fixture();
        const never = new Promise<never>(() => {});
        const broker = await startWorkerDockerBroker({
            operations: {
                execute: () => never,
                previewPrune: () => never,
                readContainerLogs: () => never,
            },
            socketPath: paths.socketPath,
        });
        brokers.push(broker);
        const client = createDockerBrokerClient({
            directory: paths.directory,
            generateId: () => requestId,
            socketPath: paths.socketPath,
            timeoutMs: 100,
        });

        const startedAt = performance.now();
        const failure = await captureFailure(
            client.readContainerLogs({ containerId, sourceRevision, tail: 2 })
        );
        expect(failure).toMatchObject({ reason: "unavailable" });
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(75);
        expect(performance.now() - startedAt).toBeLessThan(1000);
    });

    test("rejects mismatched and trailing-partial responses without exposing content", async () => {
        for (const response of [
            logsResponse({ id: "019fe7a8-03fe-7000-8ea2-874b1ea1b40f" }),
            concatenate([logsResponse(), new Uint8Array([0])]),
        ]) {
            const paths = fixture();
            startResponseServer(paths.socketPath, response);
            const failure = await captureFailure(
                createDockerBrokerClient({
                    directory: paths.directory,
                    generateId: () => requestId,
                    socketPath: paths.socketPath,
                }).readContainerLogs({ containerId, sourceRevision, tail: 2 })
            );
            expect(failure).toMatchObject({ reason: "unavailable" });
        }
    });
});
