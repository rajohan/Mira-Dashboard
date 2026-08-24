import path from "node:path";

import * as v from "valibot";

import {
    terminalDimensionsSchema,
    terminalLocationSchema,
    terminalSessionIdSchema,
} from "../../contracts/terminal.ts";
import {
    encodeTerminalBrokerControl,
    encodeTerminalBrokerOutput,
    TerminalBrokerFrameDecoder,
    TerminalBrokerProtocolError,
    type TerminalBrokerFrame,
} from "../../shared/terminalBrokerProtocol.ts";
import {
    boundedNonBlankStringSchema,
    lowercaseSha256Schema,
    nonnegativeSafeIntegerSchema,
} from "../../shared/validation.ts";
import {
    type WorkerPtyInputResult,
    type WorkerTerminalAttachment,
    WorkerTerminalBrokerError,
    type WorkerTerminalRelaySink,
    type WorkerTerminalSessionBroker,
} from "./terminalSessionBroker.ts";

const terminalBrokerControlFlushTimeoutMs = 5000;
const requestIdSchema = v.pipe(
    boundedNonBlankStringSchema(64, "Terminal broker request is invalid"),
    v.regex(/^[A-Za-z0-9_-]+$/u, "Terminal broker request is invalid")
);
const ownerSchema = v.strictObject({
    authenticatorId: boundedNonBlankStringSchema(128, "Terminal broker owner is invalid"),
    id: boundedNonBlankStringSchema(128, "Terminal broker owner is invalid"),
});
const ticketSchema = v.strictObject({
    afterSequence: nonnegativeSafeIntegerSchema("Terminal ticket is invalid"),
    expiresAtMs: nonnegativeSafeIntegerSchema("Terminal ticket is invalid"),
    prefix: v.pipe(
        v.string("Terminal ticket is invalid"),
        v.regex(/^[0-9a-f]{32}$/u, "Terminal ticket is invalid")
    ),
    validatorHash: lowercaseSha256Schema("Terminal ticket is invalid"),
});
const lifecycleRequestSchema = v.variant("type", [
    v.strictObject({
        owner: ownerSchema,
        requestId: requestIdSchema,
        type: v.literal("get-active"),
    }),
    v.strictObject({
        input: v.strictObject({
            absoluteStartingDirectory: v.pipe(
                v.string("Terminal starting directory is invalid"),
                v.maxLength(4096, "Terminal starting directory is invalid")
            ),
            dimensions: terminalDimensionsSchema,
            location: terminalLocationSchema,
            owner: ownerSchema,
            sessionId: terminalSessionIdSchema,
            ticket: ticketSchema,
        }),
        requestId: requestIdSchema,
        type: v.literal("reserve"),
    }),
    v.strictObject({
        input: v.strictObject({
            owner: ownerSchema,
            sessionId: terminalSessionIdSchema,
            ticket: ticketSchema,
        }),
        requestId: requestIdSchema,
        type: v.literal("prepare-resume"),
    }),
    v.strictObject({
        input: v.strictObject({
            owner: ownerSchema,
            sessionId: terminalSessionIdSchema,
        }),
        requestId: requestIdSchema,
        type: v.literal("terminate"),
    }),
    v.strictObject({
        owner: ownerSchema,
        rawToken: v.pipe(
            v.string("Terminal token is invalid"),
            v.regex(/^[0-9a-f]{32}\.[0-9a-f]{64}$/u, "Terminal token is invalid")
        ),
        sessionId: terminalSessionIdSchema,
        type: v.literal("attach"),
    }),
]);
const attachedControlSchema = v.variant("type", [
    v.strictObject({ dimensions: terminalDimensionsSchema, type: v.literal("resize") }),
    v.strictObject({
        signal: v.picklist(["SIGHUP", "SIGINT", "SIGTERM"]),
        type: v.literal("signal"),
    }),
    v.strictObject({ type: v.literal("ping") }),
    v.strictObject({ type: v.literal("detach") }),
    v.strictObject({ type: v.literal("terminate-attached") }),
]);

