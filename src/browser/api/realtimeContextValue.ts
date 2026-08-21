import { createContext, use } from "react";

import type { DashboardRealtimeHub } from "./realtimeHub.ts";

/** Internal context shared by the realtime provider and feature hooks. */
export const dashboardRealtimeContext = createContext<DashboardRealtimeHub | undefined>(
    undefined
);

/**
 * Reads the browser-owned realtime client.
 * @returns The configured tracked-SSE client.
 */
export function useDashboardRealtimeHub(): DashboardRealtimeHub {
    const hub = use(dashboardRealtimeContext);
    if (hub === undefined) {
        throw new TypeError("Dashboard realtime provider is missing");
    }
    return hub;
}
