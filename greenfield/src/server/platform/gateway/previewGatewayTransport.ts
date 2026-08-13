import path from "node:path";

import * as v from "valibot";

import { gatewaySessionProjectionMaximum } from "../../../contracts/gatewaySessions.ts";
import { jsonObjectSchema, parseJsonText } from "../../../shared/json.ts";
import {
    encodePreviewGatewayBody,
    encodePreviewGatewayBrokerFrame,
    parsePreviewGatewayBrokerResponse,
    PreviewGatewayBrokerFrameDecoder,
    previewGatewayBodyMaximumBytes,
    type PreviewGatewayOperation,
    type PreviewGatewayProxyPort,
} from "../../../shared/previewGatewayProtocol.ts";
import type { TaskNotificationChatSender } from "../../../shared/taskNotifications.ts";
import {
    assertPersistentGatewayChatReadParameters,
    assertPersistentGatewayChatWriteParameters,
    type PersistentGatewayChatReadMethod,
    type PersistentGatewayChatWriteMethod,
    type PersistentGatewayReadWriteMethod,
} from "./persistentGatewayProtocol.ts";
import {
    PersistentGatewayUnavailableError,
    PersistentGatewayUnknownOutcomeError,
    type PersistentGatewayConnectionSnapshot,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTaskNotificationTransport,
    type PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";

const requestDeadlineMs = 10_000;
const socketPathMaximumBytes = 256;

const previewSessionStatusParametersSchema = v.strictObject({
    archived: v.optional(v.literal(false)),
    includeGlobal: v.optional(v.literal(true)),
    includeUnknown: v.optional(v.literal(true)),
    limit: v.pipe(
        v.number("Preview session limit is invalid"),
        v.safeInteger("Preview session limit is invalid"),
        v.minValue(1, "Preview session limit is invalid"),
        v.maxValue(gatewaySessionProjectionMaximum, "Preview session limit is invalid")
    ),
    sortBy: v.optional(v.literal("updatedAt")),
});

function assertPreviewSessionStatusParameters(
    parameters: unknown
): asserts parameters is Readonly<Record<string, unknown>> {
    v.parse(previewSessionStatusParametersSchema, parameters);
}

type PreviewGatewaySocketInvocation = Readonly<{
    body: Uint8Array;
    operation: PreviewGatewayOperation;
    signal?: AbortSignal;
}>;

export interface PreviewGatewaySocketClient {
    readonly invoke: (input: PreviewGatewaySocketInvocation) => Promise<Uint8Array>;
}

export interface PreviewGatewayTransportOptions {
    readonly client?: PreviewGatewaySocketClient;
    readonly createRequestId?: () => string;
    readonly nowMs?: () => number;
    readonly socketPath: string;
}

interface SocketState {
    readonly decoder: PreviewGatewayBrokerFrameDecoder;
    pending: Uint8Array;
}

function validSocketPath(socketPath: string): boolean {
    return (
        path.isAbsolute(socketPath) &&
        path.normalize(socketPath) === socketPath &&
        path.basename(socketPath) === "gateway.sock" &&
        Buffer.byteLength(socketPath) <= socketPathMaximumBytes &&
        !socketPath.includes("\0")
    );
}

function unavailable(): never {
    throw new PersistentGatewayUnavailableError();
}

function requestScope(signal?: AbortSignal): Readonly<{
    dispose(): void;
    readonly signal: AbortSignal;
}> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, requestDeadlineMs);
    timer.unref?.();
    return Object.freeze({
        dispose() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        },
        signal: controller.signal,
    });
}

