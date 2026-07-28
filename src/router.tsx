import {
    createRootRoute,
    createRoute,
    createRouter,
    lazyRouteComponent,
    Outlet,
    redirect,
} from "@tanstack/react-router";

import { Layout } from "./components/layout/Layout";
import { authActions, authStore } from "./stores/authStore";

const Agents = lazyRouteComponent(() => import("./pages/Agents"), "Agents");
const Chat = lazyRouteComponent(() => import("./pages/Chat"), "Chat");
const Dashboard = lazyRouteComponent(() => import("./pages/Dashboard"), "Dashboard");
const Database = lazyRouteComponent(() => import("./pages/Database"), "Database");
const Delivery = lazyRouteComponent(() => import("./pages/Delivery"), "Delivery");
const Docker = lazyRouteComponent(() => import("./pages/Docker"), "Docker");
const Files = lazyRouteComponent(() => import("./pages/Files"), "Files");
const Jobs = lazyRouteComponent(() => import("./pages/Jobs"), "Jobs");
const Login = lazyRouteComponent(() => import("./pages/Login"), "Login");
const Logs = lazyRouteComponent(() => import("./pages/Logs"), "Logs");
const Moltbook = lazyRouteComponent(() => import("./pages/Moltbook"), "Moltbook");
const Reports = lazyRouteComponent(() => import("./pages/Reports"), "Reports");
const Sessions = lazyRouteComponent(() => import("./pages/Sessions"), "Sessions");
const Settings = lazyRouteComponent(() => import("./pages/Settings"), "Settings");
const Tasks = lazyRouteComponent(() => import("./pages/Tasks"), "Tasks");
const Terminal = lazyRouteComponent(() => import("./pages/Terminal"), "Terminal");

const rootRoute = createRootRoute({
    component: () => <Outlet />,
});

const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    beforeLoad: async () => {
        await authActions.initialize();
        if (authStore.state.isAuthenticated) {
            if (authStore.state.mfaEnabled) {
                throw redirect({ to: "/" });
            }
            throw redirect({
                to: "/settings",
                search: { view: "dashboard" },
            });
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

/** Keeps only a non-empty OpenClaw session key in the chat URL. */
export function normalizeChatSearch(search: Record<string, unknown>): {
    session?: string;
} {
    const session = typeof search.session === "string" ? search.session.trim() : "";
    return session ? { session } : {};
}

const chatRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/chat",
    validateSearch: normalizeChatSearch,
    component: Chat,
});

const logsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/logs",
    component: Logs,
});

const jobsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/jobs",
    component: Jobs,
});

const reportsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/reports",
    component: Reports,
});

const deliveryRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/delivery",
    component: Delivery,
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

/** Keeps only the supported Settings tab in the URL. */
export function normalizeSettingsSearch(search: Record<string, unknown>): {
    view?: "dashboard" | "openclaw";
} {
    return search.view === "dashboard" || search.view === "openclaw"
        ? { view: search.view }
        : {};
}

const settingsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/settings",
    validateSearch: normalizeSettingsSearch,
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
        jobsRoute,
        reportsRoute,
        deliveryRoute,
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
