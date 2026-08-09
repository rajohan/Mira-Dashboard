import { describe, expect, test } from "bun:test";

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
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/jobs"] })
        );

        expect(router.options.getScrollRestorationKey).toBe(
            dashboardScrollRestorationKey
        );
        expect(router.options.scrollRestoration).toBe(true);
        expect(router.options.scrollToTopSelectors).toEqual(["#dashboard-content"]);
    });
});
