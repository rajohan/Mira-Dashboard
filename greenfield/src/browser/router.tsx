import {
    createRootRoute,
    createRoute,
    createRouter,
    type RouterHistory,
} from "@tanstack/react-router";

import { parseJobsRouteSearch } from "./jobs/jobRouteSearch.ts";
import { DashboardShell } from "./layout/DashboardShell.tsx";
import {
    parseIncidentsRouteSearch,
    parseReportsRouteSearch,
} from "./monitoring/monitoringRouteSearch.ts";
import { LoadingState } from "./ui/LoadingState.tsx";

const rootRoute = createRootRoute({ component: DashboardShell });
const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
}).lazy(() => import("./routes/overview.lazy.tsx").then((module) => module.Route));
const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
}).lazy(() => import("./routes/login.lazy.tsx").then((module) => module.Route));
const accountSecurityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/account-security",
}).lazy(() => import("./routes/accountSecurity.lazy.tsx").then((module) => module.Route));
const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
}).lazy(() => import("./routes/agents.lazy.tsx").then((module) => module.Route));
const tasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks",
}).lazy(() => import("./routes/tasks.lazy.tsx").then((module) => module.Route));
const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: parseJobsRouteSearch,
}).lazy(() => import("./routes/jobs.lazy.tsx").then((module) => module.Route));
const reportsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/reports",
    validateSearch: parseReportsRouteSearch,
}).lazy(() => import("./routes/reports.lazy.tsx").then((module) => module.Route));
const incidentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/incidents",
    validateSearch: parseIncidentsRouteSearch,
}).lazy(() => import("./routes/incidents.lazy.tsx").then((module) => module.Route));
const routeTree = rootRoute.addChildren([
    overviewRoute,
    loginRoute,
    accountSecurityRoute,
    agentsRoute,
    incidentsRoute,
    jobsRoute,
    reportsRoute,
    tasksRoute,
]);

/**
 * Creates one browser router owned by the browser composition root.
 * @param history Optional memory history for deterministic browser tests.
 * @returns Typed Dashboard browser router.
 */
export function createDashboardRouter(history?: RouterHistory) {
    return createRouter({
        defaultPendingComponent: () => <LoadingState label="Loading page…" />,
        defaultPreload: "intent",
        defaultPreloadStaleTime: 30_000,
        ...(history === undefined ? {} : { history }),
        routeTree,
        scrollRestoration: true,
    });
}

export type DashboardRouter = ReturnType<typeof createDashboardRouter>;
