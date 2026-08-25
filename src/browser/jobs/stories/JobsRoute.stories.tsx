import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type {
    JobRunSummary,
    JobWorkerControl,
    ScheduleSummary,
} from "../../../contracts/jobModel.ts";
import type {
    JobQueueSummary,
    JobRunDetail,
    ListJobRunsResult,
} from "../../../contracts/jobs.ts";
import type { ListNotificationsResult } from "../../../contracts/notifications.ts";
import type {
    ListOpenClawCronResult,
    ListOpenClawCronRunsResult,
    OpenClawCronJob,
} from "../../../contracts/openClawCron.ts";
import type {
    ListScheduleRunsResult,
    ListSchedulesResult,
} from "../../../contracts/schedules.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtureValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const observedAtMs = 1_800_000_000_000;
const asyncStoryTimeout = { timeout: 5000 } as const;
const runId = "019fe400-0000-7000-8000-000000000001";
const scheduleId = "system.worker-smoke";

const workerControl = {
    claimingPaused: false,
    updatedAtMs: observedAtMs,
    version: 1,
} as const satisfies JobWorkerControl;

const queuedRun = {
    actionKey: scheduleId,
    attemptCount: 0,
    attemptLimit: 3,
    availableAtMs: observedAtMs,
    cancellationPolicy: "cooperative",
    displayName: "Worker smoke manual run",
    eventCount: 1,
    id: runId,
    priority: 0,
    queuedAtMs: observedAtMs,
    resourceClass: "light",
    resourceKeys: [],
    retrySafe: true,
    scheduledJobId: scheduleId,
    scheduledJobVersion: 1,
    state: "queued",
    stateVersion: 1,
    timeoutMs: 60_000,
    triggerType: "manual",
    updatedAtMs: observedAtMs,
} as const satisfies JobRunSummary;

const queueSummary = {
    activeResourceClasses: [],
    control: workerControl,
    oldestQueuedAtMs: queuedRun.queuedAtMs,
    stateCounts: {
        cancelled: 0,
        failed: 0,
        queued: 1,
        running: 0,
        succeeded: 0,
        "timed-out": 0,
    },
    workers: [
        {
            activeRunCount: 0,
            capacity: 2,
            heartbeatAtMs: observedAtMs,
            id: "019fe400-0000-7000-8000-000000000003",
            releaseId: "a".repeat(40),
            startedAtMs: observedAtMs - 60_000,
            state: "online",
        },
    ],
} as const satisfies JobQueueSummary;

const populatedRuns = {
    runs: [queuedRun],
    summary: queueSummary,
} as const satisfies ListJobRunsResult;

const emptyRuns = {
    runs: [],
    summary: {
        ...queueSummary,
        oldestQueuedAtMs: undefined,
        stateCounts: { ...queueSummary.stateCounts, queued: 0 },
    },
} as const satisfies ListJobRunsResult;

const runDetail = {
    events: [
        {
            attempt: 0,
            kind: "queued",
            occurredAtMs: queuedRun.queuedAtMs,
            sequence: 1,
        },
    ],
    run: queuedRun,
} as const satisfies JobRunDetail;

const schedule = {
    actionKey: scheduleId,
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    createdAtMs: observedAtMs - 10_000,
    description: "Checks the durable worker without host mutation.",
    enabled: true,
    id: scheduleId,
    manualRunAvailable: true,
    name: "Worker smoke",
    nextRunAtMs: observedAtMs + 60_000,
    priority: 0,
    resourceClass: "light",
    resourceKeys: [],
    retrySafe: true,
    schedule: { intervalMs: 60_000, kind: "interval" },
    timeoutMs: 60_000,
    updatedAtMs: observedAtMs,
    version: 1,
} as const satisfies ScheduleSummary;

const schedules = {
    schedules: [schedule],
} as const satisfies ListSchedulesResult;

const scheduleRuns = {
    runs: [queuedRun],
} as const satisfies ListScheduleRunsResult;