async function invokeUnixSocket(
    socketPath: string,
    requestId: string,
    input: PreviewGatewaySocketInvocation
): Promise<Uint8Array> {
    if (!validSocketPath(socketPath)) return unavailable();
    const scope = requestScope(input.signal);
    const outcome = Promise.withResolvers<Uint8Array>();
    let settled = false;
    let socket: Bun.Socket<SocketState> | undefined;
    const settle = (
        result: { readonly body: Uint8Array; readonly status: "ok" } | undefined
    ): void => {
        if (settled) return;
        settled = true;
        if (result === undefined) outcome.reject(new PersistentGatewayUnavailableError());
        else outcome.resolve(result.body);
        socket?.end();
    };
    const frame = encodePreviewGatewayBrokerFrame({
        body: encodePreviewGatewayBody(input.body),
        id: requestId,
        operation: input.operation,
    });
    const abort = () => settle(undefined);
    scope.signal.addEventListener("abort", abort, { once: true });
    try {
        socket = await Promise.race([
            Bun.connect<SocketState>({
                socket: {
                    binaryType: "uint8array",
                    close() {
                        settle(undefined);
                    },
                    data(connection, data) {
                        let values: readonly unknown[];
                        try {
                            values = connection.data.decoder.push(data);
                        } catch {
                            settle(undefined);
                            return;
                        }
                        if (values.length !== 1) {
                            if (values.length > 1) settle(undefined);
                            return;
                        }
                        try {
                            connection.data.decoder.finish();
                            const response = parsePreviewGatewayBrokerResponse(
                                values[0],
                                previewGatewayBodyMaximumBytes
                            );
                            if (response.id !== requestId || response.status !== "ok") {
                                settle(undefined);
                                return;
                            }
                            settle(response);
                        } catch {
                            settle(undefined);
                        }
                    },
                    drain(connection) {
                        if (connection.data.pending.byteLength === 0) return;
                        const written = connection.write(connection.data.pending);
                        if (written < 0) {
                            settle(undefined);
                            return;
                        }
                        connection.data.pending = connection.data.pending.slice(written);
                    },
                    error() {
                        settle(undefined);
                    },
                    open() {},
                },
                unix: socketPath,
            }),
            new Promise<never>((_resolve, reject) => {
                const onAbort = () => reject(new PersistentGatewayUnavailableError());
                if (scope.signal.aborted) onAbort();
                else scope.signal.addEventListener("abort", onAbort, { once: true });
            }),
        ]);
        socket.data = {
            decoder: new PreviewGatewayBrokerFrameDecoder(),
            pending: new Uint8Array(),
        };
        const written = socket.write(frame);
        if (written < 0) return unavailable();
        socket.data.pending = frame.slice(written);
        return await outcome.promise;
    } catch {
        return unavailable();
    } finally {
        scope.signal.removeEventListener("abort", abort);
        scope.dispose();
        socket?.close();
    }
}

function encodeJson(value: unknown): Uint8Array {
    let text: string | undefined;
    try {
        text = JSON.stringify(value);
    } catch {
        return unavailable();
    }
    if (text === undefined) return unavailable();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > previewGatewayBodyMaximumBytes) return unavailable();
    return bytes;
}

function decodeJson(bytes: Uint8Array): unknown {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return unavailable();
    }
    const parsed = parseJsonText(text);
    if (parsed === undefined) return unavailable();
    return parsed;
}

function boundedTimeoutSignal(
    options: PersistentGatewayRequestOptions | undefined
): AbortSignal | undefined {
    if (
        options?.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) ||
            options.timeoutMs < 1 ||
            options.timeoutMs > requestDeadlineMs)
    ) {
        return unavailable();
    }
    return options?.signal;
}

function initialSnapshot(): PersistentGatewayConnectionSnapshot {
    return Object.freeze({
        connectionGeneration: 0,
        phase: "stopped",
        reconnectAttempt: 0,
    });
}

function unsupportedGatewayRequest(): Promise<never> {
    return Promise.reject(new PersistentGatewayUnavailableError());
}

/**
 * Adapts the managed preview's private Unix capability to the web Gateway port.
 * Unsupported Gateway methods remain unavailable and no bearer credential exists.
 * @param options Private socket transport options.
 * @returns A Gateway transport constrained to the reviewed preview capability.
 */
