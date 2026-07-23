import { afterEach, describe, expect, it } from "bun:test";

import { database } from "../src/database.ts";
import {
    scopedJobProcessCommand,
    withJobResourceClass,
} from "../src/lib/jobResources.ts";
import {
    cancelJobExecution,
    claimNextJobExecution,
    didHeartbeatJobWorker,
    enqueueJobExecution,
    finishJobExecution,
    getJobExecution,
    getJobExecutionSummary,
    insertJobExecution,
    protectRunningJobExecutionFromCancellation,
    recoverExpiredJobExecutions,
    registerJobWorker,
    unregisterJobWorker,
} from "../src/services/jobExecutionQueue.ts";
import { waitForJobExecution } from "../src/services/queuedJobExecution.ts";
import {
    enqueueScheduledJob,
    recoverOrphanedScheduledJobRuns,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    ScheduledJobActionError,
    startScheduledJobExecutor,
    stopScheduledJobExecutor,
    updateScheduledJob,
    upsertScheduledJob,
} from "../src/services/scheduledJobs.ts";

const testJobIds = new Set<string>();
const testExecutionIds = new Set<string>();

afterEach(async () => {
    await stopScheduledJobExecutor();
    for (const executionId of testExecutionIds) {
        database.prepare("DELETE FROM job_executions WHERE id = ?").run(executionId);
    }
    for (const jobId of testJobIds) {
        database.prepare("DELETE FROM scheduled_job_runs WHERE job_id = ?").run(jobId);
        database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(jobId);
    }
    testExecutionIds.clear();
    testJobIds.clear();
});

function createScheduledTestJob(
    resourceClass: "host-heavy" | "interactive",
    name: string
): string {
    const id = `test-queue-${Bun.randomUUIDv7()}`;
    testJobIds.add(id);
    upsertScheduledJob({
        actionKey: `test.queue-${Bun.randomUUIDv7()}`,
        actionPayload: { name },
        id,
        intervalSeconds: 3600,
        name,
        resourceClass,
        scheduleType: "interval",
    });
    return id;
}

