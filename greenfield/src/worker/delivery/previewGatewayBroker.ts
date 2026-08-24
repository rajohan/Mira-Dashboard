import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    encodePreviewGatewayBody,
    encodePreviewGatewayBrokerFrame,
    parsePreviewGatewayBrokerRequest,
    PreviewGatewayBrokerFrameDecoder,
    previewGatewayOperations,
    type PreviewGatewayBrokerResponse,
} from "../../shared/previewGatewayProtocol.ts";
import { lowercaseUuidV7Schema } from "../../shared/validation.ts";
import {
    invokePreviewGateway,
    type PreviewGatewayProxyPort,
    type PreviewGatewaySocketSpecification,
} from "./previewGatewayProxy.ts";

const gatewaySocketFileName = "gateway.sock";
const gatewayConnectionMaximum = 8;
const gatewayHandshakeTimeoutMs = 2000;
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;

export {
    encodePreviewGatewayBrokerFrame,
    parsePreviewGatewayBrokerResponse,
    PreviewGatewayBrokerFrameDecoder,
    PreviewGatewayBrokerProtocolError,
} from "../../shared/previewGatewayProtocol.ts";
export type {
    PreviewGatewayBrokerRequest,
    PreviewGatewayBrokerResponse,
} from "../../shared/previewGatewayProtocol.ts";

interface PreviewGatewayBrokerSocketData {
    decoder: PreviewGatewayBrokerFrameDecoder;
    marker: "preview-gateway-broker";
    pending: Uint8Array;
    settled: boolean;
    timer?: PreviewGatewayBrokerTimer;
}

interface PreviewGatewayBrokerSocketIdentity {
    readonly device: number;
    readonly inode: number;
}

export interface PreviewGatewayBroker {
    readonly operationId: string;
    readonly socketPath: string;
    stop(): Promise<void>;
}

export interface PreviewGatewayBrokerTimer {
    cancel(): void;
}

export interface PreviewGatewayBrokerScheduler {
    schedule(callback: () => void, delayMs: number): PreviewGatewayBrokerTimer;
}

export interface PreviewGatewayBrokerOptions {
    readonly operationId: string;
    readonly port: PreviewGatewayProxyPort;
    readonly scheduler?: PreviewGatewayBrokerScheduler;
    readonly specification: PreviewGatewaySocketSpecification;
}

export class PreviewGatewayBrokerError extends Error {
    public constructor() {
        super("Preview Gateway broker failed");
        this.name = "PreviewGatewayBrokerError";
    }
}

function fail(): never {
    throw new PreviewGatewayBrokerError();
}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function requiredUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") fail();
    const userId = process.getuid();
    if (!Number.isSafeInteger(userId) || userId < 0) fail();
    return userId;
}

function validSpecification(specification: PreviewGatewaySocketSpecification): boolean {
    return (
        path.isAbsolute(specification.socketPath) &&
        path.normalize(specification.socketPath) === specification.socketPath &&
        path.basename(specification.socketPath) === gatewaySocketFileName &&
        specification.socketMode === 0o600 &&
        specification.bodyMaximumBytes > 0 &&
        specification.bodyMaximumBytes <= 64 * 1024 &&
        specification.requestDeadlineMs > 0 &&
        specification.requestDeadlineMs <= 10_000 &&
        capabilityPattern.test(specification.capability) &&
        specification.allowedOperations.length === 3 &&
        previewGatewayOperations.every((operation) =>
            specification.allowedOperations.includes(operation)
        )
    );
}

async function assertBrokerDirectory(socketPath: string, userId: number): Promise<void> {
    const directory = path.dirname(socketPath);
    if ((await realpath(directory)) !== directory) fail();
    const status = await lstat(directory);
    if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== userId ||
        (status.mode & 0o777) !== 0o700
    ) {
        fail();
    }
}

