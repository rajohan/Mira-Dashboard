import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
} from "@tanstack/react-router";
import { Suspense, lazy } from "react";

import { Layout } from "./components/layout/Layout";
import { LoadingSpinner } from "./components/ui/LoadingSpinner";

// Lazy-loaded page components
const Dashboard = lazy(() => import("./pages/Dashboard").then(m => ({ default: m.Dashboard })));
const Files = lazy(() => import("./pages/Files").then(m => ({ default: m.Files })));
const Login = lazy(() => import("./pages/Login").then(m => ({ default: m.Login })));
const Logs = lazy(() => import("./pages/Logs").then(m => ({ default: m.Logs })));
const Metrics = lazy(() => import("./pages/Metrics").then(m => ({ default: m.Metrics })));
const Moltbook = lazy(() => import("./pages/Moltbook").then(m => ({ default: m.Moltbook })));
const Sessions = lazy(() => import("./pages/Sessions").then(m => ({ default: m.Sessions })));
const Settings = lazy(() => import("./pages/Settings").then(m => ({ default: m.Settings })));
const Tasks = lazy(() => import("./pages/Tasks").then(m => ({ default: m.Tasks })));

// Wrapper for lazy components with Suspense
function LazyPage({ component: Component }: { component: React.LazyExoticComponent<React.ComponentType> }) {
    return (
        <Suspense fallback={<LoadingSpinner />}>
            <Component />
        </Suspense>
    );
}

// Root route (no component, just outlet)
const rootRoute = createRootRoute({
    component: () => <Outlet />,
});

// Login route (public)
const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => <LazyPage component={Login} />,
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
    component: () => <LazyPage component={Dashboard} />,
});

// Tasks
const tasksRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/tasks",
    component: () => <LazyPage component={Tasks} />,
});

// Sessions
const sessionsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/sessions",
    component: () => <LazyPage component={Sessions} />,
});

// Logs
const logsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/logs",
    component: () => <LazyPage component={Logs} />,
});

// Files
const filesRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/files",
    component: () => <LazyPage component={Files} />,
});

// Metrics
const metricsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/metrics",
    component: () => <LazyPage component={Metrics} />,
});

// Moltbook
const moltbookRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/moltbook",
    component: () => <LazyPage component={Moltbook} />,
});

// Settings
const settingsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/settings",
    component: () => <LazyPage component={Settings} />,
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