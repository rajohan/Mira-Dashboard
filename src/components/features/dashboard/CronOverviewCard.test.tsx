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

    it("sorts zero-valued cron timestamps without falling back incorrectly", () => {
        hooks.useCronJobs.mockReturnValue({
            data: [
                {
                    name: "Epoch last run",
                    enabled: true,
                    state: { lastRunAtMs: 0, lastRunStatus: "error" },
                },
                {
                    name: "Epoch next run",
                    enabled: true,
                    state: { nextRunAtMs: 0 },
                },
            ] satisfies CronJob[],
        });

        const { container } = render(<CronOverviewCard />);

        expect(container).toHaveTextContent("Epoch last run");
        expect(container).toHaveTextContent("Epoch next run");
        expect(screen.getByText("ERROR")).toBeInTheDocument();
    });

    it("selects the latest run and earliest upcoming job from multiple candidates", () => {
        hooks.useCronJobs.mockReturnValue({
            data: [
                {
                    name: "Older last run",
                    enabled: true,
                    state: {
                        lastRunAtMs: new Date("2026-05-10T08:00:00.000Z").getTime(),
                        lastRunStatus: "success",
                    },
                },
                {
                    name: "Newest last run",
                    enabled: true,
                    state: {
                        lastRunAtMs: new Date("2026-05-10T10:00:00.000Z").getTime(),
                        lastRunStatus: "failed",
                    },
                },
                {
                    name: "Soonest next run",
                    enabled: true,
                    state: {
                        nextRunAtMs: new Date("2026-05-10T11:00:00.000Z").getTime(),
                    },
                },
                {
                    name: "Later next run",
                    enabled: true,
                    state: {
                        nextRunAtMs: new Date("2026-05-10T12:00:00.000Z").getTime(),
                    },
                },
            ] satisfies CronJob[],
        });

        const { container } = render(<CronOverviewCard />);

        expect(container).toHaveTextContent("Newest last run");
        expect(container).not.toHaveTextContent("Older last run");
        expect(container).toHaveTextContent("Soonest next run");
        expect(container).not.toHaveTextContent("Later next run");
        expect(screen.getByText("FAILED")).toBeInTheDocument();
    });
});
