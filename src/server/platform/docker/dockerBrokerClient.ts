import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
    type DockerGetContainerLogsInput,
    type DockerGetContainerLogsResult,
    type DockerPreparePruneInput,
} from "../../../contracts/docker.ts";
import {
    DockerBrokerFrameDecoder,
    dockerBrokerRequestTimeoutMs,
    encodeDockerBrokerFrame,
    parseDockerBrokerRequest,
    parseDockerBrokerResponse,
    type DockerBrokerRequest,
    type DockerBrokerResponse,
} from "../../../contracts/dockerBroker.ts";
import {
    type DockerWorkerPrunePreview,
    type DockerWorkerReadPort,
    DockerWorkerReadPortError,
} from "../../domains/docker/service.ts";

export interface DockerBrokerClientOptions {
    readonly directory: string;
    readonly generateId?: () => string;
    readonly socketPath: string;
    readonly timeoutMs?: number;
}

function failure(): never {
    throw new DockerWorkerReadPortError("unavailable");
}

function requiredUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        return failure();
    }
    const value = process.getuid();
    return Number.isSafeInteger(value) && value >= 0 ? value : failure();
}

function requiredTimeoutMs(value: number | undefined): number {
    const timeoutMs = value ?? dockerBrokerRequestTimeoutMs;
    return Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30_000
        ? timeoutMs
        : failure();
}

async function assertSocketSecurity(
    options: DockerBrokerClientOptions,
    userId: number
): Promise<void> {
    try {
        if (
            !path.isAbsolute(options.directory) ||
            !path.isAbsolute(options.socketPath) ||
            path.dirname(options.socketPath) !== options.directory
        ) {
            failure();
        }
        const [canonicalDirectory, directory, socket] = await Promise.all([
            realpath(options.directory),
            lstat(options.directory),
            lstat(options.socketPath),
        ]);
        if (
            canonicalDirectory !== options.directory ||
            !directory.isDirectory() ||
            directory.isSymbolicLink() ||
            directory.uid !== userId ||
            (directory.mode & 0o777) !== 0o700 ||
            !socket.isSocket() ||
            socket.isSymbolicLink() ||
            socket.uid !== userId ||
            socket.nlink !== 1 ||
            (socket.mode & 0o777) !== 0o600
        ) {
            failure();
        }
    } catch {
        failure();
    }
}

function responseFailure(
    response: Extract<DockerBrokerResponse, { status: "error" }>
): never {
    throw new DockerWorkerReadPortError(response.reason);
}

function responseFor(
    response: DockerBrokerResponse,
    request: DockerBrokerRequest
): DockerBrokerResponse {
    if (response.id !== request.id) return failure();
    if (response.status === "error") return responseFailure(response);
    if (response.operation !== request.operation) return failure();
    return response;
}

async function exchange(
    options: DockerBrokerClientOptions,
    request: DockerBrokerRequest,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<DockerBrokerResponse> {
    signal?.throwIfAborted();
    const userId = requiredUserId();
    await assertSocketSecurity(options, userId);
    const decoder = new DockerBrokerFrameDecoder();
    let socket: Bun.Socket<{ readonly marker: "docker-broker-client" }> | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const response = new Promise<DockerBrokerResponse>((resolve, reject) => {
        const finish = (
            outcome:
                | {
                      readonly kind: "failure";
                      readonly reason: DockerWorkerReadPortError["reason"];
                  }
                | { readonly kind: "success"; readonly value: DockerBrokerResponse }
        ): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            if (abort !== undefined) signal?.removeEventListener("abort", abort);
            socket?.close();
            if (outcome.kind === "success") resolve(outcome.value);
            else reject(new DockerWorkerReadPortError(outcome.reason));
        };
        abort = () => finish({ kind: "failure", reason: "unavailable" });
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
            () => finish({ kind: "failure", reason: "unavailable" }),
            timeoutMs
        );
        void Bun.connect<{ readonly marker: "docker-broker-client" }>({
            data: { marker: "docker-broker-client" },
            socket: {
                binaryType: "uint8array",
                close() {
                    if (!settled) {
                        finish({ kind: "failure", reason: "unavailable" });
                    }
                },
                data(_socket, data) {
                    try {
                        const frames = decoder.push(data);
                        if (frames.length === 0) return;
                        if (frames.length !== 1) {
                            return finish({
                                kind: "failure",
                                reason: "unavailable",
                            });
                        }
                        decoder.finish();
                        const parsed = responseFor(
                            parseDockerBrokerResponse(frames[0]),
                            request
                        );
                        finish({ kind: "success", value: parsed });
                    } catch (error) {
                        finish({
                            kind: "failure",
                            reason:
                                error instanceof DockerWorkerReadPortError
                                    ? error.reason
                                    : "unavailable",
                        });
                    }
                },
                error() {
                    finish({ kind: "failure", reason: "unavailable" });
                },
                open(connected) {
                    socket = connected;
                    if (signal?.aborted) {
                        finish({ kind: "failure", reason: "unavailable" });
                        return;
                    }
                    if (connected.write(encodeDockerBrokerFrame(request)) < 0) {
                        finish({ kind: "failure", reason: "unavailable" });
                    }
                },
            },
            unix: options.socketPath,
        }).catch(() => finish({ kind: "failure", reason: "unavailable" }));
    });
    return response;
}

/**
 * Creates the web process's two fixed Docker reads over protected local IPC.
 * @param options Canonical socket identity, bounded timeout, and request-id source.
 * @returns A narrow Docker worker read port.
 */
export function createDockerBrokerClient(
    options: DockerBrokerClientOptions
): DockerWorkerReadPort {
    const generateId = options.generateId ?? (() => Bun.randomUUIDv7());
    const timeoutMs = requiredTimeoutMs(options.timeoutMs);
    return Object.freeze({
        async previewPrune(
            input: DockerPreparePruneInput,
            signal?: AbortSignal
        ): Promise<DockerWorkerPrunePreview> {
            const request = parseDockerBrokerRequest({
                id: generateId(),
                input,
                operation: "prune-preview",
            });
            const response = await exchange(options, request, timeoutMs, signal);
            if (response.status !== "ok" || response.operation !== "prune-preview") {
                return failure();
            }
            return response.result;
        },
        async readContainerLogs(
            input: DockerGetContainerLogsInput,
            signal?: AbortSignal
        ): Promise<DockerGetContainerLogsResult> {
            const request = parseDockerBrokerRequest({
                id: generateId(),
                input,
                operation: "container-logs",
            });
            const response = await exchange(options, request, timeoutMs, signal);
            if (response.status !== "ok" || response.operation !== "container-logs") {
                return failure();
            }
            return response.result;
        },
    });
}
