import * as v from "valibot";

import { parseJsonText } from "./json.ts";
import { lowercaseUuidV7Schema } from "./validation.ts";

export const previewGatewayBodyMaximumBytes = 64 * 1024;
export const previewGatewayFrameMaximumBytes = 128 * 1024;
const previewGatewayEncodedBodyMaximumCharacters = 88 * 1024;
const base64UrlPattern = /^[A-Za-z0-9_-]*$/u;

export const previewGatewayOperations = Object.freeze([
    "chat-history",
    "chat-send",
    "session-status",
] as const);
export type PreviewGatewayOperation = (typeof previewGatewayOperations)[number];

export interface PreviewGatewayRequest {
    readonly body: Uint8Array;
    readonly capability: string;
    readonly operation: PreviewGatewayOperation;
}

export interface PreviewGatewayResponse {
    readonly body: Uint8Array;
}

export interface PreviewGatewayProxyPort {
    readonly invoke: (
        request: PreviewGatewayRequest,
        signal?: AbortSignal
    ) => Promise<PreviewGatewayResponse>;
}

const requestSchema = v.strictObject({
    body: v.pipe(
        v.string("Preview Gateway body is invalid"),
        v.maxLength(
            previewGatewayEncodedBodyMaximumCharacters,
            "Preview Gateway body is outside its budget"
        ),
        v.regex(base64UrlPattern, "Preview Gateway body is invalid")
    ),
    id: lowercaseUuidV7Schema("Preview Gateway request id is invalid"),
    operation: v.picklist(
        previewGatewayOperations,
        "Preview Gateway operation is invalid"
    ),
});

const responseSchema = v.variant("status", [
    v.strictObject({
        body: v.pipe(
            v.string("Preview Gateway response body is invalid"),
            v.maxLength(
                previewGatewayEncodedBodyMaximumCharacters,
                "Preview Gateway response body is outside its budget"
            ),
            v.regex(base64UrlPattern, "Preview Gateway response body is invalid")
        ),
        id: lowercaseUuidV7Schema("Preview Gateway request id is invalid"),
        status: v.literal("ok"),
    }),
    v.strictObject({
        id: lowercaseUuidV7Schema("Preview Gateway request id is invalid"),
        reason: v.literal("unavailable"),
        status: v.literal("error"),
    }),
]);

export type PreviewGatewayBrokerRequest = v.InferOutput<typeof requestSchema>;
export type PreviewGatewayBrokerResponse = v.InferOutput<typeof responseSchema>;

export class PreviewGatewayBrokerProtocolError extends Error {
    public constructor() {
        super("Preview Gateway broker protocol failed");
        this.name = "PreviewGatewayBrokerProtocolError";
    }
}

function protocolFail(): never {
    throw new PreviewGatewayBrokerProtocolError();
}

function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    return globalThis
        .btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

function decodeBase64Url(value: string, maximumBytes: number): Uint8Array {
    if (
        !base64UrlPattern.test(value) ||
        value.length % 4 === 1 ||
        value.length > Math.ceil((maximumBytes * 4) / 3)
    ) {
        protocolFail();
    }
    let binary: string;
    try {
        const padding = "=".repeat((4 - (value.length % 4)) % 4);
        binary = globalThis.atob(
            `${value.replaceAll("-", "+").replaceAll("_", "/")}${padding}`
        );
    } catch {
        return protocolFail();
    }
    const bytes = Uint8Array.from(
        binary,
        (character) => character.codePointAt(0) ?? protocolFail()
    );
    if (bytes.byteLength > maximumBytes || encodeBase64Url(bytes) !== value) {
        protocolFail();
    }
    return bytes;
}

export function encodePreviewGatewayBody(value: Uint8Array): string {
    if (value.byteLength > previewGatewayBodyMaximumBytes) protocolFail();
    return encodeBase64Url(value);
}

/**
 * Encodes one strict four-byte length-prefixed preview Gateway IPC frame.
 * @param value Validated request or response payload.
 * @returns One bounded binary frame.
 */
export function encodePreviewGatewayBrokerFrame(
    value: PreviewGatewayBrokerRequest | PreviewGatewayBrokerResponse
): Uint8Array {
    const parsed =
        "operation" in value
            ? v.parse(requestSchema, value)
            : v.parse(responseSchema, value);
    const bytes = new TextEncoder().encode(JSON.stringify(parsed));
    if (bytes.byteLength === 0 || bytes.byteLength > previewGatewayFrameMaximumBytes) {
        protocolFail();
    }
    const frame = new Uint8Array(4 + bytes.byteLength);
    new DataView(frame.buffer).setUint32(0, bytes.byteLength, false);
    frame.set(bytes, 4);
    return frame;
}

/** Incrementally decodes one bounded preview Gateway IPC frame. */
export class PreviewGatewayBrokerFrameDecoder {
    #buffer = new Uint8Array();

    public finish(): void {
        if (this.#buffer.byteLength !== 0) protocolFail();
    }

    public push(data: Uint8Array): readonly unknown[] {
        if (
            data.byteLength === 0 ||
            this.#buffer.byteLength + data.byteLength >
                previewGatewayFrameMaximumBytes + 4
        ) {
            protocolFail();
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
            if (bodyLength === 0 || bodyLength > previewGatewayFrameMaximumBytes) {
                protocolFail();
            }
            if (this.#buffer.byteLength < bodyLength + 4) break;
            let text: string;
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(
                    this.#buffer.subarray(4, bodyLength + 4)
                );
            } catch {
                protocolFail();
            }
            const parsed = parseJsonText(text);
            if (parsed === undefined) protocolFail();
            messages.push(parsed);
            this.#buffer = this.#buffer.slice(bodyLength + 4);
        }
        return messages;
    }
}

export function parsePreviewGatewayBrokerRequest(
    value: unknown,
    bodyMaximumBytes: number
): Readonly<{
    body: Uint8Array;
    id: string;
    operation: PreviewGatewayOperation;
}> {
    try {
        const parsed = v.parse(requestSchema, value);
        return Object.freeze({
            body: decodeBase64Url(parsed.body, bodyMaximumBytes),
            id: parsed.id,
            operation: parsed.operation,
        });
    } catch (error) {
        if (error instanceof PreviewGatewayBrokerProtocolError) throw error;
        return protocolFail();
    }
}

export function parsePreviewGatewayBrokerResponse(
    value: unknown,
    bodyMaximumBytes: number
):
    | Readonly<{ body: Uint8Array; id: string; status: "ok" }>
    | Readonly<{ id: string; reason: "unavailable"; status: "error" }> {
    try {
        const parsed = v.parse(responseSchema, value);
        return parsed.status === "ok"
            ? Object.freeze({
                  body: decodeBase64Url(parsed.body, bodyMaximumBytes),
                  id: parsed.id,
                  status: parsed.status,
              })
            : parsed;
    } catch (error) {
        if (error instanceof PreviewGatewayBrokerProtocolError) throw error;
        return protocolFail();
    }
}
