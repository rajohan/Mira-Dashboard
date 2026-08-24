import { useEffect, useState, type ReactNode } from "react";

import type { DashboardRealtimeClient } from "./realtimeClient.ts";
import { dashboardRealtimeContext } from "./realtimeContextValue.ts";
import { createDashboardRealtimeHub } from "./realtimeHub.ts";

interface DashboardRealtimeProviderProps {
    readonly children: ReactNode;
    readonly client: DashboardRealtimeClient;
}

/** @returns Browser realtime client context for feature-level subscriptions. */
export function DashboardRealtimeProvider({
    children,
    client,
}: DashboardRealtimeProviderProps) {
    const [hub] = useState(() => createDashboardRealtimeHub(client));
    useEffect(() => {
        hub.resume();
        return () => hub.pause();
    }, [hub]);

    return (
        <dashboardRealtimeContext.Provider value={hub}>
            {children}
        </dashboardRealtimeContext.Provider>
    );
}
