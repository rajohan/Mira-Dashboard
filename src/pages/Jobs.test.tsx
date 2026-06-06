import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledJob } from "../hooks/useJobs";
import { Jobs } from "./Jobs";

const hooks = vi.hoisted(() => ({
    runJob: vi.fn(),
    updateJob: vi.fn(),
    useRunScheduledJob: vi.fn(),
    useScheduledJobs: vi.fn(),
    useUpdateScheduledJob: vi.fn(),
}));

vi.mock("../hooks", () => ({
    useRunScheduledJob: hooks.useRunScheduledJob,
    useScheduledJobs: hooks.useScheduledJobs,
    useUpdateScheduledJob: hooks.useUpdateScheduledJob,
}));

function createJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
    return {
        actionTarget: "weather",
        actionType: "cache.refresh",
        createdAt: "2026-06-05T00:00:00.000Z",
        cronExpression: null,
        description: "Refresh weather cache.",
        enabled: true,
        id: "cache.weather",
        intervalSeconds: 3600,
        isRunning: false,
        lastRun: {
            finishedAt: "2026-06-05T00:01:00.000Z",
            id: 1,
            jobId: "cache.weather",
            message: "Job completed",
            output: { refreshed: true },
            startedAt: "2026-06-05T00:00:00.000Z",
            status: "success",
            triggerType: "schedule",
        },
        name: "Weather",
        nextRunAt: "2026-06-05T01:00:00.000Z",
        scheduleType: "interval",
        settings: {},
        timeOfDay: null,
        updatedAt: "2026-06-05T00:00:00.000Z",
        ...overrides,
    };
}

function mockJobs(jobs: ScheduledJob[]) {
    hooks.useScheduledJobs.mockReturnValue({
        data: jobs,
        error: null,
        isLoading: false,
    });
}

