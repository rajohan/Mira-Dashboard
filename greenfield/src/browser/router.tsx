import {
    createRootRoute,
    createRoute,
    createRouter,
    type RouterHistory,
} from "@tanstack/react-router";

import { DashboardShell, OverviewRoute } from "./routeComponents.tsx";

const rootRoute = createRootRoute({ component: DashboardShell });
const overviewRoute = createRoute({
    component: OverviewRoute,
    getParentRoute: () => rootRoute,
    path: "/",
});
const routeTree = rootRoute.addChildren([overviewRoute]);

/**
 * Creates one browser router owned by the browser composition root.
 * @param history Optional memory history for deterministic browser tests.
 * @returns Typed Dashboard browser router.
 */
export function createDashboardRouter(history?: RouterHistory) {
    return createRouter({
        defaultPreload: "intent",
        defaultPreloadStaleTime: 30_000,
        ...(history === undefined ? {} : { history }),
        routeTree,
        scrollRestoration: true,
    });
}

export type DashboardRouter = ReturnType<typeof createDashboardRouter>;
