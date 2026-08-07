import { createContext, use } from "react";

import type { DashboardTrpcClient } from "./trpcClient.ts";

/** Internal context shared by the browser provider and typed consumer hook. */
export const dashboardTrpcContext = createContext<DashboardTrpcClient | undefined>(
    undefined
);

/**
 * Reads the browser-owned contract client.
 * @returns The configured client.
 */
export function useDashboardTrpcClient(): DashboardTrpcClient {
    const client = use(dashboardTrpcContext);
    if (client === undefined) {
        throw new TypeError("Dashboard tRPC provider is missing");
    }
    return client;
}