function exactSocket(
    status: Awaited<ReturnType<typeof lstat>>,
    identity: PreviewGatewayBrokerSocketIdentity,
    userId: number
): boolean {
    return (
        status.isSocket() &&
        !status.isSymbolicLink() &&
        status.uid === userId &&
        status.nlink === 1 &&
        status.dev === identity.device &&
        status.ino === identity.inode
    );
}

async function unlinkExactSocket(
    socketPath: string,
    identity: PreviewGatewayBrokerSocketIdentity,
    userId: number
): Promise<void> {
    const current = await lstat(socketPath).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
    });
    if (current === null) return;
    if (!exactSocket(current, identity, userId)) fail();
    await unlink(socketPath);
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
        fail();
    }
    let connected: Bun.Socket<unknown> | undefined;
    try {
        connected = await Bun.connect({ socket: { data() {} }, unix: socketPath });
        fail();
    } catch (error) {
        if (error instanceof PreviewGatewayBrokerError) throw error;
        if (!["ECONNREFUSED", "ENOENT"].includes(errorCode(error) ?? "")) fail();
    } finally {
        connected?.close();
    }
    await unlinkExactSocket(
        socketPath,
        { device: status.dev, inode: status.ino },
        userId
    );
}

async function executeRequest(
    options: PreviewGatewayBrokerOptions,
    value: unknown,
    signal?: AbortSignal
): Promise<PreviewGatewayBrokerResponse> {
    const request = parsePreviewGatewayBrokerRequest(
        value,
        options.specification.bodyMaximumBytes
    );
    try {
        const response = await invokePreviewGateway(
            options.specification,
            options.port,
            {
                body: request.body,
                capability: options.specification.capability,
                operation: request.operation,
            },
            signal
        );
        return Object.freeze({
            body: encodePreviewGatewayBody(response.body),
            id: request.id,
            status: "ok",
        });
    } catch {
        return Object.freeze({
            id: request.id,
            reason: "unavailable",
            status: "error",
        });
    }
}

function writeResponse(
    socket: Bun.Socket<PreviewGatewayBrokerSocketData>,
    response: PreviewGatewayBrokerResponse
): void {
    const frame = encodePreviewGatewayBrokerFrame(response);
    const written = socket.write(frame);
    if (written < 0) {
        socket.close();
        return;
    }
    if (written === frame.byteLength) {
        socket.end();
        return;
    }
    socket.data.pending = frame.slice(written);
}

function defaultScheduler(): PreviewGatewayBrokerScheduler {
    return Object.freeze({
        schedule(callback: () => void, delayMs: number) {
            const timer = setTimeout(callback, delayMs);
            timer.unref?.();
            return Object.freeze({ cancel: () => clearTimeout(timer) });
        },
    });
}

/**
 * Starts one exact-slot, worker-owned Unix broker for the preview Gateway capability.
 * @param options Exact operation identity, socket specification, and narrow Gateway port.
 * @returns Idempotently stoppable private broker lifecycle.
 */
