import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CronJob } from "../../../hooks";
import { CronOverviewCard } from "./CronOverviewCard";

const hooks = vi.hoisted(() => ({
    useCronJobs: vi.fn(),
}));

vi.mock("../../../hooks", () => ({
    useCronJobs: hooks.useCronJobs,
}));

describe("CronOverviewCard", () => {
    it("summarizes enabled, disabled, latest, and next cron jobs", () => {
        hooks.useCronJobs.mockReturnValue({
            data: [
                {
                    name: "Nightly cleanup",
                    enabled: true,
                    state: {
                        lastRunAtMs: new Date("2026-05-10T08:00:00.000Z").getTime(),
                        lastRunStatus: "success",
                    },
                },
                {
                    name: "Heartbeat",
                    enabled: true,
                    state: {
                        nextRunAtMs: new Date("2026-05-10T09:00:00.000Z").getTime(),
                    },
                },
                {
                    name: "Disabled job",
                    enabled: false,
                    state: {},
                },
            ] satisfies CronJob[],
        });

        const { container } = render(<CronOverviewCard />);

        expect(screen.getByText("Cron jobs")).toBeInTheDocument();
        expect(container).toHaveTextContent("Total");
        expect(container).toHaveTextContent("Enabled");
        expect(container).toHaveTextContent("Disabled");
        expect(container).toHaveTextContent("Nightly cleanup");
        expect(container).toHaveTextContent("Heartbeat");
        expect(screen.getByText("SUCCESS")).toBeInTheDocument();
    });

    it("renders empty defaults when no jobs are present", () => {
        hooks.useCronJobs.mockReturnValue({ data: [] });

        const { container } = render(<CronOverviewCard />);

        expect(container).toHaveTextContent("Last run—");
        expect(container).toHaveTextContent("Next run—");
        expect(screen.getByText("UNKNOWN")).toBeInTheDocument();
    });
});
