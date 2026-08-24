import type { ReactNode } from "react";

import type { DashboardBrowserCollections } from "./dashboardCollections.ts";
import { dashboardCollectionsContext as DashboardCollectionsContext } from "./dashboardCollectionsContextValue.ts";

interface DashboardCollectionsProviderProps {
    readonly children: ReactNode;
    readonly collections: DashboardBrowserCollections;
}

/** @returns The browser-owned normalized collection registry provider. */
export function DashboardCollectionsProvider({
    children,
    collections,
}: DashboardCollectionsProviderProps) {
    return (
        <DashboardCollectionsContext value={collections}>
            {children}
        </DashboardCollectionsContext>
    );
}
