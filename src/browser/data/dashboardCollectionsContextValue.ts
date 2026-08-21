import { createContext, use } from "react";

import type { DashboardBrowserCollections } from "./dashboardCollections.ts";

/** Internal context shared by the collection provider and feature hooks. */
export const dashboardCollectionsContext = createContext<
    DashboardBrowserCollections | undefined
>(undefined);

/**
 * Reads the normalized collection registry for the current browser runtime.
 * @returns Browser-owned TanStack DB collections.
 */
export function useDashboardBrowserCollections(): DashboardBrowserCollections {
    const collections = use(dashboardCollectionsContext);
    if (collections === undefined) {
        throw new TypeError("Dashboard collections provider is missing");
    }
    return collections;
}
