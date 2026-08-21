import type { ReactNode } from "react";

import type { DashboardTrpcClient } from "./trpcClient.ts";
import { dashboardTrpcContext as DashboardTrpcContext } from "./trpcContextValue.ts";

/** Browser tRPC provider dependencies. */
export interface DashboardTrpcProviderProps {
    readonly children: ReactNode;
    readonly client: DashboardTrpcClient;
}

/**
 * Provides the single browser-owned contract client to route components.
 * @returns The provider boundary.
 */
export function DashboardTrpcProvider({ children, client }: DashboardTrpcProviderProps) {
    return <DashboardTrpcContext value={client}>{children}</DashboardTrpcContext>;
}
