import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import {
    DockerBrokerFrameDecoder,
    dockerBrokerRequestTimeoutMs,
    encodeDockerBrokerFrame,
    parseDockerBrokerRequest,
    type DockerBrokerResponse,
} from "../../contracts/dockerBroker.ts";
import {
    FixedDockerOperationsError,
    type FixedDockerOperations,
} from "./fixedDockerOperations.ts";

const dockerBrokerSocketFileName = "docker.sock";
const dockerBrokerConnectionMaximum = 8;
const dockerBrokerHandshakeTimeoutMs = 2000;

interface DockerBrokerSocketData {
    readonly decoder: DockerBrokerFrameDecoder;
    readonly marker: "docker-broker";
    settled: boolean;
    timer?: ReturnType<typeof setTimeout>;
}

export interface WorkerDockerBroker {
    readonly socketPath: string;
    stop(): Promise<void>;
}

export interface WorkerDockerBrokerOptions {
    readonly operations: FixedDockerOperations;
    readonly socketPath: string;
}

export class WorkerDockerBrokerError extends Error {
    constructor() {
        super("Docker worker broker failed");
        this.name = "WorkerDockerBrokerError";
    }
}

function failure(): never {
    throw new WorkerDockerBrokerError();
}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function requiredUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        return failure();
    }
    const userId = process.getuid();
    return Number.isSafeInteger(userId) && userId >= 0 ? userId : failure();
}

async function assertBrokerDirectory(socketPath: string, userId: number): Promise<void> {
    const directory = path.dirname(socketPath);
    if (
        !path.isAbsolute(socketPath) ||
        path.basename(socketPath) !== dockerBrokerSocketFileName ||
        path.join(directory, dockerBrokerSocketFileName) !== socketPath ||
        (await realpath(directory)) !== directory
    ) {
        failure();
    }
    const status = await lstat(directory);
    if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== userId ||
        (status.mode & 0o777) !== 0o700
    ) {
        failure();
    }
}

async function removeStaleSocket(socketPath: string, userId: number): Promise<void> {
    let status;
    try {
        status = await lstat(socketPath);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
    }
    if (
        !status.isSocket() ||
        status.isSymbolicLink() ||
        status.uid !== userId ||
        status.nlink !== 1
    ) {
        failure();
    }
    let connected: Bun.Socket<unknown> | undefined;
    try {
        connected = await Bun.connect({ socket: { data() {} }, unix: socketPath });
        failure();
    } catch (error) {
        if (error instanceof WorkerDockerBrokerError) throw error;
        if (!["ECONNREFUSED", "ENOENT"].includes(errorCode(error) ?? "")) {
            failure();
        }
    } finally {
        connected?.close();
    }
    try {
        await unlink(socketPath);
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
    }
}

function brokerFailureReason(error: unknown): "conflict" | "not-found" | "unavailable" {
    if (!(error instanceof FixedDockerOperationsError)) return "unavailable";
    return error.reason === "conflict" || error.reason === "not-found"
        ? error.reason
        : "unavailable";
}

async function executeRequest(
    operations: FixedDockerOperations,
    value: unknown,
    signal: AbortSignal
): Promise<DockerBrokerResponse> {
    const request = parseDockerBrokerRequest(value);
    try {
        if (request.operation === "container-logs") {
            return {
                id: request.id,
                operation: request.operation,
                result: await operations.readContainerLogs(request.input, signal),
                status: "ok",
            };
        }
        return {
            id: request.id,
            operation: request.operation,
            result: await operations.previewPrune(request.input, signal),
            status: "ok",
        };
    } catch (error) {
        return {
            id: request.id,
            reason: brokerFailureReason(error),
            status: "error",
        };
    }
}

/**
 * Starts the worker-owned fixed Docker read broker in the existing protected state dir.
 * @param options Fixed operations and canonical protected socket path.
 * @returns The active worker broker lifecycle.
 */
export async function startWorkerDockerBroker(
    options: WorkerDockerBrokerOptions
): Promise<WorkerDockerBroker> {
    const userId = requiredUserId();
    await assertBrokerDirectory(options.socketPath, userId).catch(() => failure());
    await removeStaleSocket(options.socketPath, userId).catch(() => failure());
    const sockets = new Set<Bun.Socket<DockerBrokerSocketData>>();
    let stopped = false;
    let listener: { stop(closeActiveConnections?: boolean): void };
    try {
        listener = Bun.listen<DockerBrokerSocketData>({
            data: {
                decoder: new DockerBrokerFrameDecoder(),
                marker: "docker-broker",
                settled: false,
            },
            socket: {
                binaryType: "uint8array",
                close(socket) {
                    if (socket.data.timer !== undefined) {
                        clearTimeout(socket.data.timer);
                    }
                    sockets.delete(socket);
                },
                data(socket, data) {
                    if (socket.data.settled) {
                        socket.close();
                        return;
                    }
                    let frames: readonly unknown[];
                    try {
                        frames = socket.data.decoder.push(data);
                    } catch {
                        socket.close();
                        return;
                    }
                    if (frames.length === 0) return;
                    if (frames.length !== 1) {
                        socket.close();
                        return;
                    }
                    try {
                        socket.data.decoder.finish();
                    } catch {
                        socket.close();
                        return;
                    }
                    socket.data.settled = true;
                    const controller = new AbortController();
                    if (socket.data.timer !== undefined) {
                        clearTimeout(socket.data.timer);
                    }
                    socket.data.timer = setTimeout(
                        () => controller.abort(),
                        dockerBrokerRequestTimeoutMs
                    );
                    void executeRequest(options.operations, frames[0], controller.signal)
                        .then(
                            (response) =>
                                !stopped &&
                                socket.write(encodeDockerBrokerFrame(response))
                        )
                        .catch(() => false)
                        .finally(() => socket.end());
                },
                error(socket) {
                    socket.close();
                },
                open(socket) {
                    if (stopped || sockets.size >= dockerBrokerConnectionMaximum) {
                        socket.close();
                        return;
                    }
                    socket.data = {
                        decoder: new DockerBrokerFrameDecoder(),
                        marker: "docker-broker",
                        settled: false,
                    };
                    sockets.add(socket);
                    socket.data.timer = setTimeout(
                        () => socket.close(),
                        dockerBrokerHandshakeTimeoutMs
                    );
                },
            },
            unix: options.socketPath,
        });
        await chmod(options.socketPath, 0o600);
    } catch {
        await unlink(options.socketPath).catch(() => {});
        return failure();
    }

    let stopPromise: Promise<void> | undefined;
    return Object.freeze({
        socketPath: options.socketPath,
        stop() {
            stopPromise ??= (async () => {
                stopped = true;
                listener.stop(true);
                for (const socket of sockets) socket.close();
                sockets.clear();
                await assertBrokerDirectory(options.socketPath, userId);
                const status = await lstat(options.socketPath).catch((error: unknown) => {
                    if (errorCode(error) === "ENOENT") return null;
                    throw error;
                });
                if (status === null) return;
                if (!status.isSocket() || status.uid !== userId || status.nlink !== 1) {
                    failure();
                }
                await unlink(options.socketPath);
            })().catch(() => failure());
            return stopPromise;
        },
    });
}