export type TerminalBrokerSocketKind = "directory" | "other" | "socket";

export interface TerminalBrokerSocketMetadata {
    readonly kind: TerminalBrokerSocketKind;
    readonly linkCount: number;
    readonly mode: number;
    readonly ownerUserId: number;
}

export interface TerminalBrokerSocketPathOperations {
    chmod(socketPath: string, mode: number): Promise<void>;
    inspect(targetPath: string): Promise<TerminalBrokerSocketMetadata | undefined>;
    probe(socketPath: string): Promise<"active" | "stale">;
    realpath(targetPath: string): Promise<string>;
    remove(socketPath: string): Promise<void>;
}

export interface TerminalBrokerByteConnection {
    close(): void;
    send(data: Uint8Array): "accepted" | "backpressured" | "closed";
    setHandlers(handlers: {
        readonly onClose: () => void;
        readonly onData: (data: Uint8Array) => void;
        readonly onDrain: () => void;
    }): void;
}

export interface TerminalBrokerIpcListener {
    close(): Promise<void>;
}

export interface TerminalBrokerServerTimer {
    cancel(): void;
}

export interface TerminalBrokerServerScheduler {
    schedule(callback: () => void, delayMs: number): TerminalBrokerServerTimer;
}

export interface TerminalBrokerIpcLifecycle {
    listen(input: {
        readonly onConnection: (connection: TerminalBrokerByteConnection) => void;
        readonly socketPath: string;
    }): Promise<TerminalBrokerIpcListener>;
}

export interface TerminalBrokerServerOptions {
    readonly broker: WorkerTerminalSessionBroker;
    readonly expectedUserId: number;
    readonly lifecycle: TerminalBrokerIpcLifecycle;
    readonly projectLocalDirectory: string;
    readonly scheduler?: TerminalBrokerServerScheduler;
    readonly socketPath: string;
    readonly socketPathOperations: TerminalBrokerSocketPathOperations;
}

export interface TerminalBrokerServer {
    readonly socketPath: string;
    close(): Promise<void>;
}

export class TerminalBrokerSocketSecurityError extends Error {
    public constructor() {
        super("Terminal broker socket security check failed");
        this.name = "TerminalBrokerSocketSecurityError";
    }
}

function safeSocketMetadata(
    metadata: TerminalBrokerSocketMetadata | undefined,
    kind: TerminalBrokerSocketKind,
    expectedUserId: number
): boolean {
    return (
        metadata !== undefined &&
        metadata.kind === kind &&
        metadata.ownerUserId === expectedUserId &&
        Number.isSafeInteger(metadata.linkCount) &&
        metadata.linkCount >= 1 &&
        (metadata.mode & 0o077) === 0
    );
}

async function prepareSocketPath(options: TerminalBrokerServerOptions): Promise<void> {
    if (
        !path.isAbsolute(options.projectLocalDirectory) ||
        !path.isAbsolute(options.socketPath) ||
        path.dirname(options.socketPath) !== options.projectLocalDirectory ||
        !Number.isSafeInteger(options.expectedUserId) ||
        options.expectedUserId < 0
    ) {
        throw new TerminalBrokerSocketSecurityError();
    }
    const realDirectory = await options.socketPathOperations.realpath(
        options.projectLocalDirectory
    );
    if (realDirectory !== options.projectLocalDirectory) {
        throw new TerminalBrokerSocketSecurityError();
    }
    const directory = await options.socketPathOperations.inspect(realDirectory);
    if (!safeSocketMetadata(directory, "directory", options.expectedUserId)) {
        throw new TerminalBrokerSocketSecurityError();
    }
    const existing = await options.socketPathOperations.inspect(options.socketPath);
    if (existing === undefined) return;
    if (
        !safeSocketMetadata(existing, "socket", options.expectedUserId) ||
        existing.linkCount !== 1 ||
        (await options.socketPathOperations.probe(options.socketPath)) !== "stale"
    ) {
        throw new TerminalBrokerSocketSecurityError();
    }
    await options.socketPathOperations.remove(options.socketPath);
    if ((await options.socketPathOperations.inspect(options.socketPath)) !== undefined) {
        throw new TerminalBrokerSocketSecurityError();
    }
}

