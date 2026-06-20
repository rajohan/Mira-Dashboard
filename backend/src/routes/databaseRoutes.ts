import { json } from "../http.ts";
import { getDatabaseOverview } from "../services/databaseOverview.ts";

export const databaseRoutes = {
    "/api/database/overview": {
        GET: async () => {
            try {
                return json(await getDatabaseOverview());
            } catch (error) {
                const safeError = {
                    code: (error as NodeJS.ErrnoException).code,
                    name: (error as Error).name,
                };
                console.error(
                    "[databaseRoutes] Failed to load database overview",
                    safeError
                );
                return json(
                    { error: "Failed to load database overview" },
                    { status: 500 }
                );
            }
        },
    },
} as const;
