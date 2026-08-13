import { describe, expect, test } from "bun:test";

import type { DeliveryDeployment } from "../../contracts/delivery.ts";
import { DeliveryJobsPanel } from "./DeliveryJobsPanel.tsx";

const { render, screen } = await import("@testing-library/react");

const base = {
    operation: "merge-and-deploy",
    queuedAtMs: 1000,
    state: "succeeded",
    updatedAtMs: 2000,
} as const;

describe("DeliveryJobsPanel", () => {
    test("distinguishes completed, partial, and merge-queued production truth", () => {
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

        render(<DeliveryJobsPanel deployments={deployments} />);

        expect(screen.getByText("Completed")).toBeTruthy();
        expect(screen.getByText("Merge queued; deploy not started")).toBeTruthy();
        expect(screen.getByText("Completed with warnings")).toBeTruthy();
        expect(screen.getByText("Deployment did not start.")).toBeTruthy();
    });
});
