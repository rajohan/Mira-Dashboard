import { dashboardLogContentResponse } from "./logRoutes/dashboard.ts";
import {
    openClawLogContentResponse,
    openClawLogInfoResponse,
} from "./logRoutes/openClaw.ts";

export const logRoutes = {
    "/api/logs/dashboard": {
        GET: dashboardLogContentResponse,
    },
    "/api/logs/openclaw/content": {
        GET: openClawLogContentResponse,
    },
    "/api/logs/openclaw/files": {
        GET: openClawLogInfoResponse,
    },
} as const;
