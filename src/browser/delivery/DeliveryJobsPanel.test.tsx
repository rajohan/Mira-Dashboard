import { describe, expect, test } from "bun:test";

import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";

import type { DeliveryDeployment } from "../../contracts/delivery.ts";
import { parseJobsRouteSearch } from "../jobs/jobRouteSearch.ts";
import { DeliveryJobsPanel } from "./DeliveryJobsPanel.tsx";

const { render, screen } = await import("@testing-library/react");

const base = {
    operation: "merge-and-deploy",
    queuedAtMs: 1000,
    state: "succeeded",
    updatedAtMs: 2000,
} as const;

describe("DeliveryJobsPanel", () => {
    test("distinguishes completed, partial, and merge-queued production truth", async () => {
        const deployments = [
            {
                ...base,
                jobRunId: "019fdf70-0000-7000-8000-000000000041",
                operation: "deploy",
                outcome: "completed",
            },
            {
                ...base,
                jobRunId: "019fdf70-0000-7000-8000-000000000042",
                outcome: "enqueued",
            },
            {
                ...base,
                jobRunId: "019fdf70-0000-7000-8000-000000000043",
                outcome: "completed-with-warnings",
                warnings: ["deployment-not-started"],
            },
        ] as const satisfies readonly DeliveryDeployment[];

        const rootRoute = createRootRoute();
        const deliveryRoute = createRoute({
            component: () => <DeliveryJobsPanel deployments={deployments} />,
            getParentRoute: () => rootRoute,
            path: "/delivery",
        });
        const jobsRoute = createRoute({
            component: () => null,
            getParentRoute: () => rootRoute,
            path: "/jobs",
            validateSearch: parseJobsRouteSearch,
        });
        const router = createRouter({
            history: createMemoryHistory({ initialEntries: ["/delivery"] }),
            routeTree: rootRoute.addChildren([deliveryRoute, jobsRoute]),
        });

        render(<RouterProvider router={router} />);

        expect(await screen.findByText("Completed")).toBeTruthy();
        expect(screen.getByText("Merge queued. Deploy not started")).toBeTruthy();
        expect(screen.getByText("Completed with warnings")).toBeTruthy();
        expect(screen.getByText("Deployment did not start.")).toBeTruthy();
    });
});
