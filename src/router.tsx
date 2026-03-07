import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
} from "@tanstack/react-router";

import { Layout } from "./components/layout/Layout";
import { Agents } from "./pages/Agents";
import { Cron } from "./pages/Cron";
import { Dashboard } from "./pages/Dashboard";
import { Files } from "./pages/Files";
import { Login } from "./pages/Login";
import { Logs } from "./pages/Logs";
import { Metrics } from "./pages/Metrics";
import { Moltbook } from "./pages/Moltbook";
import { Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";
import { Tasks } from "./pages/Tasks";
import { Terminal } from "./pages/Terminal";

const rootRoute = createRootRoute({
    component: () => <Outlet />,
});

const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: Login,
});

const authenticatedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authenticated",
    beforeLoad: () => {
        const token =
            typeof window === "undefined" ? null : localStorage.getItem("openclaw_token");
        if (!token) {
            throw redirect({ to: "/login" });
        }
    },
    component: () => (
        <Layout>
            <Outlet />
        </Layout>
    ),
});

const indexRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/",
    component: Dashboard,
});

const tasksRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/tasks",
    component: Tasks,
});

const agentsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/agents",
    component: Agents,
});

const sessionsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/sessions",
    component: Sessions,
});

const logsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/logs",
    component: Logs,
});

const cronRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/cron",
    component: Cron,
});

const filesRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/files",
    component: Files,
});

const metricsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/metrics",
    component: Metrics,
});

const moltbookRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/moltbook",
    component: Moltbook,
});

const settingsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/settings",
    component: Settings,
});

const terminalRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/terminal",
    component: Terminal,
});

const routeTree = rootRoute.addChildren([
    loginRoute,
    authenticatedRoute.addChildren([
        indexRoute,
        tasksRoute,
        agentsRoute,
        sessionsRoute,
        logsRoute,
        cronRoute,
        filesRoute,
        metricsRoute,
        moltbookRoute,
        terminalRoute,
        settingsRoute,
    ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