async function verifyListeningSocket(
    options: TerminalBrokerServerOptions
): Promise<void> {
    await options.socketPathOperations.chmod(options.socketPath, 0o600);
    const metadata = await options.socketPathOperations.inspect(options.socketPath);
    if (
        !safeSocketMetadata(metadata, "socket", options.expectedUserId) ||
        metadata?.linkCount !== 1 ||
        metadata.mode !== 0o600
    ) {
        throw new TerminalBrokerSocketSecurityError();
    }
}

function jsonControl(value: unknown): Uint8Array {
    return encodeTerminalBrokerControl(value as never);
}

function failureReason(error: unknown): string {
    return error instanceof WorkerTerminalBrokerError ? error.reason : "unavailable";
}

function defaultScheduler(): TerminalBrokerServerScheduler {
    return Object.freeze({
        schedule(callback: () => void, delayMs: number) {
            const timer = setTimeout(callback, delayMs);
            return Object.freeze({ cancel: () => clearTimeout(timer) });
        },
    });
}

function createConnectionHandler(
    broker: WorkerTerminalSessionBroker,
    connection: TerminalBrokerByteConnection,
    scheduler: TerminalBrokerServerScheduler
): void {
    const decoder = new TerminalBrokerFrameDecoder();
    let attachment: WorkerTerminalAttachment | undefined;
    let closed = false;
    let deferredInputDrain = false;
    let inputInProgress = false;
    let outputBackpressured = false;
    let pendingClose:
        | {
              timer?: TerminalBrokerServerTimer;
          }
        | undefined;
    let processing: Promise<unknown> = Promise.resolve();

    const finalize = (): void => {
        if (closed) return;
        closed = true;
        pendingClose?.timer?.cancel();
        pendingClose = undefined;
        attachment?.detach();
        attachment = undefined;
        connection.close();
    };
    const closeAfterDrain = (): void => {
        if (closed || pendingClose !== undefined) return;
        if (!outputBackpressured) {
            finalize();
            return;
        }
        const requestedClose: { timer?: TerminalBrokerServerTimer } = {};
        pendingClose = requestedClose;
        const timer = scheduler.schedule(() => {
            if (pendingClose === requestedClose) finalize();
        }, terminalBrokerControlFlushTimeoutMs);
        if (pendingClose === requestedClose) requestedClose.timer = timer;
        else timer.cancel();
    };
    const sendFrame = (data: Uint8Array): "accepted" | "backpressured" | "closed" => {
        if (closed || pendingClose !== undefined) {
            return "accepted";
        }
        let disposition: "accepted" | "backpressured" | "closed";
        try {
            disposition = connection.send(data);
        } catch {
            disposition = "closed";
        }
        if (disposition === "closed") {
            finalize();
            return "accepted";
        }
        if (disposition === "backpressured") outputBackpressured = true;
        return disposition;
    };
    const send = (message: unknown): "accepted" | "backpressured" | "closed" =>
        sendFrame(jsonControl(message));
    const sink: WorkerTerminalRelaySink = {
        close: closeAfterDrain,
        sendControl(event) {
            if (event.type === "input-drain" && inputInProgress) {
                deferredInputDrain = true;
                return closed ? "closed" : "accepted";
            }
            return send(event);
        },
        sendOutput(sequence, data) {
            return sendFrame(encodeTerminalBrokerOutput(sequence, data));
        },
    };

    async function lifecycle(frame: TerminalBrokerFrame): Promise<void> {
        if (frame.kind !== "control") throw new TerminalBrokerProtocolError();
        const request = v.parse(lifecycleRequestSchema, frame.message);
        if (request.type === "attach") {
            if (closed) return;
            const attached = await broker.attach({
                owner: request.owner,
                rawToken: request.rawToken,
                sessionId: request.sessionId,
                sink,
            });
            if (closed) {
                attached.detach();
                return;
            }
            attachment = attached;
            return;
        }
        try {
            let value: unknown;
            if (request.type === "get-active") {
                value = (await broker.getActive(request.owner)) ?? null;
            } else if (request.type === "reserve") {
                value = await broker.reserve(request.input);
            } else if (request.type === "prepare-resume") {
                value = await broker.prepareResume(request.input);
            } else {
                await broker.terminate(request.input);
                value = null;
            }
            send({ requestId: request.requestId, type: "result", value });
        } catch (error) {
            send({
                reason: failureReason(error),
                requestId: request.requestId,
                type: "failure",
            });
        } finally {
            closeAfterDrain();
        }
    }

    async function attached(frame: TerminalBrokerFrame): Promise<void> {
        if (closed || pendingClose !== undefined) return;
        const current = attachment;
        if (current === undefined) return lifecycle(frame);
        if (frame.kind === "input") {
            inputInProgress = true;
            let result: WorkerPtyInputResult;
            try {
                result = current.input(frame.data);
            } finally {
                inputInProgress = false;
            }
            send({
                acceptedBytes: result.acceptedBytes,
                status: result.status,
                type: "input-status",
            });
            if (deferredInputDrain) {
                deferredInputDrain = false;
                send({ type: "input-drain" });
            }
            return;
        }
        if (frame.kind !== "control") throw new TerminalBrokerProtocolError();
        const message = v.parse(attachedControlSchema, frame.message);
        if (message.type === "resize") current.resize(message.dimensions);
        else if (message.type === "signal") await current.signal(message.signal);
        else if (message.type === "ping") current.ping();
        else if (message.type === "detach") current.detach();
        else await current.terminate();
        if (message.type === "detach" || message.type === "terminate-attached") {
            closeAfterDrain();
        }
    }

    connection.setHandlers({
        onClose: finalize,
        onData(data) {
            if (closed || pendingClose !== undefined) return;
            processing = processing
                .then(async () => {
                    for (const frame of decoder.push(data)) await attached(frame);
                    return true;
                })
                .catch((error: unknown) => {
                    if (!closed) {
                        send({ reason: failureReason(error), type: "failure" });
                        closeAfterDrain();
                    }
                    return false;
                });
        },
        onDrain() {
            if (closed) return;
            outputBackpressured = false;
            if (pendingClose !== undefined) {
                finalize();
                return;
            }
            attachment?.resumeOutput();
        },
    });
}

/**
 * Starts the injected Unix-socket listener only after fail-closed path checks.
 * @param options Broker, socket security, and listener boundaries.
 * @returns Secured broker server lifecycle.
 */
export async function startTerminalBrokerServer(
    options: TerminalBrokerServerOptions
): Promise<TerminalBrokerServer> {
    await prepareSocketPath(options);
    const scheduler = options.scheduler ?? defaultScheduler();
    const listener = await options.lifecycle.listen({
        onConnection: (connection) =>
            createConnectionHandler(options.broker, connection, scheduler),
        socketPath: options.socketPath,
    });
    try {
        await verifyListeningSocket(options);
    } catch (error) {
        await listener.close().catch(() => {});
        throw error;
    }
    let closed = false;
    return Object.freeze({
        async close() {
            if (closed) return;
            closed = true;
            await listener.close();
            await options.broker.shutdown();
            const metadata = await options.socketPathOperations.inspect(
                options.socketPath
            );
            if (
                safeSocketMetadata(metadata, "socket", options.expectedUserId) &&
                metadata?.linkCount === 1
            ) {
                await options.socketPathOperations.remove(options.socketPath);
            }
        },
        socketPath: options.socketPath,
    });
}
