import { json } from "../http.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { routeFailureResponse } from "../routeSupport.ts";
import { getDatabaseOverview } from "../services/databaseOverview.ts";

const logger = createStructuredLogger("database-route");

export const databaseRoutes = {
    "/api/database/overview": {
        GET: async () => {
            try {
                return json(await getDatabaseOverview());
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
