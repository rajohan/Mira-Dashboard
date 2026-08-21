import * as v from "valibot";

import { parseJsonText } from "../shared/json.ts";
import { lowercaseUuidV7Schema } from "../shared/validation.ts";
import {
    dockerGetContainerLogsInputSchema,
    dockerGetContainerLogsResultSchema,
    dockerPreparePruneInputSchema,
    dockerPrunePreviewResultSchema,
} from "./docker.ts";

/** Bounded local IPC frame, including escaped JSON log content. */
export const dockerBrokerFrameMaximumBytes = 2 * 1024 * 1024;
export const dockerBrokerRequestTimeoutMs = 20_000;

const dockerBrokerRequestIdSchema = lowercaseUuidV7Schema(
    "Docker broker request id is invalid"
);
const dockerBrokerFailureReasonSchema = v.picklist(
    ["conflict", "not-found", "unavailable"],
    "Docker broker failure is invalid"
);

export const dockerBrokerRequestSchema = v.variant("operation", [
    v.strictObject({
        id: dockerBrokerRequestIdSchema,
        input: dockerGetContainerLogsInputSchema,
        operation: v.literal("container-logs"),
    }),
    v.strictObject({
        id: dockerBrokerRequestIdSchema,
        input: dockerPreparePruneInputSchema,
        operation: v.literal("prune-preview"),
    }),
]);

export const dockerBrokerResponseSchema = v.union([
    v.strictObject({
        id: dockerBrokerRequestIdSchema,
        operation: v.literal("container-logs"),
        result: dockerGetContainerLogsResultSchema,
        status: v.literal("ok"),
    }),
    v.strictObject({
        id: dockerBrokerRequestIdSchema,
        operation: v.literal("prune-preview"),
        result: dockerPrunePreviewResultSchema,
        status: v.literal("ok"),
    }),
    v.strictObject({
        id: dockerBrokerRequestIdSchema,
        reason: dockerBrokerFailureReasonSchema,
        status: v.literal("error"),
    }),
]);

export type DockerBrokerRequest = v.InferOutput<typeof dockerBrokerRequestSchema>;
export type DockerBrokerResponse = v.InferOutput<typeof dockerBrokerResponseSchema>;

/** Sanitized framing failure that never retains decoded peer content. */
export class DockerBrokerProtocolError extends Error {
    constructor() {
        super("Docker broker protocol failed");
        this.name = "DockerBrokerProtocolError";
    }
}

function protocolFailure(): never {
    throw new DockerBrokerProtocolError();
}

/**
 * Encodes one validated message into a four-byte big-endian length frame.
 * @param value One strict broker request or response.
 * @returns One bounded binary length frame.
 */
export function encodeDockerBrokerFrame(
    value: DockerBrokerRequest | DockerBrokerResponse
): Uint8Array {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength === 0 || bytes.byteLength > dockerBrokerFrameMaximumBytes) {
        protocolFailure();
    }
    const frame = new Uint8Array(4 + bytes.byteLength);
    new DataView(frame.buffer).setUint32(0, bytes.byteLength, false);
    frame.set(bytes, 4);
    return frame;
}

/** Incremental exact-frame decoder shared by the worker listener and web client. */
export class DockerBrokerFrameDecoder {
    #buffer = new Uint8Array();

    push(data: Uint8Array): readonly unknown[] {
        if (
            data.byteLength === 0 ||
            this.#buffer.byteLength + data.byteLength > dockerBrokerFrameMaximumBytes + 4
        ) {
            protocolFailure();
        }
        const combined = new Uint8Array(this.#buffer.byteLength + data.byteLength);
        combined.set(this.#buffer);
        combined.set(data, this.#buffer.byteLength);
        this.#buffer = combined;
        const messages: unknown[] = [];
        while (this.#buffer.byteLength >= 4) {
            const bodyLength = new DataView(
                this.#buffer.buffer,
                this.#buffer.byteOffset,
                4
            ).getUint32(0, false);
            if (bodyLength === 0 || bodyLength > dockerBrokerFrameMaximumBytes) {
                protocolFailure();
            }
            if (this.#buffer.byteLength < bodyLength + 4) break;
            let text: string;
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(
                    this.#buffer.subarray(4, bodyLength + 4)
                );
            } catch {
                protocolFailure();
            }
            const parsed = parseJsonText(text);
            if (parsed === undefined) protocolFailure();
            messages.push(parsed);
            this.#buffer = this.#buffer.slice(bodyLength + 4);
        }
        return messages;
    }

    finish(): void {
        if (this.#buffer.byteLength !== 0) protocolFailure();
    }
}

export function parseDockerBrokerRequest(value: unknown): DockerBrokerRequest {
    return v.parse(dockerBrokerRequestSchema, value);
}

export function parseDockerBrokerResponse(value: unknown): DockerBrokerResponse {
    return v.parse(dockerBrokerResponseSchema, value);
}
