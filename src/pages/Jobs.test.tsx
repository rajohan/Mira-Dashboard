import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledJob } from "../hooks/useJobs";
import {
    Jobs,
    requireSelectedJobForAction,
    runSelectedAction,
    saveScheduleAction,
    toggleSelectedAction,
} from "./Jobs";

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
                cronExpression: "0 4 * * *",
                id: "cache.cron",
                name: "Cron",
                scheduleType: "cron",
            }),
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
        expect(screen.getByText("Cron: 0 4 * * *")).toBeInTheDocument();
        expect(screen.getByText("Every 1h")).toBeInTheDocument();
        expect(screen.getByText("Daily at 02:40")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Git.*Daily/u }));
        await user.click(screen.getByRole("button", { name: /Run now/u }));

        expect(hooks.runJob).toHaveBeenCalledWith({ id: "cache.git" });
    });

    it("shows fallback text for incomplete schedules", () => {
        mockJobs([
            createJob({
                id: "cache.cron.unknown",
                name: "Cron Unknown",
                scheduleType: "cron",
            }),
            createJob({
                id: "cache.interval.invalid",
                intervalSeconds: Number.NaN,
                name: "Interval Invalid",
            }),
        ]);

        render(<Jobs />);

        expect(screen.getByText("Cron: unknown")).toBeInTheDocument();
        expect(screen.getByText("Schedule unavailable")).toBeInTheDocument();
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
                cronExpression: null,
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

        hooks.runJob.mockResolvedValueOnce({
            ok: false,
            run: { message: "backend failed" },
        });
        await user.click(screen.getByRole("button", { name: /Run now/u }));
        expect(await screen.findByText("backend failed")).toBeInTheDocument();

        hooks.runJob.mockResolvedValueOnce({ ok: false, run: {} });
        await user.click(screen.getByRole("button", { name: /Run now/u }));
        expect(await screen.findByText("Action failed")).toBeInTheDocument();

        hooks.updateJob.mockRejectedValueOnce("toggle failed");
        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        expect(await screen.findByText("toggle failed")).toBeInTheDocument();

        hooks.updateJob.mockRejectedValueOnce(new Error("save failed"));
        await user.click(screen.getByRole("button", { name: /Save schedule/u }));
        expect(await screen.findByText("save failed")).toBeInTheDocument();
    });

    it("rejects actions when no scheduled job is selected", async () => {
        const setActionError = vi.fn();
        const updateJob = { mutateAsync: hooks.updateJob } as ReturnType<
            typeof hooks.useUpdateScheduledJob
        >;
        const runJob = { mutateAsync: hooks.runJob } as ReturnType<
            typeof hooks.useRunScheduledJob
        >;

        expect(() => requireSelectedJobForAction(null)).toThrow(
            "No scheduled job selected."
        );
        expect(requireSelectedJobForAction(createJob()).id).toBe("cache.weather");

        await saveScheduleAction({
            cronExpressionDraft: "* * * * *",
            intervalNumber: 60,
            scheduleTypeDraft: "interval",
            selectedJob: null,
            setActionError,
            timeOfDayDraft: "09:00",
            updateJob,
        });
        await saveScheduleAction({
            cronExpressionDraft: "* * * * *",
            intervalNumber: 60,
            selectedJob: null,
            scheduleTypeDraft: "daily",
            setActionError,
            timeOfDayDraft: "09:00",
            updateJob,
        });
        await toggleSelectedAction({
            enabled: false,
            selectedJob: null,
            setActionError,
            updateJob,
        });
        await runSelectedAction({ runJob, selectedJob: null, setActionError });

        expect(setActionError).toHaveBeenCalledTimes(4);
        expect(setActionError).toHaveBeenCalledWith("No scheduled job selected.");
        expect(hooks.updateJob).not.toHaveBeenCalled();
        expect(hooks.runJob).not.toHaveBeenCalled();
    });

    it("updates daily schedules with precise clock times", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Git.*Daily/u }));
        await user.click(screen.getByRole("button", { name: /Schedule type/u }));
        await user.click(screen.getByRole("menuitem", { name: /Daily time/u }));
        await user.clear(screen.getByLabelText("Time of day"));
        await user.type(screen.getByLabelText("Time of day"), "03:15");
        await user.click(screen.getByRole("button", { name: /Save schedule/u }));

        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "cache.git",
            patch: {
                cronExpression: null,
                scheduleType: "daily",
                timeOfDay: "03:15",
            },
        });
    });

    it("updates cron schedules with 5-field expressions", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Cron.*Cron:/u }));
        expect(screen.getByLabelText("Cron expression")).toHaveValue("0 4 * * *");
        await user.clear(screen.getByLabelText("Cron expression"));
        await user.type(screen.getByLabelText("Cron expression"), "*/10 * * * *");
        await user.click(screen.getByRole("button", { name: /Save schedule/u }));

        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "cache.cron",
            patch: {
                cronExpression: "*/10 * * * *",
                scheduleType: "cron",
                timeOfDay: null,
            },
        });
    });

    it("switches daily jobs back to interval schedules", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Git.*Daily/u }));
        await user.click(screen.getByRole("button", { name: /Schedule type/u }));
        await user.click(screen.getByRole("menuitem", { name: /Interval/u }));

        expect(screen.getByLabelText("Interval seconds")).toBeInTheDocument();
    });

    it("switches interval jobs to cron schedules", async () => {
        const user = userEvent.setup();
        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: /Weather.*Every 1h/u }));
        await user.click(screen.getByRole("button", { name: /Schedule type/u }));
        await user.click(screen.getByRole("menuitem", { name: /^Cron/u }));

        expect(screen.getByLabelText("Cron expression")).toHaveValue("* * * * *");
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

        await user.click(screen.getByRole("button", { name: /Git.*Daily at 02:40/u }));
        await user.clear(screen.getByLabelText("Time of day"));
        await user.type(screen.getByLabelText("Time of day"), "25:00");
        expect(
            await screen.findByText("Time of day must use HH:mm, for example 02:40.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Cron.*Cron:/u }));
        await user.clear(screen.getByLabelText("Cron expression"));
        await user.type(screen.getByLabelText("Cron expression"), "bad");
        expect(
            await screen.findByText("Cron must use five fields, for example * * * * *.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Weather.*Every 1h/u }));
        expect(screen.getByLabelText("Interval seconds")).toBeInTheDocument();
    });
});
