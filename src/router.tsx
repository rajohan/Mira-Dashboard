import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
} from "@tanstack/react-router";

import { Layout } from "./components/layout/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Files } from "./pages/Files";
import { Login } from "./pages/Login";
import { Logs } from "./pages/Logs";
import { Metrics } from "./pages/Metrics";
import { Moltbook } from "./pages/Moltbook";
import { Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";
import { Tasks } from "./pages/Tasks";

// Root route (no component, just outlet)
const rootRoute = createRootRoute({
    component: () => <Outlet />,
});

// Login route (public)
const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: Login,
});

// Authenticated layout wrapper
const authenticatedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authenticated",
    component: () => (
        <Layout>
            <Outlet />
        </Layout>
    ),
});

// Dashboard (index)
const indexRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/",
    component: Dashboard,
});

// Tasks
const tasksRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/tasks",
    component: Tasks,
});

// Sessions
const sessionsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/sessions",
    component: Sessions,
});

// Logs
const logsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/logs",
    component: Logs,
});

// Files
const filesRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/files",
    component: Files,
});

// Metrics
const metricsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/metrics",
    component: Metrics,
});

// Moltbook
const moltbookRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/moltbook",
    component: Moltbook,
});

// Settings
const settingsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/settings",
    component: Settings,
});

// Route tree
const routeTree = rootRoute.addChildren([
    loginRoute,
    authenticatedRoute.addChildren([
        indexRoute,
        tasksRoute,
        sessionsRoute,
        logsRoute,
        filesRoute,
        metricsRoute,
        moltbookRoute,
        settingsRoute,
    ]),
]);

// Create router
export const router = createRouter({ routeTree });

// Type declaration for router
declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
