import * as v from "valibot";

import {
    finiteNumberSchema,
    jsonObjectSchema,
    parseContract,
    positiveIntegerSchema,
    strictJsonObjectSchema,
} from "./runtime";
import { sessionSchema } from "./sessions";

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const dashboardSocketRequestSchema = strictJsonObjectSchema({
    channel: v.optional(nonEmptyStringSchema),
    id: v.optional(nonEmptyStringSchema),
    method: v.optional(nonEmptyStringSchema),
    params: v.optional(jsonObjectSchema),
    timeoutMs: v.optional(positiveIntegerSchema),
    type: v.optional(nonEmptyStringSchema),
    userActivity: v.optional(v.boolean()),
});

export const socketEnvelopeSchema = v.object({
    code: v.optional(v.string()),
    error: v.optional(v.unknown()),
    event: v.optional(v.string()),
    gatewayConnected: v.optional(v.boolean()),
    history: v.optional(v.boolean()),
    id: v.optional(v.string()),
    isOk: v.optional(v.boolean()),
    line: v.optional(v.string()),
    lineId: v.optional(v.string()),
    payload: v.optional(v.unknown()),
    runtimeRecordedAt: v.optional(finiteNumberSchema),
    runtimeSequence: v.optional(finiteNumberSchema),
    sessions: v.optional(v.array(sessionSchema)),
    type: v.pipe(v.string(), v.trim(), v.nonEmpty()),
});

export type SocketEnvelope = v.InferOutput<typeof socketEnvelopeSchema>;
export type DashboardSocketRequest = v.InferOutput<typeof dashboardSocketRequestSchema>;

/**
 * Parses a browser-to-Dashboard WebSocket request at the server boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a browser-to-Dashboard WebSocket request at the server boundary.
 */
export function parseDashboardSocketRequest(
    value: unknown,
    path = "socketRequest"
): DashboardSocketRequest {
    return parseContract(dashboardSocketRequestSchema, value, path);
}

/**
 * Reads a browser-to-Dashboard request without throwing from a socket callback.
 * @param value Value to process.
 * @returns Read a browser-to-Dashboard request without throwing from a socket callback.
 */
export function readDashboardSocketRequest(
    value: unknown
): DashboardSocketRequest | undefined {
    const result = v.safeParse(dashboardSocketRequestSchema, value);
    return result.success ? result.output : undefined;
}

/**
 * Parses one Dashboard WebSocket envelope before routing it in the browser.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one Dashboard WebSocket envelope before routing it in the browser.
 */
export function parseSocketEnvelope(
    value: unknown,
    path = "socketMessage"
): SocketEnvelope {
    return parseContract(socketEnvelopeSchema, value, path);
}

const unknownSessionsSchema = v.array(v.unknown());
const sessionsPayloadSchema = v.object({
    sessions: unknownSessionsSchema,
});

/**
 * Reads a sessions array from an unknown Gateway payload object.
 * @param value Value to process.
 * @returns Read a sessions array from an unknown Gateway payload object.
 */
export function readSessionsPayload(value: unknown): unknown[] | undefined {
    const result = v.safeParse(sessionsPayloadSchema, value);
    return result.success ? result.output.sessions : undefined;
}

const sessionsResponsePayloadSchema = v.union([
    unknownSessionsSchema,
    sessionsPayloadSchema,
    v.object({
        data: v.optional(sessionsPayloadSchema),
        result: v.optional(sessionsPayloadSchema),
    }),
]);

/**
 * Reads the currently supported sessions.list result wrappers.
 * @param value Value to process.
 * @returns Read the currently supported sessions.list result wrappers.
 */
export function readSessionsResponsePayload(value: unknown): unknown[] | undefined {
    const result = v.safeParse(sessionsResponsePayloadSchema, value);
    if (!result.success) return undefined;
    const output = result.output;
    if (Array.isArray(output)) return output;
    if ("sessions" in output) return output.sessions;
    return output.result?.sessions ?? output.data?.sessions;
}