const openClawJob = {
    agentId: "main",
    agentIdTruncated: false,
    configRevision: "nightly-report-revision",
    createdAtMs: observedAtMs - 86_400_000,
    delivery: {
        completionDestinationConfigured: false,
        metadataTruncated: false,
        mode: "announce",
        targetConfigured: true,
    },
    deliveryMode: "announce",
    description: "Produces the nightly operations report.",
    descriptionTruncated: false,
    enabled: true,
    id: "nightly-report",
    name: "Nightly report",
    nameTruncated: false,
    payload: {
        kind: "agent-turn",
        message: "Produce the nightly operations report.",
        model: "openai/gpt-5.6-sol",
        truncated: false,
    },
    schedule: {
        expr: "0 7 * * *",
        kind: "cron",
        truncated: false,
        tz: "Europe/Oslo",
    },
    sessionTarget: "isolated",
    source: "openclaw",
    state: {
        lastRunAtMs: observedAtMs - 3_600_000,
        lastRunStatus: "ok",
        nextRunAtMs: observedAtMs + 82_800_000,
    },
    synchronization: { state: "confirmed" },
    updatedAtMs: observedAtMs - 60_000,
    wakeMode: "now",
} as const satisfies OpenClawCronJob;

const openClawSchedules = {
    freshness: { kind: "fresh", observedAtMs },
    hasMore: false,
    jobs: [openClawJob],
    limit: 50,
    offset: 0,
    snapshotRevision: `sha256:${"A".repeat(43)}`,
    total: 1,
} as const satisfies ListOpenClawCronResult;

const openClawRuns = {
    freshness: { kind: "fresh", observedAtMs },
    hasMore: false,
    limit: 50,
    offset: 0,
    runs: [
        {
            completedAtMs: observedAtMs - 3_600_000,
            deliveryStatus: "delivered",
            durationMs: 32_000,
            jobId: openClawJob.id,
            model: "openai/gpt-5.6-sol",
            modelTruncated: false,
            provider: "openai",
            providerTruncated: false,
            runAtMs: observedAtMs - 3_632_000,
            runId: "openclaw-run-1",
            status: "ok",
            summary: "Report delivered.",
            summaryTruncated: false,
        },
    ],
    total: 1,
} as const satisfies ListOpenClawCronRunsResult;

const notifications = {
    notifications: [],
    readCount: 0,
    unreadCount: 0,
} as const satisfies ListNotificationsResult;

interface JobsFixtureOptions {
    readonly jobRuns?: DashboardStoryFixtureValue;
    readonly openClawJobs?: DashboardStoryFixtureValue;
    readonly openClawRuns?: DashboardStoryFixtureValue;
    readonly runDetail?: DashboardStoryFixtureValue;
    readonly scheduleDetail?: DashboardStoryFixtureValue;
    readonly scheduleRuns?: DashboardStoryFixtureValue;
    readonly schedules?: DashboardStoryFixtureValue;
    readonly workerControlMutation?: DashboardStoryFixtureValue;
}

function jobsFixtures(options: JobsFixtureOptions = {}): DashboardStoryFixtures {
    return {
        mutations: {
            "jobs.setClaimingPaused":
                options.workerControlMutation ??
                dashboardStoryValue({
                    claimingPaused: true,
                    updatedAtMs: observedAtMs + 1000,
                    version: 2,
                } satisfies JobWorkerControl),
        },
        queries: {
            "jobs.getRun": options.runDetail ?? dashboardStoryValue(runDetail),
            "jobs.listRuns": options.jobRuns ?? dashboardStoryValue(populatedRuns),
            "notifications.list": dashboardStoryValue(notifications),
            "openClawCron.list":
                options.openClawJobs ?? dashboardStoryValue(openClawSchedules),
            "openClawCron.listRuns":
                options.openClawRuns ?? dashboardStoryValue(openClawRuns),
            "schedules.get": options.scheduleDetail ?? dashboardStoryValue(schedule),
            "schedules.list": options.schedules ?? dashboardStoryValue(schedules),
            "schedules.listRuns":
                options.scheduleRuns ?? dashboardStoryValue(scheduleRuns),
        },
    };
}

const pending = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to render the independent loading states.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        fixtures: jobsFixtures({
            jobRuns: pending,
            schedules: pending,
        }),
        route: "/jobs",
    },
};

export const DashboardJobs: Story = {
    args: { fixtures: jobsFixtures(), route: "/jobs" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByRole(
                "heading",
                { level: 1, name: "Jobs" },
                asyncStoryTimeout
            )
        ).toBeVisible();
        const queuedRunsTable = await canvas.findByRole(
            "table",
            { name: "Queued and running jobs" },
            asyncStoryTimeout
        );
        const dashboardSchedules = await canvas.findByRole(
            "list",
            { name: "Dashboard schedules" },
            asyncStoryTimeout
        );
        await expect(queuedRunsTable).toBeVisible();
        await expect(dashboardSchedules).toBeVisible();
    },
};

