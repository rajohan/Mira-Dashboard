import { describe, expect, spyOn, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import { createDashboardRouter, dashboardScrollRestorationKey } from "./router.tsx";

describe("Dashboard router scroll restoration", () => {
    test("retains one position across same-page search and hash changes", () => {
        expect(dashboardScrollRestorationKey({ pathname: "/jobs" })).toBe("/jobs");
        expect(dashboardScrollRestorationKey({ pathname: "/files" })).toBe("/files");
    });

    test("keeps different routes in independent restoration buckets", () => {
        expect(dashboardScrollRestorationKey({ pathname: "/jobs" })).not.toBe(
            dashboardScrollRestorationKey({ pathname: "/reports" })
        );
    });

    test("configures the Dashboard content element for pathname-scoped restoration", () => {
        const documentAddEventListener = spyOn(
            document,
            "addEventListener"
        ).mockImplementation(() => {});
        const windowAddEventListener = spyOn(
            globalThis,
            "addEventListener"
        ).mockImplementation(() => {});
        try {
            const router = createDashboardRouter(
                createMemoryHistory({ initialEntries: ["/jobs"] })
            );

            expect(router.options.getScrollRestorationKey).toBe(
                dashboardScrollRestorationKey
            );
            expect(router.options.scrollRestoration).toBe(true);
            expect(router.options.scrollToTopSelectors).toEqual(["#dashboard-content"]);
            expect(
                documentAddEventListener.mock.calls.filter(
                    ([event]) => event === "scroll"
                )
            ).toHaveLength(1);
            expect(
                windowAddEventListener.mock.calls.filter(
                    ([event]) => event === "pagehide"
                )
            ).toHaveLength(1);
        } finally {
            documentAddEventListener.mockRestore();
            windowAddEventListener.mockRestore();
        }
    });

    test("keeps story routers from accumulating document-lifetime listeners", () => {
        const documentAddEventListener = spyOn(
            document,
            "addEventListener"
        ).mockImplementation(() => {});
        const windowAddEventListener = spyOn(
            globalThis,
            "addEventListener"
        ).mockImplementation(() => {});

        try {
            const routers = Array.from({ length: 3 }, (_, index) =>
                createDashboardRouter(
                    createMemoryHistory({ initialEntries: [`/jobs?story=${index}`] }),
                    { scrollRestoration: false }
                )
            );

            expect(
                routers.every((router) => router.options.scrollRestoration === false)
            ).toBe(true);
            expect(
                documentAddEventListener.mock.calls.filter(
                    ([event]) => event === "scroll"
                )
            ).toHaveLength(0);
            expect(
                windowAddEventListener.mock.calls.filter(
                    ([event]) => event === "pagehide"
                )
            ).toHaveLength(0);
        } finally {
            documentAddEventListener.mockRestore();
            windowAddEventListener.mockRestore();
        }
    });
});
