import { database } from "../../database.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";

export const LOG_ROTATION_STATE_KEY = "log_rotation.state";

/**
 * Preserves the last log-rotation state while renewing its cache envelope.
 * @returns Refreshed cache keys.
 */
export function refreshLogRotationStateCache(): { refreshed: string[] } {
    const row = database
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(LOG_ROTATION_STATE_KEY) as undefined | { data_json?: string | undefined };
    let data: unknown = { version: 1, files: {} };
    let preserveExistingData = false;
    if (row?.data_json) {
        try {
            data = JSON.parse(row.data_json) as unknown;
            preserveExistingData = true;
        } catch {
            data = { version: 1, files: {} };
        }
    } else {
        preserveExistingData = true;
    }
    writeCacheSuccess({
        key: LOG_ROTATION_STATE_KEY,
        data,
        source: "backend",
        ttl: 90 * 24,
        ttlUnit: "hours",
        metadata: {
            producer: "refreshCacheProducer",
            workflow: "Log Rotation - Foundation",
        },
        preserveExistingData,
    });
    return { refreshed: [LOG_ROTATION_STATE_KEY] };
}