describe("persistent job execution queue", () => {
    it("persists worker progress and structured action failures", async () => {
        const actionKey = `test.worker-${Bun.randomUUIDv7()}`;
        registerScheduledJobAction(actionKey, async (_job, _signal, context) => {
            context.updateOutput({ phase: "streaming" });
            throw new ScheduledJobActionError("expected failure", { isOk: false });
        });
        const queued = enqueueJobExecution({
            actionKey,
            displayName: "Structured worker failure",
            resourceClass: "host-heavy",
            timeoutMs: 60_000,
        });
        testExecutionIds.add(queued.id);
        startScheduledJobExecutor();
        const execution = await waitForJobExecution(queued.id, {
            pollIntervalMs: 10,
            timeoutMs: 5000,
        });
        expect(execution).toMatchObject({
            message: "expected failure",
            output: { isOk: false },
            status: "failed",
        });
    });

    it("cancels queued synchronous work when its observer times out", async () => {
        const queued = enqueueJobExecution({
            actionKey: `test.wait-timeout-${Bun.randomUUIDv7()}`,
            displayName: "Timed out synchronous wait",
            resourceClass: "network",
            timeoutMs: 60_000,
        });
        testExecutionIds.add(queued.id);

        await expect(
            waitForJobExecution(queued.id, {
                pollIntervalMs: 10,
                timeoutMs: 0,
            })
        ).rejects.toMatchObject({
            executionId: queued.id,
            statusCode: 504,
        });
        expect(getJobExecution(queued.id)).toMatchObject({
            message: "Job cancelled before execution",
            status: "cancelled",
        });
    });

    it("reports only fresh worker heartbeats as online", () => {
        const workerId = `test-worker-${Bun.randomUUIDv7()}`;
        registerJobWorker(workerId, 1, "2026-07-22T10:00:00.000Z");
        expect(
            getJobExecutionSummary(Date.parse("2026-07-22T10:00:20.000Z"))
        ).toMatchObject({
            workerCapacity: 1,
            workerCount: 1,
            workerOnline: true,
        });
        expect(
            getJobExecutionSummary(Date.parse("2026-07-22T10:01:00.000Z"))
        ).toMatchObject({
            workerCapacity: 0,
            workerCount: 0,
            workerOnline: false,
        });
        expect(didHeartbeatJobWorker(workerId, "2026-07-22T10:01:00.000Z")).toBe(true);
        unregisterJobWorker(workerId);
    });

    it("wraps worker children in class-specific systemd scopes", () => {
        const command = withJobResourceClass("host-heavy", () =>
            scopedJobProcessCommand(
                "docker",
                ["exec", "worker", "sh", "-c", 'printf "%s" "$JOB_COMMAND"'],
                {
                    MIRA_DASHBOARD_ENABLE_JOB_SCOPES: "1",
                    MIRA_DASHBOARD_JOB_SCOPE_OWNER: "mira-dashboard-worker.service",
                }
            )
        );

        expect(command.executable).toBe("systemd-run");
        expect(command.arguments).toEqual(
            expect.arrayContaining([
                "--scope",
                "--expand-environment=no",
                "--nice=15",
                "CPUWeight=15",
                "IOWeight=15",
                "MemoryHigh=2G",
                "MemoryMax=4G",
                "TasksMax=128",
                "RuntimeMaxSec=7h",
                "BindsTo=mira-dashboard-worker.service",
                "docker",
                "exec",
                "worker",
                "sh",
                "-c",
                'printf "%s" "$JOB_COMMAND"',
            ])
        );
    });

    it("allows queued cancellation but protects a running mutation", () => {
        const queued = enqueueJobExecution({
            actionKey: `test.protected-${Bun.randomUUIDv7()}`,
            displayName: "Protected mutation",
            resourceClass: "exclusive",
            timeoutMs: 60_000,
        });
        testExecutionIds.add(queued.id);
        const workerId = `test-worker-${Bun.randomUUIDv7()}`;
        const running = claimNextJobExecution(workerId, 1);
        expect(running?.id).toBe(queued.id);

        expect(protectRunningJobExecutionFromCancellation(queued.id)).toMatchObject({
            cancellable: false,
            status: "running",
        });
        expect(() => cancelJobExecution(queued.id)).toThrow(
            "This job execution cannot be cancelled here"
        );
        finishJobExecution(queued.id, workerId, "success", undefined, {});

        const cancellableWhileQueued = enqueueJobExecution({
            actionKey: `test.queued-cancellation-${Bun.randomUUIDv7()}`,
            displayName: "Queued cancellation",
            resourceClass: "exclusive",
            timeoutMs: 60_000,
        });
        testExecutionIds.add(cancellableWhileQueued.id);
        expect(cancelJobExecution(cancellableWhileQueued.id)).toMatchObject({
            status: "cancelled",
        });
    });

    it("prioritizes interactive work and enforces global capacity", () => {
        const heavyJobId = createScheduledTestJob("host-heavy", "Heavy test job");
        const interactiveJobId = createScheduledTestJob(
            "interactive",
            "Interactive test job"
        );
        const heavyRun = enqueueScheduledJob(heavyJobId);
        const interactiveRun = enqueueScheduledJob(interactiveJobId);
        testExecutionIds.add(heavyRun.executionId as string);
        testExecutionIds.add(interactiveRun.executionId as string);

        const workerId = `test-worker-${Bun.randomUUIDv7()}`;
        const first = claimNextJobExecution(workerId, 1);
        expect(first).toMatchObject({
            resourceClass: "interactive",
            scheduledJobId: interactiveJobId,
            status: "running",
        });
        expect(claimNextJobExecution(workerId, 1)).toBeUndefined();
        finishJobExecution(first!.id, workerId, "success", undefined, {
            completed: true,
        });
        const second = claimNextJobExecution(workerId, 1);
        expect(second).toMatchObject({
            resourceClass: "host-heavy",
            scheduledJobId: heavyJobId,
            status: "running",
        });
        cancelJobExecution(second!.id);
        expect(
            finishJobExecution(second!.id, workerId, "success", undefined, {})
        ).toMatchObject({ status: "cancelled" });
        expect(getJobExecutionSummary()).toMatchObject({ queued: 0, running: 0 });
    });

    it("prevents duplicate active runs and cancels queued work", () => {
        const jobId = createScheduledTestJob("host-heavy", "Unique test job");
        const run = enqueueScheduledJob(jobId);
        testExecutionIds.add(run.executionId as string);

        expect(() => enqueueScheduledJob(jobId)).toThrow(
            "Scheduled job is already queued or running"
        );
        expect(cancelJobExecution(run.executionId as string)).toMatchObject({
            status: "cancelled",
        });
        expect(
            database
                .prepare("SELECT status FROM scheduled_job_runs WHERE id = ?")
                .get(run.id)
        ).toEqual({ status: "cancelled" });
    });

    it("fails abandoned leases without replaying side effects", () => {
        const queuedAt = "2026-01-01T00:00:00.000Z";
        const execution = insertJobExecution({
            actionKey: "test.expired",
            cancellable: false,
            displayName: "Expired execution",
            leaseOwner: "missing-worker",
            queuedAt,
            resourceClass: "exclusive",
            status: "running",
            timeoutMs: 60_000,
            triggerType: "system",
        });
        testExecutionIds.add(execution.id);

        expect(recoverExpiredJobExecutions("2026-01-01T00:03:00.000Z")).toBe(1);
        expect(getJobExecution(execution.id)).toMatchObject({
            message: "Job failed after its worker lease expired",
            status: "failed",
        });
    });

    it("cancels queued startup work when its scheduled job is disabled", async () => {
        const actionKey = `test.disabled-startup-${Bun.randomUUIDv7()}`;
        const jobId = `test-queue-disabled-${Bun.randomUUIDv7()}`;
        let actionCalls = 0;
        testJobIds.add(jobId);
        registerScheduledJobAction(actionKey, () => {
            actionCalls += 1;
            return { unexpected: true };
        });
        upsertScheduledJob({
            actionKey,
            enabled: true,
            id: jobId,
            intervalSeconds: 3600,
            name: "Disabled startup test job",
            scheduleType: "interval",
        });
        const run = enqueueScheduledJob(jobId, "startup");
        testExecutionIds.add(run.executionId as string);
        expect(updateScheduledJob(jobId, { enabled: false })).toMatchObject({
            enabled: false,
        });

        startScheduledJobExecutor();
        const execution = await waitForJobExecution(run.executionId as string, {
            pollIntervalMs: 10,
            timeoutMs: 5000,
        });

        expect(execution).toMatchObject({
            message: "Scheduled job was disabled before execution",
            status: "cancelled",
        });
        expect(actionCalls).toBe(0);
        expect(
            database
                .prepare("SELECT status, message FROM scheduled_job_runs WHERE id = ?")
                .get(run.id)
        ).toEqual({
            message: "Scheduled job was disabled before execution",
            status: "cancelled",
        });
    });

    it("cancels queued work when its scheduled job is removed", async () => {
        const actionKey = `test.removed-job-${Bun.randomUUIDv7()}`;
        const jobId = `test-queue-removed-${Bun.randomUUIDv7()}`;
        let actionCalls = 0;
        testJobIds.add(jobId);
        registerScheduledJobAction(actionKey, () => {
            actionCalls += 1;
            return { unexpected: true };
        });
        upsertScheduledJob({
            actionKey,
            enabled: true,
            id: jobId,
            intervalSeconds: 3600,
            name: "Removed scheduled test job",
            scheduleType: "interval",
        });
        const run = enqueueScheduledJob(jobId, "startup");
        testExecutionIds.add(run.executionId as string);
        removeScheduledJobsNotInAction(actionKey, []);

        startScheduledJobExecutor();
        const execution = await waitForJobExecution(run.executionId as string, {
            pollIntervalMs: 10,
            timeoutMs: 5000,
        });

        expect(execution).toMatchObject({
            message: "Scheduled job was removed before execution",
            status: "cancelled",
        });
        expect(actionCalls).toBe(0);
        expect(
            database.prepare("SELECT id FROM scheduled_job_runs WHERE id = ?").get(run.id)
        ).toBeNull();
    });

    it("fails legacy running scheduled runs without an execution lease", () => {
        const jobId = createScheduledTestJob("host-heavy", "Legacy running job");
        const run = database
            .prepare(
                `INSERT INTO scheduled_job_runs (
                    job_id, status, trigger_type, started_at, output_json
                 ) VALUES (?, 'running', 'schedule', ?, '{}')`
            )
            .run(jobId, "2026-01-01T00:00:00.000Z");

        expect(recoverOrphanedScheduledJobRuns("2026-01-01T00:03:00.000Z")).toBe(1);
        expect(
            database
                .prepare(
                    "SELECT status, finished_at AS finishedAt, message FROM scheduled_job_runs WHERE id = ?"
                )
                .get(Number(run.lastInsertRowid))
        ).toEqual({
            finishedAt: "2026-01-01T00:03:00.000Z",
            message: "Scheduled job interrupted before worker lease recovery",
            status: "failed",
        });
    });
});