describe("Jobs page", () => {
    beforeEach(() => {
        hooks.runJob.mockReset();
        hooks.updateJob.mockReset();
        hooks.useRunScheduledJob.mockReset();
        hooks.useUpdateScheduledJob.mockReset();

        hooks.runJob.mockResolvedValue({});
        hooks.updateJob.mockResolvedValue({});
        hooks.useRunScheduledJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.runJob,
        });
        hooks.useScheduledJobs.mockReset();
        hooks.useUpdateScheduledJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.updateJob,
        });
        mockJobs([
            createJob(),
            createJob({
                id: "cache.git",
                name: "Git",
                timeOfDay: "02:40",
                scheduleType: "daily",
            }),
        ]);
    });

    it("renders loading and empty states", () => {
        const { container, rerender } = render(<Jobs />);

        hooks.useScheduledJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: true,
        });
        rerender(<Jobs />);
        expect(container.querySelector(".animate-spin")).toBeInTheDocument();

        hooks.useScheduledJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: false,
        });
        rerender(<Jobs />);
        expect(screen.getByText("No scheduled jobs found")).toBeInTheDocument();
    });

    it("renders backend errors", () => {
        hooks.useScheduledJobs.mockReturnValue({
            data: [],
            error: new Error("jobs unavailable"),
            isLoading: false,
        });

        render(<Jobs />);

        expect(screen.getByText("Scheduled jobs unavailable")).toBeInTheDocument();
        expect(screen.getByText("jobs unavailable")).toBeInTheDocument();
    });

    it("shows jobs and runs the selected job manually", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        expect(screen.getByText("Weather")).toBeInTheDocument();
        expect(screen.getByText("Every 1h")).toBeInTheDocument();
        expect(screen.getByText("Daily at 02:40")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Run now/u }));

        expect(hooks.runJob).toHaveBeenCalledWith({ id: "cache.git" });
    });

    it("renders disabled, failed, running, and unscheduled job states", async () => {
        const user = userEvent.setup();
        mockJobs([
            createJob({
                enabled: false,
                id: "cache.alpha",
                intervalSeconds: 90,
                lastRun: {
                    finishedAt: "2026-06-05T00:01:00.000Z",
                    id: 2,
                    jobId: "cache.alpha",
                    message: "",
                    output: {},
                    startedAt: "2026-06-05T00:00:00.000Z",
                    status: "failed",
                    triggerType: "manual",
                },
                name: "Alpha",
                nextRunAt: null,
            }),
            createJob({
                id: "cache.minutes",
                intervalSeconds: 120,
                lastRun: null,
                name: "Minutes",
            }),
            createJob({
                id: "cache.beta",
                intervalSeconds: 75,
                isRunning: true,
                lastRun: {
                    finishedAt: null,
                    id: 3,
                    jobId: "cache.beta",
                    message: "Still running",
                    output: { progress: true },
                    startedAt: "2026-06-05T00:00:00.000Z",
                    status: "running",
                    triggerType: "schedule",
                },
                name: "Beta",
            }),
        ]);
        render(<Jobs />);

        expect(screen.getByText("Disabled")).toBeInTheDocument();
        expect(screen.getByText("Every 90s")).toBeInTheDocument();
        expect(screen.getByText("Every 2m")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Alpha.*Every 90s/u }));

        expect(screen.getByText("failed")).toBeInTheDocument();
        expect(screen.getByText("Not scheduled")).toBeInTheDocument();
        expect(screen.getByText("No message")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Minutes.*Every 2m/u }));

        expect(screen.getByText("never run")).toBeInTheDocument();
        expect(screen.getByText("Never")).toBeInTheDocument();
        expect(screen.queryByText("Last run output")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Beta.*Every 75s/u }));

        expect(screen.getByText("running")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Running/u })).toBeDisabled();
    });

    it("updates enable state and interval schedules", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Weather.*Every 1h/u }));
        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        await user.clear(screen.getByLabelText("Interval seconds"));
        await user.type(screen.getByLabelText("Interval seconds"), "7200");
        await user.click(screen.getByRole("button", { name: /Save schedule/u }));

        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "cache.weather",
            patch: { enabled: false },
        });
        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "cache.weather",
            patch: {
                intervalSeconds: 7200,
                scheduleType: "interval",
                timeOfDay: null,
            },
        });
    });

    it("shows action errors from failed job mutations", async () => {
        const user = userEvent.setup();
        hooks.runJob.mockRejectedValueOnce(new Error("run failed"));
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Run now/u }));

        expect(await screen.findByText("run failed")).toBeInTheDocument();

        hooks.updateJob.mockRejectedValueOnce("toggle failed");
        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        expect(await screen.findByText("toggle failed")).toBeInTheDocument();

        hooks.updateJob.mockRejectedValueOnce(new Error("save failed"));
        await user.click(screen.getByRole("button", { name: /Save schedule/u }));
        expect(await screen.findByText("save failed")).toBeInTheDocument();
    });

    it("updates daily schedules with precise clock times", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Schedule type/u }));
        await user.click(screen.getByRole("menuitem", { name: /Daily time/u }));
        await user.clear(screen.getByLabelText("Time of day"));
        await user.type(screen.getByLabelText("Time of day"), "03:15");
        await user.click(screen.getByRole("button", { name: /Save schedule/u }));

        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "cache.git",
            patch: {
                scheduleType: "daily",
                timeOfDay: "03:15",
            },
        });
    });

    it("shows cron schedules without allowing schedule edits", async () => {
        const user = userEvent.setup();
        hooks.updateJob.mockClear();
        mockJobs([
            createJob({
                cronExpression: "15 4 * * *",
                id: "cache.cron",
                name: "Cron",
                scheduleType: "cron",
            }),
        ]);
        render(<Jobs />);

        expect(screen.getByText("Cron: 15 4 * * *")).toBeInTheDocument();
        expect(
            screen.getByText("Cron schedules are read-only in the dashboard.")
        ).toBeInTheDocument();
        const save = screen.getByRole("button", { name: /Save schedule/u });
        expect(save).toBeDisabled();
        await user.click(save);
        expect(hooks.updateJob).not.toHaveBeenCalled();
    });

    it("shows cron schedules without an expression", () => {
        mockJobs([
            createJob({
                cronExpression: null,
                id: "cache.cron",
                name: "Cron",
                scheduleType: "cron",
            }),
        ]);

        render(<Jobs />);

        expect(screen.getByText("Cron schedule")).toBeInTheDocument();
    });

    it("shows schedule validation messages", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Weather.*Every 1h/u }));
        await user.clear(screen.getByLabelText("Interval seconds"));
        await user.type(screen.getByLabelText("Interval seconds"), "30");
        expect(
            await screen.findByText("Interval must be an integer of at least 60 seconds.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Schedule type/u }));
        await user.click(screen.getByRole("menuitem", { name: /Daily time/u }));
        await user.clear(screen.getByLabelText("Time of day"));
        await user.type(screen.getByLabelText("Time of day"), "25:00");
        expect(
            await screen.findByText("Time of day must use HH:mm, for example 02:40.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Schedule type/u }));
        await user.click(screen.getByRole("menuitem", { name: /Interval/u }));
        expect(screen.getByLabelText("Interval seconds")).toBeInTheDocument();
    });
});
