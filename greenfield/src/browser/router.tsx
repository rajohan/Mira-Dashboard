import {
    createRootRoute,
    createRoute,
    createRouter,
    type ParsedLocation,
    type RouterHistory,
} from "@tanstack/react-router";

import { parseChatRouteSearch } from "./chat/chatRouteSearch.ts";
import { normalizeDatabaseSearch } from "./database/databaseRouteSearch.ts";
import { parseJobsRouteSearch } from "./jobs/jobRouteSearch.ts";
import { DashboardShell } from "./layout/DashboardShell.tsx";
import {
    parseIncidentsRouteSearch,
    parseReportsRouteSearch,
} from "./monitoring/monitoringRouteSearch.ts";
import { normalizeSettingsSearch } from "./settings/settingsRouteSearch.ts";
import { parseTerminalRouteSearch } from "./terminal/terminalRouteSearch.ts";
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
const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    validateSearch: parseChatRouteSearch,
}).lazy(() => import("./routes/chat.lazy.tsx").then((module) => module.Route));
const filesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/files",
}).lazy(() => import("./routes/files.lazy.tsx").then((module) => module.Route));
const databaseRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/database",
    validateSearch: normalizeDatabaseSearch,
}).lazy(() => import("./routes/database.lazy.tsx").then((module) => module.Route));
const dockerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docker",
}).lazy(() => import("./routes/docker.lazy.tsx").then((module) => module.Route));
const deliveryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/delivery",
}).lazy(() => import("./routes/delivery.lazy.tsx").then((module) => module.Route));
const logsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/logs",
}).lazy(() => import("./routes/logs.lazy.tsx").then((module) => module.Route));
const moltbookRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/moltbook",
}).lazy(() => import("./routes/moltbook.lazy.tsx").then((module) => module.Route));
const terminalRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/terminal",
    validateSearch: parseTerminalRouteSearch,
}).lazy(() => import("./routes/terminal.lazy.tsx").then((module) => module.Route));
const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: parseJobsRouteSearch,
}).lazy(() => import("./routes/jobs.lazy.tsx").then((module) => module.Route));
const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions",
}).lazy(() => import("./routes/sessions.lazy.tsx").then((module) => module.Route));
const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    validateSearch: normalizeSettingsSearch,
}).lazy(() => import("./routes/settings.lazy.tsx").then((module) => module.Route));
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
    chatRoute,
    databaseRoute,
    deliveryRoute,
    dockerRoute,
    filesRoute,
    incidentsRoute,
    jobsRoute,
    logsRoute,
    moltbookRoute,
    reportsRoute,
    sessionsRoute,
    settingsRoute,
    tasksRoute,
    terminalRoute,
]);

/**
 * Keeps scroll state stable while filters/search parameters update within one page,
 * while still giving each pathname an independent restoration position.
 * @param location Resolved Dashboard location.
 * @returns Stable pathname-scoped scroll restoration key.
 */
export function dashboardScrollRestorationKey(
    location: Pick<ParsedLocation, "pathname">
): string {
    return location.pathname;
}

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
        getScrollRestorationKey: dashboardScrollRestorationKey,
        routeTree,
        scrollRestoration: true,
        scrollToTopSelectors: ["#dashboard-content"],
    });
}

export type DashboardRouter = ReturnType<typeof createDashboardRouter>;
