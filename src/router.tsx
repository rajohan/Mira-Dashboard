import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
} from "@tanstack/react-router";

import { Layout } from "./components/layout/Layout";
import { Agents } from "./pages/Agents";
import { Chat } from "./pages/Chat";
import { Cron } from "./pages/Cron";
import { Dashboard } from "./pages/Dashboard";
import { Database } from "./pages/Database";
import { Docker } from "./pages/Docker";
import { Files } from "./pages/Files";
import { Login } from "./pages/Login";
import { Logs } from "./pages/Logs";
import { Moltbook } from "./pages/Moltbook";
import { PullRequests } from "./pages/PullRequests";
import { Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";
import { Tasks } from "./pages/Tasks";
import { Terminal } from "./pages/Terminal";
import { authActions, authStore } from "./stores/authStore";

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

const pullRequestsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/pull-requests",
    component: PullRequests,
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

const databaseRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/database",
    component: Database,
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
        pullRequestsRoute,
        filesRoute,
        dockerRoute,
        databaseRoute,
        moltbookRoute,
        terminalRoute,
        settingsRoute,
    ]),
]);

/** Defines router. */
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
    /** Represents register. */
    interface Register {
        router: typeof router;
    }
}