export function createPreviewGatewayTransport(
    options: PreviewGatewayTransportOptions
): PersistentGatewayTransport {
    if (!validSocketPath(options.socketPath)) unavailable();
    const nowMs = options.nowMs ?? Date.now;
    const createRequestId = options.createRequestId ?? (() => Bun.randomUUIDv7());
    const client =
        options.client ??
        Object.freeze<PreviewGatewaySocketClient>({
            invoke: (input) =>
                invokeUnixSocket(options.socketPath, createRequestId(), input),
        });
    let snapshot = initialSnapshot();
    let started = false;

    const invoke = async (
        operation: PreviewGatewayOperation,
        parameters: Readonly<Record<string, unknown>>,
        requestOptions?: PersistentGatewayRequestOptions,
        write = false
    ): Promise<unknown> => {
        if (!started) return unavailable();
        const signal = boundedTimeoutSignal(requestOptions);
        const body = encodeJson(v.parse(jsonObjectSchema, parameters));
        try {
            const response = await client.invoke({ body, operation, signal });
            const atMs = nowMs();
            snapshot = Object.freeze({
                connectedAtMs: snapshot.connectedAtMs ?? atMs,
                connectionGeneration: 1,
                lastActivityAtMs: atMs,
                phase: "connected",
                reconnectAttempt: 0,
            });
            requestOptions?.onResponseBytes?.(response.byteLength);
            return decodeJson(response);
        } catch (error) {
            if (write) throw new PersistentGatewayUnknownOutcomeError();
            if (error instanceof PersistentGatewayUnavailableError) throw error;
            return unavailable();
        }
    };

    return Object.freeze({
        get snapshot() {
            return snapshot;
        },
        request(
            method: PersistentGatewayReadWriteMethod,
            parameters: Readonly<Record<string, unknown>>,
            requestOptions?: PersistentGatewayRequestOptions
        ) {
            if (method !== "sessions.list") return unsupportedGatewayRequest();
            try {
                assertPreviewSessionStatusParameters(parameters);
            } catch {
                return unsupportedGatewayRequest();
            }
            return invoke("session-status", parameters, requestOptions);
        },
        requestAdmin: unsupportedGatewayRequest,
        requestChatRead(
            method: PersistentGatewayChatReadMethod,
            parameters: Readonly<Record<string, unknown>>,
            requestOptions?: PersistentGatewayRequestOptions
        ) {
            if (method !== "chat.history") return unsupportedGatewayRequest();
            try {
                assertPersistentGatewayChatReadParameters(method, parameters);
            } catch {
                return unsupportedGatewayRequest();
            }
            return invoke("chat-history", parameters, requestOptions);
        },
        requestChatReadMutation: unsupportedGatewayRequest,
        requestChatWrite(
            method: PersistentGatewayChatWriteMethod,
            parameters: Readonly<Record<string, unknown>>,
            requestOptions?: PersistentGatewayRequestOptions
        ) {
            if (method !== "chat.send") return unsupportedGatewayRequest();
            try {
                assertPersistentGatewayChatWriteParameters(method, parameters);
            } catch {
                return unsupportedGatewayRequest();
            }
            return invoke("chat-send", parameters, requestOptions, true);
        },
        requestOpenClawSettingsRead: unsupportedGatewayRequest,
        requestOpenClawSettingsWrite: unsupportedGatewayRequest,
        requestTaskRead: unsupportedGatewayRequest,
        requestTaskWrite: unsupportedGatewayRequest,
        start() {
            if (started) return;
            started = true;
            snapshot = Object.freeze({
                connectionGeneration: 1,
                phase: "connecting",
                reconnectAttempt: 0,
            });
        },
        stop() {
            started = false;
            snapshot = initialSnapshot();
            return Promise.resolve();
        },
        subscribe: () => () => {},
        subscribeChat: () => () => {},
    });
}

/**
 * Worker lifecycle placeholder: managed preview workers never publish host task events.
 * @returns An inert, credential-free worker notification transport.
 */
export function createManagedPreviewTaskNotificationTransport(): PersistentGatewayTaskNotificationTransport {
    const sender = Object.freeze<TaskNotificationChatSender>({
        send: () => Promise.reject(new PersistentGatewayUnavailableError()),
    });
    return Object.freeze({
        requestOpenClawServiceAction: () =>
            Promise.reject(new PersistentGatewayUnavailableError()),
        start() {},
        stop: () => Promise.resolve(),
        taskNotificationSender: sender,
    });
}

/**
 * Narrows the production web-read transport before the worker-owned Unix broker.
 * The opaque body contains only validated parameters for one fixed operation.
 * @param transport Production Gateway transport narrowed to reviewed methods.
 * @returns Exact preview proxy authority.
 */
export function createPersistentGatewayPreviewProxyPort(
    transport: Pick<
        PersistentGatewayTransport,
        "request" | "requestChatRead" | "requestChatWrite"
    >
): PreviewGatewayProxyPort {
    const port: PreviewGatewayProxyPort = {
        async invoke(
            request: Parameters<PreviewGatewayProxyPort["invoke"]>[0],
            signal?: AbortSignal
        ) {
            const parameters = v.parse(jsonObjectSchema, decodeJson(request.body));
            const options = { signal, timeoutMs: requestDeadlineMs };
            let response: unknown;
            if (request.operation === "chat-history") {
                assertPersistentGatewayChatReadParameters("chat.history", parameters);
                response = await transport.requestChatRead(
                    "chat.history",
                    parameters,
                    options
                );
            } else if (request.operation === "chat-send") {
                assertPersistentGatewayChatWriteParameters("chat.send", parameters);
                response = await transport.requestChatWrite(
                    "chat.send",
                    parameters,
                    options
                );
            } else {
                assertPreviewSessionStatusParameters(parameters);
                response = await transport.request("sessions.list", parameters, options);
            }
            return Object.freeze({ body: encodeJson(response) });
        },
    };
    return Object.freeze(port);
}
