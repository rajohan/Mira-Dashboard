import * as v from "valibot";

import {
    monitoringJsonObjectSchema,
    type JsonObject,
} from "../../../contracts/monitoring.ts";

function serializeCanonicalJson(value: unknown, ancestors: Set<object>): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
            throw new TypeError("Monitoring JSON number is invalid");
        }
        return JSON.stringify(value);
    }
    if (typeof value !== "object" || ancestors.has(value)) {
        throw new TypeError("Monitoring JSON value is invalid");
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Monitoring JSON object is invalid");
    }

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const entries: string[] = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!(index in value)) {
                    throw new TypeError("Monitoring JSON array is sparse");
                }
                entries.push(serializeCanonicalJson(value[index], ancestors));
            }
            return `[${entries.join(",")}]`;
        }

        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .toSorted()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${serializeCanonicalJson(record[key], ancestors)}`
            )
            .join(",")}}`;
    } finally {
        ancestors.delete(value);
    }
}

/**
 * Serializes validated JSON with recursively sorted object keys.
 * @param value Validated JSON value.
 * @returns Canonical JSON text suitable for identity and persistence checks.
 */
export function serializeCanonicalMonitoringJson(value: unknown): string {
    return serializeCanonicalJson(value, new Set());
}

/**
 * Serializes a previously validated monitoring object as durable plain JSON.
 * @param value Validated monitoring object.
 * @returns Durable plain-JSON text.
 */
export function serializeMonitoringJsonObject(value: JsonObject): string {
    return serializeCanonicalMonitoringJson(value);
}

/**
 * Parses and revalidates one persisted monitoring JSON object.
 * @param text Persisted JSON bytes.
 * @returns Validated bounded monitoring object.
 */
export function parseMonitoringJsonObject(text: string): JsonObject {
    return v.parse(monitoringJsonObjectSchema, JSON.parse(text) as unknown);
}
