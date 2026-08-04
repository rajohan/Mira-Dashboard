import type { JsonObject } from "../../../contracts/monitoring.ts";

/**
 * Serializes a previously validated monitoring object as durable plain JSON.
 * @param value Validated monitoring object.
 * @returns Durable plain-JSON text.
 */
export function serializeMonitoringJsonObject(value: JsonObject): string {
    return JSON.stringify(value);
}
