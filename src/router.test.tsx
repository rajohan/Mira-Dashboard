import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const authStore = { state: { isAuthenticated: false } };
    const authActions = { initialize: vi.fn() };
    const routes: Array<Record<string, unknown>> = [];
    const rootRoute = {
        addChildren: vi.fn((children: unknown[]) => ({ type: "root", children })),
    };

    return {
        authActions,
        authStore,
        createRootRoute: vi.fn(() => rootRoute),
        createRoute: vi.fn((config: Record<string, unknown>) => {
            const route = {
                ...config,
                addChildren: vi.fn((children: unknown[]) => ({ ...route, children })),
            };
            routes.push(route);
            return route;
        }),
        createRouter: vi.fn((config: unknown) => ({ type: "router", config })),
        redirect: vi.fn((target: unknown) => ({ type: "redirect", target })),
        rootRoute,
        routes,
    };
});

vi.mock("@tanstack/react-router", () => ({
    createRootRoute: mocks.createRootRoute,
    createRoute: mocks.createRoute,
    createRouter: mocks.createRouter,
    Outlet: () => <div data-testid="outlet" />,
    redirect: mocks.redirect,
}));

vi.mock("./components/layout/Layout", () => ({
    Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./pages/Agents", () => ({ Agents: () => <div>Agents</div> }));
vi.mock("./pages/Chat", () => ({ Chat: () => <div>Chat</div> }));
vi.mock("./pages/Cron", () => ({ Cron: () => <div>Cron</div> }));
vi.mock("./pages/Dashboard", () => ({ Dashboard: () => <div>Dashboard</div> }));
vi.mock("./pages/Database", () => ({ Database: () => <div>Database</div> }));
vi.mock("./pages/Docker", () => ({ Docker: () => <div>Docker</div> }));
vi.mock("./pages/Files", () => ({ Files: () => <div>Files</div> }));
vi.mock("./pages/Login", () => ({ Login: () => <div>Login</div> }));
vi.mock("./pages/Logs", () => ({ Logs: () => <div>Logs</div> }));
vi.mock("./pages/Moltbook", () => ({ Moltbook: () => <div>Moltbook</div> }));
vi.mock("./pages/PullRequests", () => ({
    PullRequests: () => <div>PullRequests</div>,
}));
vi.mock("./pages/Sessions", () => ({ Sessions: () => <div>Sessions</div> }));
vi.mock("./pages/Settings", () => ({ Settings: () => <div>Settings</div> }));
vi.mock("./pages/Tasks", () => ({ Tasks: () => <div>Tasks</div> }));
vi.mock("./pages/Terminal", () => ({ Terminal: () => <div>Terminal</div> }));

vi.mock("./stores/authStore", () => ({
    authActions: mocks.authActions,
    authStore: mocks.authStore,
}));

import { router } from "./router";

describe("router", () => {
    beforeEach(() => {
        mocks.authActions.initialize.mockClear();
        mocks.redirect.mockClear();
        mocks.authStore.state.isAuthenticated = false;
    });

    it("builds the dashboard route tree", () => {
        expect(router).toEqual({
            type: "router",
            config: expect.objectContaining({ routeTree: expect.any(Object) }),
        });
        expect(mocks.createRootRoute).toHaveBeenCalledTimes(1);
        expect(mocks.createRouter).toHaveBeenCalledTimes(1);

        const routePaths = mocks.routes
            .map((route) => route.path || route.id)
            .filter(Boolean);
        expect(routePaths).toEqual([
            "/login",
            "authenticated",
            "/",
            "/tasks",
            "/agents",
            "/sessions",
            "/chat",
            "/logs",
            "/cron",
            "/pull-requests",
            "/files",
            "/docker",
            "/database",
            "/moltbook",
            "/settings",
            "/terminal",
        ]);
    });

    it("allows login route for guests and redirects authenticated users home", async () => {
        const loginRoute = mocks.routes.find((route) => route.path === "/login") as {
            beforeLoad: () => Promise<void>;
        };

        await expect(loginRoute.beforeLoad()).resolves.toBeUndefined();
        expect(mocks.authActions.initialize).toHaveBeenCalledTimes(1);

        mocks.authStore.state.isAuthenticated = true;
        await expect(loginRoute.beforeLoad()).rejects.toEqual({
            type: "redirect",
            target: { to: "/" },
        });
    });

    it("guards authenticated routes from guests", async () => {
        const authenticatedRoute = mocks.routes.find(
            (route) => route.id === "authenticated"
        ) as { beforeLoad: () => Promise<void> };

        await expect(authenticatedRoute.beforeLoad()).rejects.toEqual({
            type: "redirect",
            target: { to: "/login" },
        });

        mocks.authStore.state.isAuthenticated = true;
        await expect(authenticatedRoute.beforeLoad()).resolves.toBeUndefined();
    });
});
