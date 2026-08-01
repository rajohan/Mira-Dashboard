import { getCacheEntry, parseJsonField } from "../../lib/cacheStore.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import {
    emptyLogRotationState,
    LOG_ROTATION_STATE_KEY,
    normalizeLogRotationState,
} from "../logRotation/state.ts";

export { LOG_ROTATION_STATE_KEY } from "../logRotation/state.ts";

/**
 * Preserves the last log-rotation state while renewing its cache envelope.
 * @returns Refreshed cache keys.
 */
export function refreshLogRotationStateCache(): { refreshed: string[] } {
    const existingData = getCacheEntry(LOG_ROTATION_STATE_KEY)?.data;
    const parsed = existingData ? parseJsonField<unknown>(existingData) : undefined;
    const data =
        parsed === undefined
            ? emptyLogRotationState()
            : normalizeLogRotationState(parsed);
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
    });
    return { refreshed: [LOG_ROTATION_STATE_KEY] };
}
