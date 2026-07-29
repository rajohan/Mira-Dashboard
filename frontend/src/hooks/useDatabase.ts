import {
    type DatabaseOverviewResponse,
    parseDatabaseOverviewResponse,
} from "../../../contracts/database";
import { useCacheEntry } from "./useCache";

/**
 * Provides database overview.
 * @returns The database overview.
 */
export function useDatabaseOverview() {
    const query = useCacheEntry<DatabaseOverviewResponse>(
        "database.summary",
        parseDatabaseOverviewResponse,
        60_000,
        {
            refreshOnMissing: true,
        }
    );
    const cacheEnvelope = query.data;
    const data =
        cacheEnvelope && ["fresh", "stale", "error"].includes(cacheEnvelope.status)
            ? cacheEnvelope.data
            : undefined;
    const error =
        query.error ??
        (cacheEnvelope?.status === "error"
            ? new Error(cacheEnvelope.errorMessage || "Database metrics refresh failed.")
            : undefined);
    return { ...query, data, error };
}