export async function startPreviewGatewayBroker(
    options: PreviewGatewayBrokerOptions
): Promise<PreviewGatewayBroker> {
    const operationId = v.parse(
        lowercaseUuidV7Schema("Preview Gateway operation id is invalid"),
        options.operationId
    );
    if (!validSpecification(options.specification)) fail();
    const userId = requiredUserId();
    await assertBrokerDirectory(options.specification.socketPath, userId).catch(() =>
        fail()
    );
    await removeStaleSocket(options.specification.socketPath, userId).catch(() => fail());
    const scheduler = options.scheduler ?? defaultScheduler();
    const sockets = new Set<Bun.Socket<PreviewGatewayBrokerSocketData>>();
    let stopped = false;
    let listener: { stop(closeActiveConnections?: boolean): void } | undefined;
    let socketIdentity: PreviewGatewayBrokerSocketIdentity | undefined;
    try {
        listener = Bun.listen<PreviewGatewayBrokerSocketData>({
            data: {
                decoder: new PreviewGatewayBrokerFrameDecoder(),
                marker: "preview-gateway-broker",
                pending: new Uint8Array(),
                settled: false,
            },
            socket: {
                binaryType: "uint8array",
                close(socket) {
                    socket.data.timer?.cancel();
                    socket.data.pending = new Uint8Array();
                    sockets.delete(socket);
                },
                data(socket, data) {
                    if (socket.data.settled) {
                        socket.close();
                        return;
                    }
                    let messages: readonly unknown[];
                    try {
                        messages = socket.data.decoder.push(data);
                    } catch {
                        socket.close();
                        return;
                    }
                    if (messages.length === 0) return;
                    if (messages.length !== 1) {
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
                    socket.data.timer?.cancel();
                    socket.data.timer = undefined;
                    void executeRequest(options, messages[0])
                        .then((response) => !stopped && writeResponse(socket, response))
                        .catch(() => socket.close());
                },
                drain(socket) {
                    if (socket.data.pending.byteLength === 0) return;
                    const written = socket.write(socket.data.pending);
                    if (written < 0) {
                        socket.close();
                        return;
                    }
                    socket.data.pending = socket.data.pending.slice(written);
                    if (socket.data.pending.byteLength === 0) socket.end();
                },
                error(socket) {
                    socket.close();
                },
                open(socket) {
                    if (stopped || sockets.size >= gatewayConnectionMaximum) {
                        socket.close();
                        return;
                    }
                    socket.data = {
                        decoder: new PreviewGatewayBrokerFrameDecoder(),
                        marker: "preview-gateway-broker",
                        pending: new Uint8Array(),
                        settled: false,
                    };
                    sockets.add(socket);
                    socket.data.timer = scheduler.schedule(
                        () => socket.close(),
                        gatewayHandshakeTimeoutMs
                    );
                },
            },
            unix: options.specification.socketPath,
        });
        const initialSocketStatus = await lstat(options.specification.socketPath);
        if (
            !initialSocketStatus.isSocket() ||
            initialSocketStatus.isSymbolicLink() ||
            initialSocketStatus.uid !== userId ||
            initialSocketStatus.nlink !== 1
        ) {
            fail();
        }
        socketIdentity = Object.freeze({
            device: initialSocketStatus.dev,
            inode: initialSocketStatus.ino,
        });
        await chmod(options.specification.socketPath, options.specification.socketMode);
        const socketStatus = await lstat(options.specification.socketPath);
        if (
            !exactSocket(socketStatus, socketIdentity, userId) ||
            (socketStatus.mode & 0o777) !== options.specification.socketMode
        ) {
            fail();
        }
    } catch {
        listener?.stop(true);
        if (socketIdentity !== undefined) {
            await unlinkExactSocket(
                options.specification.socketPath,
                socketIdentity,
                userId
            ).catch(() => {});
        }
        return fail();
    }
    if (listener === undefined || socketIdentity === undefined) fail();
    const activeListener = listener;
    const activeSocketIdentity = socketIdentity;

    let stopPromise: Promise<void> | undefined;
    return Object.freeze({
        operationId,
        socketPath: options.specification.socketPath,
        stop() {
            stopPromise ??= (async () => {
                stopped = true;
                await assertBrokerDirectory(options.specification.socketPath, userId);
                const currentSocket = await lstat(options.specification.socketPath).catch(
                    (error: unknown) => {
                        if (errorCode(error) === "ENOENT") return null;
                        throw error;
                    }
                );
                if (
                    currentSocket !== null &&
                    !exactSocket(currentSocket, activeSocketIdentity, userId)
                ) {
                    fail();
                }
                activeListener.stop(true);
                for (const socket of sockets) socket.close();
                sockets.clear();
                await unlinkExactSocket(
                    options.specification.socketPath,
                    activeSocketIdentity,
                    userId
                );
            })().catch(() => fail());
            return stopPromise;
        },
    });
}