export const OpenClawSchedules: Story = {
    args: { fixtures: jobsFixtures(), route: "/jobs" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("tab", { name: "OpenClaw schedules" })
        );
        await waitFor(
            async () => {
                await expect(
                    canvas.getByRole("heading", {
                        level: 2,
                        name: "OpenClaw scheduled jobs",
                    })
                ).toBeVisible();
                await expect(
                    canvas.getByRole("heading", {
                        level: 3,
                        name: "Nightly report",
                    })
                ).toBeVisible();
            },
            { timeout: 5000 }
        );
    },
};

export const Empty: Story = {
    args: {
        fixtures: jobsFixtures({
            jobRuns: dashboardStoryValue(emptyRuns),
            scheduleRuns: dashboardStoryValue({
                runs: [],
            } satisfies ListScheduleRunsResult),
            schedules: dashboardStoryValue({
                schedules: [],
            } satisfies ListSchedulesResult),
        }),
        route: "/jobs",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByText("No queued or running jobs.")).toBeVisible();
        await expect(await canvas.findByText("No recent jobs.")).toBeVisible();
        await expect(await canvas.findByText("No matching schedules")).toBeVisible();
    },
};

export const InitialError: Story = {
    args: {
        fixtures: jobsFixtures({
            jobRuns: dashboardStoryFailure(new TypeError("Private jobs failure")),
            schedules: dashboardStoryFailure(new TypeError("Private schedules failure")),
        }),
        route: "/jobs",
    },
};

export const BrowserRetained: Story = {
    args: {
        fixtures: jobsFixtures({
            jobRuns: dashboardStoryResolver((_input, callIndex) => {
                if (callIndex < 2) return populatedRuns;
                throw new TypeError("Safe retained jobs refresh failure");
            }),
        }),
        route: "/jobs",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const runButton = await canvas.findByRole("button", {
            name: `Open run ${queuedRun.displayName}; action ${queuedRun.actionKey}; id ${queuedRun.id}`,
        });
        await userEvent.click(canvas.getByRole("button", { name: "Pause new jobs" }));
        await expect(
            await canvas.findByRole("button", { name: "Resume new jobs" })
        ).toBeVisible();
        await waitFor(
            async () => {
                const warnings = canvas.getAllByText(
                    "The request could not be completed. Try again."
                );
                await expect(warnings.length).toBeGreaterThan(0);
            },
            { timeout: 8000 }
        );
        await expect(runButton).toBeVisible();
    },
};

export const RunDetail: Story = {
    args: {
        fixtures: jobsFixtures(),
        route: `/jobs?scheduleId=${scheduleId}&runId=${runId}`,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(async () => {
            await expect(
                canvas.getByRole("heading", {
                    level: 2,
                    name: queuedRun.displayName,
                })
            ).toBeVisible();
            await expect(
                canvas.getByRole("list", { name: "Job activity" })
            ).toBeVisible();
        }, asyncStoryTimeout);
    },
};

export const ScheduleDetail: Story = {
    args: { fixtures: jobsFixtures(), route: "/jobs" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: `${schedule.name}; ${schedule.id}`,
            })
        );
        await expect(
            await canvas.findByRole("heading", { level: 2, name: schedule.name })
        ).toBeVisible();
        await expect(
            canvas.getByRole("form", { name: `Edit ${schedule.name} schedule` })
        ).toBeVisible();
    },
};

export const Busy: Story = {
    args: {
        fixtures: jobsFixtures({
            workerControlMutation: dashboardStoryResolver(
                () =>
                    new Promise<never>(() => {
                        // Intentionally pending to preserve the real queue-control busy state.
                    })
            ),
        }),
        route: "/jobs",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Pause new jobs" })
        );
        const busyButton = await canvas.findByRole("button", {
            name: "Pause new jobs",
        });
        await expect(busyButton).toBeDisabled();
        await expect(busyButton).toHaveAttribute("aria-busy", "true");
        await expect(canvas.getByText("Accepting new jobs")).toBeVisible();
    },
};
