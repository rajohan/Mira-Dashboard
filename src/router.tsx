import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
} from "@tanstack/react-router";

import { Layout } from "./components/layout/Layout";
import { authStore, authActions } from "./stores/authStore";
import { Agents } from "./pages/Agents";
import { Chat } from "./pages/Chat";
import { Cron } from "./pages/Cron";
import { Dashboard } from "./pages/Dashboard";
import { Docker } from "./pages/Docker";
import { Files } from "./pages/Files";
import { Login } from "./pages/Login";
import { Logs } from "./pages/Logs";
import { Metrics } from "./pages/Metrics";
import { Moltbook } from "./pages/Moltbook";
import { Office3D } from "./pages/Office3D";
import { OrgChart } from "./pages/OrgChart";
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
    beforeLoad: async () => {
        await authActions.initialize();
        if (authStore.state.isAuthenticated) {
            throw redirect({ to: "/" });
        }
    },
    component: Login,
});

const authenticatedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authenticated",
    beforeLoad: async () => {
        await authActions.initialize();
        if (!authStore.state.isAuthenticated) {
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

const chatRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/chat",
    component: Chat,
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

const dockerRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/docker",
    component: Docker,
});

const metricsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/metrics",
    component: Metrics,
});

const orgChartRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/org-chart",
    component: OrgChart,
});

const office3DRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/office-3d",
    component: Office3D,
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
        chatRoute,
        logsRoute,
        cronRoute,
        filesRoute,
        dockerRoute,
        metricsRoute,
        orgChartRoute,
        office3DRoute,
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
