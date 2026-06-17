import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Jobs } from "./Jobs";

const hooks = vi.hoisted(() => ({
    refetch: vi.fn(),
    deleteJob: vi.fn(),
    runNow: vi.fn(),
    runScheduledNow: vi.fn(),
    scheduledRunsRefetch: vi.fn(),
    toggleJob: vi.fn(),
    updateJob: vi.fn(),
    updateScheduledJob: vi.fn(),
    useCronJobs: vi.fn(),
    useDeleteCronJob: vi.fn(),
    useRunCronJobNow: vi.fn(),
    useRunScheduledJobNow: vi.fn(),
    useScheduledJobRuns: vi.fn(),
    useScheduledJobs: vi.fn(),
    useToggleCronJob: vi.fn(),
    useUpdateCronJob: vi.fn(),
    useUpdateScheduledJob: vi.fn(),
}));

interface MockCronJob {
    id?: string;
    jobId?: string;
    name?: string;
    schedule?: unknown;
    payload?: unknown;
    delivery?: unknown;
    enabled?: boolean;
}

vi.mock("../hooks", () => ({
    useCronJobs: hooks.useCronJobs,
    useDeleteCronJob: hooks.useDeleteCronJob,
    useRunCronJobNow: hooks.useRunCronJobNow,
    useRunScheduledJobNow: hooks.useRunScheduledJobNow,
    useScheduledJobRuns: hooks.useScheduledJobRuns,
    useScheduledJobs: hooks.useScheduledJobs,
    useToggleCronJob: hooks.useToggleCronJob,
    useUpdateCronJob: hooks.useUpdateCronJob,
    useUpdateScheduledJob: hooks.useUpdateScheduledJob,
}));

vi.mock("../components/features/cron", () => ({
    CronJobDetails: ({
        deliveryDraft,
        editError,
        hasInvalidJson,
        job,
        lastTriggeredAt,
        nameDraft,
        onDeliveryDraftChange,
        onDelete,
        onEditModeChange,
        onNameDraftChange,
        onPayloadDraftChange,
        onRunNow,
        onSave,
        onScheduleDraftChange,
        onToggle,
        payloadDraft,
        scheduleDraft,
    }: {
        deliveryDraft: string;
        editError: string | null;
        hasInvalidJson: boolean;
        job: MockCronJob;
        lastTriggeredAt?: number;
        nameDraft: string;
        onDeliveryDraftChange: (value: string) => void;
        onDelete: (job: MockCronJob) => void;
        onEditModeChange: (value: boolean) => void;
        onNameDraftChange: (value: string) => void;
        onPayloadDraftChange: (value: string) => void;
        onRunNow: (job: MockCronJob) => void;
        onSave: (job: MockCronJob) => void;
        onScheduleDraftChange: (value: string) => void;
        onToggle: (job: MockCronJob, enabled: boolean) => void;
        payloadDraft: string;
        scheduleDraft: string;
    }) => (
        <section data-testid="cron-details">
            <div>job: {job.name}</div>
            <div>name draft: {nameDraft}</div>
            <div>schedule draft: {scheduleDraft}</div>
            <div>payload draft: {payloadDraft}</div>
            <div>delivery draft: {deliveryDraft}</div>
            <div>invalid: {String(hasInvalidJson)}</div>
            <div>last run: {lastTriggeredAt ? "set" : "unset"}</div>
            {editError ? <div>{editError}</div> : null}
            <button type="button" onClick={() => onEditModeChange(true)}>
                Edit
            </button>
            <button type="button" onClick={() => onEditModeChange(false)}>
                Cancel edit
            </button>
            <button type="button" onClick={() => onNameDraftChange("Updated job")}>
                Rename
            </button>
            <button type="button" onClick={() => onScheduleDraftChange("not-json")}>
                Invalid schedule
            </button>
            <button
                type="button"
                onClick={() => onPayloadDraftChange('{"kind":"systemEvent"}')}
            >
                Update payload
            </button>
            <button type="button" onClick={() => onDeliveryDraftChange("{}")}>
                Update delivery
            </button>
            <button type="button" onClick={() => onToggle(job, false)}>
                Disable
            </button>
            <button type="button" onClick={() => onRunNow(job)}>
                Run now
            </button>
            <button type="button" onClick={() => onSave(job)}>
                Save
            </button>
            <button type="button" onClick={() => onDelete(job)}>
                Delete cron
            </button>
        </section>
    ),
    CronJobList: ({
        currentJobId,
        jobs,
        onSelect,
        selectedId,
    }: {
        currentJobId: string;
        jobs: MockCronJob[];
        onSelect: (id: string) => void;
        selectedId: string;
    }) => (
        <aside data-testid="cron-list">
            <div>jobs: {jobs.length}</div>
            <div>current: {currentJobId}</div>
            <div>selected: {selectedId || "none"}</div>
            {jobs.map((job) => {
                const id = String(job.jobId || job.id || "");
                return (
                    <button key={id} type="button" onClick={() => onSelect(id)}>
                        Select {job.name}
                    </button>
                );
            })}
        </aside>
    ),
}));

