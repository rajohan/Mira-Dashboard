import { getCacheEntry, parseJsonField } from "../../lib/cacheStore.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import { emptyLogRotationState, LOG_ROTATION_STATE_KEY } from "../logRotation/state.ts";

export { LOG_ROTATION_STATE_KEY } from "../logRotation/state.ts";

/**
 * Preserves the last log-rotation state while renewing its cache envelope.
 * @returns Refreshed cache keys.
 */
export function refreshLogRotationStateCache(): { refreshed: string[] } {
    const existingData = getCacheEntry(LOG_ROTATION_STATE_KEY)?.data;
    let data: unknown = emptyLogRotationState();
    let preserveExistingData = false;
    if (existingData) {
        const parsed = parseJsonField<unknown>(existingData);
        if (parsed !== undefined) {
            data = parsed;
            preserveExistingData = true;
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
