import { beforeEach, describe, expect, it, jest } from "bun:test";
import { isValidElement } from "react";

import { router } from "./router";
import { authActions } from "./stores/authStore";
import { stubGlobal, unstubAllGlobals } from "./test/testUtils";

type TestRoute = {
    children?: TestRoute[];
    id?: string;
    options: {
        beforeLoad?: () => Promise<void>;
        component?: () => unknown;
        path?: string;
    };
};

function getRootRoute(): TestRoute {
    return router.options.routeTree as unknown as TestRoute;
}

function getRoute(pathOrId: string): TestRoute {
    const stack = [...(getRootRoute().children ?? [])];

    while (stack.length > 0) {
        const route = stack.shift() as TestRoute;
        if (route.options.path === pathOrId || route.id === pathOrId) {
            return route;
        }
        stack.push(...(route.children ?? []));
    }

    throw new Error(`Route not found: ${pathOrId}`);
}

function mockSession(authenticated: boolean): void {
    stubGlobal(
        "fetch",
        jest.fn(async () =>
            Response.json({
                authenticated,
                bootstrapRequired: false,
                user: authenticated ? { id: 1, username: "mira" } : null,
            })
        )
    );
}

describe("router", () => {
    beforeEach(() => {
        authActions.clearSession();
        unstubAllGlobals();
    });

    it("builds the dashboard route tree", () => {
        const routePaths = (getRootRoute().children ?? [])
            .flatMap((route) => [route, ...(route.children ?? [])])
            .map((route) => route.options.path ?? route.id)
            .filter(Boolean);

        expect(routePaths).toEqual([
            "/login",
            "/authenticated",
            "/",
            "/tasks",
            "/agents",
            "/sessions",
            "/chat",
            "/logs",
            "/jobs",
            "/pull-requests",
            "/files",
            "/docker",
            "/database",
            "/moltbook",
            "/terminal",
            "/settings",
        ]);
    });

    it("renders the root route outlet", () => {
        expect(isValidElement(getRootRoute().options.component?.())).toBe(true);
    });

    it("allows login route for guests and redirects authenticated users home", async () => {
        const loginRoute = getRoute("/login");

        mockSession(false);
        await expect(loginRoute.options.beforeLoad?.()).resolves.toBeUndefined();

        mockSession(true);
        await expect(loginRoute.options.beforeLoad?.()).rejects.toMatchObject({
            options: { to: "/" },
        });
    });

    it("guards authenticated routes from guests", async () => {
        const authenticatedRoute = getRoute("/authenticated");

        mockSession(false);
        await expect(authenticatedRoute.options.beforeLoad?.()).rejects.toMatchObject({
            options: { to: "/login" },
        });

        mockSession(true);
        await expect(authenticatedRoute.options.beforeLoad?.()).resolves.toBeUndefined();
    });

    it("renders the authenticated route wrapper", () => {
        const authenticatedRoute = getRoute("/authenticated");

        expect(isValidElement(authenticatedRoute.options.component?.())).toBe(true);
    });
});