function mockCronJobs(overrides = {}) {
    hooks.useCronJobs.mockReturnValue({
        data: [
            {
                delivery: { mode: "none" },
                enabled: true,
                id: "daily",
                name: "Daily summary",
                payload: { kind: "systemEvent", text: "hello" },
                schedule: { expr: "0 9 * * *", kind: "cron" },
            },
            {
                enabled: false,
                id: "cleanup",
                name: "Cleanup",
                payload: { kind: "systemEvent", text: "clean" },
                schedule: { everyMs: 60_000, kind: "every" },
            },
        ],
        error: null,
        isLoading: false,
        refetch: hooks.refetch,
        ...overrides,
    });
}

function mockScheduledJobs(overrides = {}) {
    hooks.useScheduledJobs.mockReturnValue({
        data: [
            {
                actionKey: "cache.prune",
                actionPayload: { cache: "deployments" },
                createdAt: "2026-06-17T20:00:00.000Z",
                cronExpression: null,
                description: "Trim expired cache entries",
                enabled: true,
                id: "cache.cleanup",
                intervalSeconds: 3600,
                isRunning: false,
                lastRun: {
                    finishedAt: "2026-06-17T21:00:10.000Z",
                    id: 7,
                    jobId: "cache.cleanup",
                    message: null,
                    output: { deleted: 4 },
                    startedAt: "2026-06-17T21:00:00.000Z",
                    status: "success",
                    triggerType: "schedule",
                },
                name: "Cache cleanup",
                nextRunAt: "2026-06-17T22:00:00.000Z",
                scheduleType: "interval",
                timeOfDay: null,
                updatedAt: "2026-06-17T21:00:10.000Z",
            },
            {
                actionKey: "backup.run",
                actionPayload: { target: "kopia" },
                createdAt: "2026-06-17T20:00:00.000Z",
                cronExpression: null,
                description: "Run nightly backup",
                enabled: false,
                id: "backup.kopia",
                intervalSeconds: 86_400,
                isRunning: false,
                lastRun: null,
                name: "Backup",
                nextRunAt: null,
                scheduleType: "daily",
                timeOfDay: "04:10",
                updatedAt: "2026-06-17T21:00:10.000Z",
            },
        ],
        error: null,
        isLoading: false,
        refetch: hooks.refetch,
        ...overrides,
    });
}

