import { getCacheEntry, parseJsonField } from "../../lib/cacheStore.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import { getDatabaseOverview, getIsolatedDatabaseOverview } from "../databaseOverview.ts";
import { nowIso } from "./cacheProducerSupport.ts";

export const DATABASE_SUMMARY_KEY = "database.summary";

/**
 * Refreshes the database overview using the active runtime profile.
 * @returns Refreshed cache keys.
 */
export async function refreshDatabaseSummaryCache(): Promise<{ refreshed: string[] }> {
    const isIsolated =
        process.env.NODE_ENV !== "production" &&
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE === "1";
    const previousEntry = isIsolated ? getCacheEntry(DATABASE_SUMMARY_KEY) : undefined;
    const previous = isIsolated
        ? parseJsonField<unknown>(previousEntry?.data || "")
        : undefined;
    const payload = {
        checkedAt: nowIso(),
        ...(isIsolated
            ? getIsolatedDatabaseOverview(previous)
            : await getDatabaseOverview()),
    };
    writeCacheSuccess({
        key: DATABASE_SUMMARY_KEY,
        data: payload,
        source: "backend",
        ttl: 90,
        ttlUnit: "minutes",
        metadata: {
            producer: "refreshCacheProducer",
            profile: isIsolated ? "isolated" : "full",
            workflow: "Cache Foundation - Database Summary",
            refreshIntervalMinutes: 60,
        },
    });
    return { refreshed: [DATABASE_SUMMARY_KEY] };
}
