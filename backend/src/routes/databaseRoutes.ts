import {
    type DatabaseOverviewResponse,
    parseDatabaseOverviewResponse,
} from "../../../contracts/database.ts";
import { json } from "../http.ts";
import { getCacheEntry, parseJsonField } from "../lib/cacheStore.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { isDevelopmentSafeMode } from "../requestPolicy.ts";
import { routeFailureResponse } from "../routeSupport.ts";
import {
    getDatabaseOverview,
    getIsolatedDatabaseOverview,
} from "../services/databaseOverview.ts";

const logger = createStructuredLogger("database-route");

function getIsolatedDatabaseSnapshot(): DatabaseOverviewResponse {
    const entry = getCacheEntry("database.summary");
    const snapshot = parseJsonField<unknown>(entry?.data ?? "");
    if (!entry || snapshot === undefined) {
        throw new Error("Isolated database snapshot is unavailable");
    }
    return parseDatabaseOverviewResponse(
        {
            ...getIsolatedDatabaseOverview(snapshot),
            checkedAt: entry.updated_at ?? new Date().toISOString(),
        },
        "database.summary"
    );
}

export const databaseRoutes = {
    "/api/database/overview": {
        GET: async () => {
            try {
                const overview = isDevelopmentSafeMode()
                    ? getIsolatedDatabaseSnapshot()
                    : parseDatabaseOverviewResponse(
                          await getDatabaseOverview(),
                          "database.overview"
                      );
                return json(overview);
            } catch (error) {
                const safeError =
                    error instanceof Error
                        ? {
                              code:
                                  "code" in error && typeof error.code === "string"
                                      ? error.code
                                      : "UNKNOWN",
                              name: error.name || "Error",
                          }
                        : { code: "UNKNOWN", name: "NonErrorThrown" };
                logger.error("database.overview_load_failed", { error: safeError });
                return routeFailureResponse({
                    context: "database",
                    message: "Failed to load database overview",
                    status: 500,
                });
            }
        },
    },
} as const;