function mockScheduledRuns(overrides = {}) {
    hooks.useScheduledJobRuns.mockImplementation((id: string) => ({
        data: [
            ...(id === "cache.cleanup"
                ? [
                      {
                          finishedAt: "2026-06-17T21:00:10.000Z",
                          id: 7,
                          jobId: "cache.cleanup",
                          message: null,
                          output: { deleted: 4 },
                          startedAt: "2026-06-17T21:00:00.000Z",
                          status: "success",
                          triggerType: "schedule",
                      },
                  ]
                : []),
            ...(id === "cache.fast"
                ? [
                      {
                          finishedAt: "2026-06-17T21:00:05.000Z",
                          id: 8,
                          jobId: "cache.fast",
                          message: "Timed out",
                          output: null,
                          startedAt: "2026-06-17T21:00:00.000Z",
                          status: "failed",
                          triggerType: "manual",
                      },
                  ]
                : []),
            ...(id === "jobs.running"
                ? [
                      {
                          finishedAt: null,
                          id: 9,
                          jobId: "jobs.running",
                          message: null,
                          output: null,
                          startedAt: "2026-06-17T21:00:00.000Z",
                          status: "running",
                          triggerType: "schedule",
                      },
                  ]
                : []),
        ],
        error: null,
        isLoading: false,
        refetch: hooks.scheduledRunsRefetch,
        ...overrides,
    }));
}

async function switchToOpenClawCron(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /OpenClaw cron/ }));
}

describe("Jobs page", () => {
    beforeEach(() => {
        window.history.replaceState(null, "", "/jobs");
        hooks.refetch.mockReset();
        hooks.deleteJob.mockResolvedValue(Promise.resolve({}));
        hooks.runNow.mockResolvedValue(Promise.resolve({}));
        hooks.runScheduledNow.mockResolvedValue(Promise.resolve({}));
        hooks.scheduledRunsRefetch.mockReset();
        hooks.toggleJob.mockResolvedValue(Promise.resolve({}));
        hooks.updateJob.mockResolvedValue(Promise.resolve({}));
        hooks.updateScheduledJob.mockResolvedValue(Promise.resolve({}));
        hooks.useCronJobs.mockReset();
        hooks.useScheduledJobs.mockReset();
        hooks.useScheduledJobRuns.mockReset();
        hooks.useDeleteCronJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.deleteJob,
        });
        hooks.useRunCronJobNow.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.runNow,
        });
        hooks.useRunScheduledJobNow.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.runScheduledNow,
        });
        hooks.useToggleCronJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.toggleJob,
        });
        hooks.useUpdateCronJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.updateJob,
        });
        hooks.useUpdateScheduledJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.updateScheduledJob,
        });
        mockCronJobs();
        mockScheduledJobs();
        mockScheduledRuns();
    });

    it("renders loading, error retry, and empty states", async () => {
        const user = userEvent.setup();
        const { container, rerender } = render(<Jobs />);

        mockScheduledJobs({ data: [], isLoading: true });
        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: true,
            refetch: hooks.refetch,
        });
        rerender(<Jobs />);
        expect(container.querySelector(":scope .animate-spin")).toBeInTheDocument();

        mockScheduledJobs({
            data: [],
            error: new Error("Jobs unavailable"),
            isLoading: false,
        });
        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(<Jobs />);
        expect(screen.getByText("Jobs unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(hooks.refetch).toHaveBeenCalledTimes(1);

        mockScheduledJobs({ data: [], error: null, isLoading: false });
        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(<Jobs />);
        expect(screen.getByText("No jobs found")).toBeInTheDocument();
    });

    it("shows empty and error states only for the active tab", async () => {
        const user = userEvent.setup();
        mockScheduledJobs({ data: [], error: null, isLoading: false });

        const { rerender } = render(<Jobs />);

        expect(
            screen.getByText("Dashboard scheduled jobs will appear here.")
        ).toBeInTheDocument();

        await switchToOpenClawCron(user);
        expect(screen.getByTestId("cron-list")).toHaveTextContent("jobs: 2");

        mockScheduledJobs({
            data: [],
            error: new Error("Jobs unavailable"),
            isLoading: false,
        });
        await user.click(screen.getByRole("button", { name: /Dashboard jobs/ }));
        rerender(<Jobs />);

        expect(screen.getByText("Jobs unavailable")).toBeInTheDocument();
        await switchToOpenClawCron(user);
        expect(screen.getByTestId("cron-list")).toHaveTextContent("jobs: 2");
    });

    it("keeps the active dashboard jobs view available when OpenClaw cron fails", async () => {
        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: new Error("OpenClaw unavailable"),
            isLoading: false,
            refetch: hooks.refetch,
        });

        render(<Jobs />);

        expect(screen.getByText("Dashboard jobs")).toBeInTheDocument();
        expect(screen.getAllByText("Backup").length).toBeGreaterThan(0);
        expect(screen.queryByText("OpenClaw unavailable")).not.toBeInTheDocument();
    });

    it("shows the active OpenClaw cron error only after switching tabs", async () => {
        const user = userEvent.setup();
        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: new Error("OpenClaw unavailable"),
            isLoading: false,
            refetch: hooks.refetch,
        });

        render(<Jobs />);
        await switchToOpenClawCron(user);

        expect(screen.getByText("OpenClaw unavailable")).toBeInTheDocument();
    });

    it("renders dashboard jobs and exposes logs", async () => {
        const user = userEvent.setup();

        render(<Jobs />);

        expect(screen.getByText("Dashboard jobs")).toBeInTheDocument();
        expect(screen.getAllByText("Backup").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Cache cleanup").length).toBeGreaterThan(0);
        expect(screen.getByText("No run logs yet.")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Cache cleanup/ }));

        expect(screen.getByText("schedule run #7")).toBeInTheDocument();
        expect(screen.getByText(/"deleted": 4/)).toBeInTheDocument();
        expect(hooks.useScheduledJobRuns).toHaveBeenLastCalledWith("cache.cleanup");

        await user.click(screen.getByRole("button", { name: "Run now" }));
        await user.click(screen.getByRole("switch", { name: "Enabled" }));

        expect(hooks.runScheduledNow).toHaveBeenCalledWith({ id: "cache.cleanup" });
        expect(hooks.updateScheduledJob).toHaveBeenCalledWith({
            id: "cache.cleanup",
            patch: { enabled: false },
        });
    });

    it("renders scheduled job schedule and status fallbacks", async () => {
        const user = userEvent.setup();
        mockScheduledJobs({
            data: [
                {
                    actionKey: "cache.fast",
                    actionPayload: {},
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: null,
                    description: "",
                    enabled: true,
                    id: "cache.fast",
                    intervalSeconds: 30,
                    isRunning: false,
                    lastRun: {
                        finishedAt: "2026-06-17T21:00:05.000Z",
                        id: 8,
                        jobId: "cache.fast",
                        message: "Timed out",
                        output: null,
                        startedAt: "2026-06-17T21:00:00.000Z",
                        status: "failed",
                        triggerType: "manual",
                    },
                    name: "Fast interval",
                    nextRunAt: null,
                    scheduleType: "interval",
                    timeOfDay: null,
                    updatedAt: "2026-06-17T21:00:10.000Z",
                },
                {
                    actionKey: "jobs.cron",
                    actionPayload: {},
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: "",
                    description: "",
                    enabled: true,
                    id: "jobs.cron",
                    intervalSeconds: 3600,
                    isRunning: false,
                    lastRun: null,
                    name: "Cron fallback",
                    nextRunAt: null,
                    scheduleType: "cron",
                    timeOfDay: null,
                    updatedAt: "2026-06-17T21:00:10.000Z",
                },
                {
                    actionKey: "jobs.running",
                    actionPayload: {},
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: null,
                    description: "Currently active",
                    enabled: true,
                    id: "jobs.running",
                    intervalSeconds: 3600,
                    isRunning: true,
                    lastRun: {
                        finishedAt: null,
                        id: 9,
                        jobId: "jobs.running",
                        message: null,
                        output: null,
                        startedAt: "2026-06-17T21:00:00.000Z",
                        status: "running",
                        triggerType: "schedule",
                    },
                    name: "Running job",
                    nextRunAt: null,
                    scheduleType: "daily",
                    timeOfDay: "05:30",
                    updatedAt: "2026-06-17T21:00:10.000Z",
                },
                {
                    actionKey: "jobs.daily",
                    actionPayload: {},
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: null,
                    description: "",
                    enabled: true,
                    id: "jobs.daily",
                    intervalSeconds: 3600,
                    isRunning: false,
                    lastRun: null,
                    name: "Daily fallback",
                    nextRunAt: null,
                    scheduleType: "daily",
                    timeOfDay: null,
                    updatedAt: "2026-06-17T21:00:10.000Z",
                },
                {
                    actionKey: "jobs.duplicate",
                    actionPayload: {},
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: null,
                    description: "",
                    enabled: true,
                    id: "duplicate.b",
                    intervalSeconds: 3600,
                    isRunning: false,
                    lastRun: null,
                    name: "Duplicate",
                    nextRunAt: null,
                    scheduleType: "interval",
                    timeOfDay: null,
                    updatedAt: "2026-06-17T21:00:10.000Z",
                },
                {
                    actionKey: "jobs.duplicate",
                    actionPayload: {},
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: null,
                    description: "",
                    enabled: true,
                    id: "duplicate.a",
                    intervalSeconds: 3600,
                    isRunning: false,
                    lastRun: null,
                    name: "Duplicate",
                    nextRunAt: null,
                    scheduleType: "interval",
                    timeOfDay: null,
                    updatedAt: "2026-06-17T21:00:10.000Z",
                },
                {
                    actionKey: "jobs.minutes",
                    actionPayload: {},
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: null,
                    description: "",
                    enabled: true,
                    id: "jobs.minutes",
                    intervalSeconds: 90,
                    isRunning: false,
                    lastRun: null,
                    name: "Minute interval",
                    nextRunAt: null,
                    scheduleType: "interval",
                    timeOfDay: null,
                    updatedAt: "2026-06-17T21:00:10.000Z",
                },
            ],
        });

        render(<Jobs />);

        expect(screen.getByText("Schedule: Every 30s")).toBeInTheDocument();
        expect(screen.getByText("Schedule: Every 2m")).toBeInTheDocument();
        expect(screen.getByText("Schedule: Cron schedule")).toBeInTheDocument();
        expect(screen.getByText("Schedule: Daily at 05:30")).toBeInTheDocument();
        expect(screen.getByText("Schedule: Daily at --:--")).toBeInTheDocument();
        expect(screen.getByText("failed")).toBeInTheDocument();
        expect(screen.getByText("Running")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Fast interval/ }));
        expect(screen.getByText("Timed out")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Running job/ }));
        expect(screen.getByText("schedule run #9")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Cron fallback/ }));
        expect(screen.getAllByText("Never run").length).toBeGreaterThan(0);
        const cronInput = screen.getByLabelText("Cron expression");
        await user.type(cronInput, "0 4 * * *");
        expect(cronInput).toHaveValue("0 4 * * *");
    });

    it("saves dashboard job schedules", async () => {
        const user = userEvent.setup();

        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: "Schedule type: Daily" }));
        await user.click(screen.getByRole("menuitem", { name: /Interval/ }));
        const intervalInput = screen.getByDisplayValue("86400");
        await user.clear(intervalInput);
        await user.type(intervalInput, "7200");
        await user.click(screen.getByRole("button", { name: "Save schedule" }));

        expect(hooks.updateScheduledJob).toHaveBeenCalledWith({
            id: "backup.kopia",
            patch: expect.objectContaining({
                intervalSeconds: 7200,
                scheduleType: "interval",
            }),
        });
    });

    it("saves daily and cron dashboard schedules", async () => {
        const user = userEvent.setup();

        render(<Jobs />);

        const timeInput = screen.getByLabelText("Time of day");
        await user.clear(timeInput);
        await user.type(timeInput, "05:15");
        await user.click(screen.getByRole("button", { name: "Save schedule" }));
        expect(hooks.updateScheduledJob).toHaveBeenCalledWith({
            id: "backup.kopia",
            patch: expect.objectContaining({
                cronExpression: null,
                scheduleType: "daily",
                timeOfDay: "05:15",
            }),
        });

        await user.click(screen.getByRole("button", { name: "Schedule type: Daily" }));
        await user.click(screen.getByRole("menuitem", { name: /Cron/ }));
        const cronInput = screen.getByLabelText("Cron expression");
        await user.type(cronInput, "0 4 * * *");
        await user.click(screen.getByRole("button", { name: "Save schedule" }));

        expect(hooks.updateScheduledJob).toHaveBeenLastCalledWith({
            id: "backup.kopia",
            patch: expect.objectContaining({
                cronExpression: "0 4 * * *",
                scheduleType: "cron",
                timeOfDay: null,
            }),
        });
    });

    it("preserves scheduled schedule drafts across job refreshes", async () => {
        const user = userEvent.setup();
        const { rerender } = render(<Jobs />);

        await user.click(screen.getByRole("button", { name: "Schedule type: Daily" }));
        await user.click(screen.getByRole("menuitem", { name: /Interval/ }));
        const intervalInput = screen.getByDisplayValue("86400");
        await user.clear(intervalInput);
        await user.type(intervalInput, "7200");

        mockScheduledJobs({
            data: [
                {
                    actionKey: "backup.run",
                    actionPayload: { target: "kopia" },
                    createdAt: "2026-06-17T20:00:00.000Z",
                    cronExpression: null,
                    description: "Run nightly backup",
                    enabled: false,
                    id: "backup.kopia",
                    intervalSeconds: 86_400,
                    isRunning: true,
                    lastRun: null,
                    name: "Backup",
                    nextRunAt: null,
                    scheduleType: "daily",
                    timeOfDay: "04:10",
                    updatedAt: "2026-06-17T21:01:10.000Z",
                },
            ],
        });
        rerender(<Jobs />);

        expect(screen.getByDisplayValue("7200")).toBeInTheDocument();
    });

    it("opens OpenClaw cron from jobs deep links", () => {
        window.history.replaceState(null, "", "/jobs?view=openclaw&job=cleanup");

        render(<Jobs />);

        expect(screen.getByTestId("cron-list")).toHaveTextContent("selected: cleanup");
        expect(screen.getByTestId("cron-details")).toHaveTextContent("job: Cleanup");
    });

    it("shows OpenClaw empty and retry states inside the active tab", async () => {
        const user = userEvent.setup();
        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: false,
            refetch: hooks.refetch,
        });

        const { rerender } = render(<Jobs />);
        await switchToOpenClawCron(user);

        expect(
            screen.getByText("OpenClaw cron jobs will appear here.")
        ).toBeInTheDocument();

        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: new Error("OpenClaw unavailable"),
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(<Jobs />);
        await user.click(screen.getByRole("button", { name: "Retry" }));

        expect(hooks.refetch).toHaveBeenCalledTimes(1);
    });

    it("renders scheduled pending and loading run states", () => {
        hooks.useRunScheduledJobNow.mockReturnValue({
            isPending: true,
            mutateAsync: hooks.runScheduledNow,
        });
        hooks.useUpdateScheduledJob.mockReturnValue({
            isPending: true,
            mutateAsync: hooks.updateScheduledJob,
        });
        mockScheduledRuns({
            data: [],
            isLoading: true,
        });

        render(<Jobs />);

        expect(screen.getByText("Running...")).toBeInTheDocument();
        expect(screen.getByText("Saving...")).toBeInTheDocument();
        expect(screen.getByText("Loading runs...")).toBeInTheDocument();
    });

    it("uses the scheduled edit fallback for non-Error save failures", async () => {
        const user = userEvent.setup();
        hooks.updateScheduledJob.mockRejectedValueOnce("nope");

        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: "Schedule type: Daily" }));
        await user.click(screen.getByRole("menuitem", { name: /Interval/ }));
        await user.click(screen.getByRole("button", { name: "Save schedule" }));

        expect(
            await screen.findByText("Scheduled job update failed")
        ).toBeInTheDocument();
    });

    it("shows scheduled action failures", async () => {
        const user = userEvent.setup();
        hooks.runScheduledNow.mockRejectedValueOnce(new Error("Run failed"));
        hooks.updateScheduledJob.mockRejectedValueOnce(new Error("Toggle failed"));

        render(<Jobs />);

        await user.click(screen.getByRole("button", { name: "Run now" }));
        expect(await screen.findByText("Run failed")).toBeInTheDocument();

        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        expect(await screen.findByText("Toggle failed")).toBeInTheDocument();
    });

    it("renders sorted jobs and selects a job", async () => {
        const user = userEvent.setup();

        render(<Jobs />);
        await switchToOpenClawCron(user);
        await user.click(screen.getByRole("button", { name: /Dashboard jobs/ }));
        await switchToOpenClawCron(user);

        expect(await screen.findByTestId("cron-list")).toHaveTextContent("jobs: 2");
        expect(screen.getByTestId("cron-list")).toHaveTextContent("current: daily");
        expect(screen.getByTestId("cron-details")).toHaveTextContent(
            "job: Daily summary"
        );

        await user.click(screen.getByRole("button", { name: "Select Cleanup" }));
        expect(screen.getByTestId("cron-list")).toHaveTextContent("selected: cleanup");
        expect(screen.getByTestId("cron-details")).toHaveTextContent("job: Cleanup");
    });

    it("runs, toggles, and saves the selected job", async () => {
        const user = userEvent.setup();

        render(<Jobs />);
        await switchToOpenClawCron(user);

        await user.click(screen.getByRole("button", { name: "Disable" }));
        await user.click(screen.getByRole("button", { name: "Run now" }));
        await screen.findByText("last run: set");
        await user.click(screen.getByRole("button", { name: "Rename" }));
        await user.click(screen.getByRole("button", { name: "Update payload" }));
        await user.click(screen.getByRole("button", { name: "Update delivery" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(hooks.toggleJob).toHaveBeenCalledWith({ id: "daily", enabled: false });
        expect(hooks.runNow).toHaveBeenCalledWith({ id: "daily" });
        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "daily",
            patch: expect.objectContaining({
                name: "Updated job",
                delivery: {},
                payload: { kind: "systemEvent" },
            }),
        });
    });

    it("confirms and deletes the selected job", async () => {
        const user = userEvent.setup();

        render(<Jobs />);
        await switchToOpenClawCron(user);

        await user.click(screen.getByRole("button", { name: "Delete cron" }));
        expect(screen.getByText("Delete Daily summary?")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByText("Delete Daily summary?")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete cron" }));

        await user.click(screen.getByRole("button", { name: "Delete cron job" }));

        expect(hooks.deleteJob).toHaveBeenCalledWith({ id: "daily" });
    });

    it("skips delete confirmations for jobs without ids", async () => {
        const user = userEvent.setup();
        mockCronJobs({
            data: [
                {
                    delivery: { mode: "none" },
                    enabled: true,
                    name: "Missing id",
                    payload: { kind: "systemEvent" },
                    schedule: { expr: "0 9 * * *", kind: "cron" },
                },
            ],
        });

        render(<Jobs />);
        await switchToOpenClawCron(user);

        hooks.deleteJob.mockClear();
        await user.click(screen.getByRole("button", { name: "Delete cron" }));
        await user.click(screen.getByRole("button", { name: "Delete cron job" }));
        expect(hooks.deleteJob).not.toHaveBeenCalled();
        expect(screen.queryByText("Delete Unnamed job?")).not.toBeInTheDocument();
    });

    it("uses cron job ids in delete confirmations when names are missing", async () => {
        const user = userEvent.setup();
        mockCronJobs({
            data: [
                {
                    delivery: { mode: "none" },
                    enabled: true,
                    id: "nameless",
                    payload: { kind: "systemEvent" },
                    schedule: { expr: "0 9 * * *", kind: "cron" },
                },
            ],
        });

        render(<Jobs />);
        await switchToOpenClawCron(user);

        await user.click(screen.getByRole("button", { name: "Delete cron" }));

        expect(screen.getByText("Delete nameless?")).toBeInTheDocument();
    });

    it("keeps pending delete confirmations open", async () => {
        const user = userEvent.setup();
        hooks.useDeleteCronJob.mockReturnValue({
            isPending: true,
            mutateAsync: hooks.deleteJob,
        });

        render(<Jobs />);
        await switchToOpenClawCron(user);
        await user.click(screen.getByRole("button", { name: "Delete cron" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.getByText("Delete Daily summary?")).toBeInTheDocument();
    });

    it("surfaces invalid JSON save errors", async () => {
        const user = userEvent.setup();

        render(<Jobs />);
        await switchToOpenClawCron(user);

        await user.click(screen.getByRole("button", { name: "Edit" }));
        await user.click(screen.getByRole("button", { name: "Invalid schedule" }));
        expect(screen.getByText("invalid: true")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(/Unexpected token/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel edit" }));
        expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument();
    });

    it("uses the generic edit error for non-Error save failures", async () => {
        const user = userEvent.setup();
        hooks.updateJob.mockRejectedValueOnce("nope");

        render(<Jobs />);
        await switchToOpenClawCron(user);

        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(
            await screen.findByText("Invalid JSON in edit fields")
        ).toBeInTheDocument();
    });

    it("shows OpenClaw cron action failures", async () => {
        const user = userEvent.setup();
        hooks.toggleJob.mockRejectedValueOnce(new Error("Toggle cron failed"));
        hooks.runNow.mockRejectedValueOnce(new Error("Run cron failed"));
        hooks.deleteJob.mockRejectedValueOnce(new Error("Delete cron failed"));

        render(<Jobs />);
        await switchToOpenClawCron(user);

        await user.click(screen.getByRole("button", { name: "Disable" }));
        expect(await screen.findByText("Toggle cron failed")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Run now" }));
        expect(await screen.findByText("Run cron failed")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete cron" }));
        await user.click(screen.getByRole("button", { name: "Delete cron job" }));
        expect(await screen.findByText("Delete cron failed")).toBeInTheDocument();
    });

    it("ignores actions when the current job has no identifier", async () => {
        const user = userEvent.setup();
        mockCronJobs({
            data: [
                {
                    enabled: true,
                    name: "Missing id",
                    payload: { kind: "systemEvent" },
                    schedule: { kind: "every", everyMs: 60_000 },
                },
            ],
        });

        render(<Jobs />);
        await switchToOpenClawCron(user);

        expect(await screen.findByTestId("cron-details")).toHaveTextContent(
            "job: Missing id"
        );
        hooks.toggleJob.mockClear();
        hooks.runNow.mockClear();
        hooks.updateJob.mockClear();
        await user.click(screen.getByRole("button", { name: "Disable" }));
        await user.click(screen.getByRole("button", { name: "Run now" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(hooks.toggleJob).not.toHaveBeenCalled();
        expect(hooks.runNow).not.toHaveBeenCalled();
        expect(hooks.updateJob).not.toHaveBeenCalled();
    });

    it("saves jobs with missing optional drafts as empty patch fields", async () => {
        const user = userEvent.setup();
        mockCronJobs({
            data: [
                {
                    enabled: true,
                    id: "minimal",
                },
            ],
        });

        render(<Jobs />);
        await switchToOpenClawCron(user);

        expect(await screen.findByTestId("cron-details")).toHaveTextContent(
            "name draft:"
        );
        expect(screen.getByTestId("cron-details")).toHaveTextContent(
            "schedule draft: {}"
        );

        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "minimal",
            patch: expect.objectContaining({
                name: undefined,
                payload: {},
                schedule: {},
            }),
        });
    });
});
