import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, jest } from "bun:test";

import { database } from "../src/database.ts";
import {
    scopedJobProcessCommand,
    scopedJobProcessEnvironment,
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
    isJobWorkerReleaseReady,
    protectRunningJobExecutionFromCancellation,
    recoverExpiredJobExecutions,
    registerJobWorker,
    unregisterJobWorker,
} from "../src/services/jobExecutionQueue.ts";
import { waitForJobExecution } from "../src/services/queuedJobExecution.ts";
import {
    enqueueScheduledJob,
    reconcileOrphanedDeploymentCutovers,
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
const testDeploymentIds = new Set<string>();

afterEach(async () => {
    await stopScheduledJobExecutor();
    for (const executionId of testExecutionIds) {
        database.prepare("DELETE FROM job_executions WHERE id = ?").run(executionId);
    }
    for (const jobId of testJobIds) {
        database.prepare("DELETE FROM scheduled_job_runs WHERE job_id = ?").run(jobId);
        database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(jobId);
    }
    for (const deploymentId of testDeploymentIds) {
        database
            .prepare("DELETE FROM deployment_lock WHERE job_id = ?")
            .run(deploymentId);
        database.prepare("DELETE FROM deployment_jobs WHERE id = ?").run(deploymentId);
    }
    testExecutionIds.clear();
    testJobIds.clear();
    testDeploymentIds.clear();
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

function createVerifyingDeployment(
    updatedAt: string,
    candidateCommit = "c".repeat(40)
): string {
    const deploymentId = `test-orphaned-cutover-${Bun.randomUUIDv7()}`;
    testDeploymentIds.add(deploymentId);
    database
        .prepare(
            `INSERT INTO deployment_jobs (
                id, status, started_at, updated_at, commit_sha, note, stdout, stderr
             ) VALUES (?, 'verifying', ?, ?, ?, ?, '', '')`
        )
        .run(deploymentId, updatedAt, updatedAt, candidateCommit, "Waiting for guardian");
    database
        .prepare("INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)")
        .run(deploymentId, updatedAt);
    return deploymentId;
}

describe("persistent job execution queue", () => {
    it("schedules rollback recovery for an inactive detached cutover", () => {
        const startedAt = "2026-07-26T03:00:00.000Z";
        const recoveredAt = "2026-07-26T03:01:00.000Z";
        const deploymentId = createVerifyingDeployment(startedAt);
        const recovery = jest.fn(() => true);

        expect(
            reconcileOrphanedDeploymentCutovers(recoveredAt, () => "active", recovery)
        ).toBe(0);
        expect(recovery).not.toHaveBeenCalled();
        expect(
            reconcileOrphanedDeploymentCutovers(recoveredAt, () => "inactive", recovery)
        ).toBe(1);
        expect(recovery).toHaveBeenCalledWith({
            candidateCommit: "c".repeat(40),
            id: deploymentId,
            updatedAt: startedAt,
        });
        expect(
            database
                .prepare(
                    `SELECT status, updated_at AS updatedAt, note
                     FROM deployment_jobs
                     WHERE id = ?`
                )
                .get(deploymentId)
        ).toEqual({
            note: "Waiting for guardian",
            status: "verifying",
            updatedAt: startedAt,
        });
        expect(
            database
                .prepare("SELECT job_id FROM deployment_lock WHERE job_id = ?")
                .get(deploymentId)
        ).toEqual({ job_id: deploymentId });
    });

    it("warns once when an orphaned cutover has no recovery handler", () => {
        const startedAt = "2026-07-26T03:00:00.000Z";
        const deploymentId = createVerifyingDeployment(startedAt);
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            expect(
                reconcileOrphanedDeploymentCutovers(
                    "2026-07-26T03:11:00.000Z",
                    () => "inactive",
                    undefined
                )
            ).toBe(0);
            expect(
                reconcileOrphanedDeploymentCutovers(
                    "2026-07-26T03:12:00.000Z",
                    () => "inactive",
                    undefined
                )
            ).toBe(0);
            expect(warning).toHaveBeenCalledTimes(1);
            expect(warning).toHaveBeenCalledWith(
                "[ScheduledJobs] Cannot recover orphaned deployment cutovers because no recovery handler is registered",
                { cutoverIds: [deploymentId] }
            );
        } finally {
            warning.mockRestore();
        }
    });

    it("terminalizes an inactive legacy cutover without a persisted full SHA", () => {
        const startedAt = "2026-07-26T03:00:00.000Z";
        const deploymentId = createVerifyingDeployment(startedAt, "c0ffee12");
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
        const recovery = jest.fn(() => true);
        try {
            expect(
                reconcileOrphanedDeploymentCutovers(
                    "2026-07-26T03:01:00.000Z",
                    () => "inactive",
                    recovery
                )
            ).toBe(1);
            expect(recovery).not.toHaveBeenCalled();
            expect(warning).toHaveBeenCalledWith(
                "[ScheduledJobs] Terminalized unrecoverable legacy deployment cutover",
                {
                    candidateCommit: "c0ffee12",
                    cutoverId: deploymentId,
                }
            );
        } finally {
            warning.mockRestore();
        }
        expect(
            database
                .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                .get(deploymentId)
        ).toEqual({
            note: "Interrupted legacy deployment cutover cannot be recovered because it lacks a persisted full candidate SHA",
            status: "failed",
        });
        expect(
            database
                .prepare("SELECT job_id FROM deployment_lock WHERE job_id = ?")
                .get(deploymentId)
        ).toBeNull();
        expect(
            reconcileOrphanedDeploymentCutovers(
                "2026-07-26T03:02:00.000Z",
                () => "inactive",
                recovery
            )
        ).toBe(0);
    });

    it("bounds an explicit unknown guardian state by scheduling recovery", () => {
        const startedAt = "2026-07-26T03:00:00.000Z";
        const deploymentId = createVerifyingDeployment(startedAt);
        const recovery = jest.fn(() => true);

        expect(
            reconcileOrphanedDeploymentCutovers(
                "2026-07-26T03:01:00.000Z",
                () => "unknown",
                recovery
            )
        ).toBe(0);
        expect(recovery).not.toHaveBeenCalled();
        expect(
            reconcileOrphanedDeploymentCutovers(
                "2026-07-26T03:10:00.000Z",
                () => "unknown",
                recovery
            )
        ).toBe(1);
        expect(
            reconcileOrphanedDeploymentCutovers(
                "2026-07-26T03:11:00.000Z",
                () => "unknown",
                recovery
            )
        ).toBe(1);
        expect(recovery).toHaveBeenCalledWith({
            candidateCommit: "c".repeat(40),
            id: deploymentId,
            updatedAt: startedAt,
        });
        expect(recovery).toHaveBeenCalledTimes(2);
    });

    it("bounds guardian inspection failures by scheduling rollback recovery", () => {
        const startedAt = "2026-07-26T03:00:00.000Z";
        const deploymentId = createVerifyingDeployment(startedAt);
        const recovery = jest.fn(() => true);

        expect(
            reconcileOrphanedDeploymentCutovers(
                "2026-07-26T03:01:00.000Z",
                () => "unknown",
                recovery
            )
        ).toBe(0);
        expect(recovery).not.toHaveBeenCalled();
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            expect(
                reconcileOrphanedDeploymentCutovers(
                    "2026-07-26T03:11:00.000Z",
                    () => {
                        throw new Error("systemd unavailable");
                    },
                    recovery
                )
            ).toBe(1);
            expect(warning).toHaveBeenCalledWith(
                "[ScheduledJobs] Failed to inspect detached deployment guardian:",
                expect.any(Error)
            );
        } finally {
            warning.mockRestore();
        }
        expect(recovery).toHaveBeenCalledWith({
            candidateCommit: "c".repeat(40),
            id: deploymentId,
            updatedAt: startedAt,
        });
        expect(
            database
                .prepare(
                    `SELECT status, updated_at AS updatedAt, note
                     FROM deployment_jobs
                     WHERE id = ?`
                )
                .get(deploymentId)
        ).toEqual({
            note: "Waiting for guardian",
            status: "verifying",
            updatedAt: startedAt,
        });
        expect(
            database
                .prepare("SELECT job_id FROM deployment_lock WHERE job_id = ?")
                .get(deploymentId)
        ).toEqual({ job_id: deploymentId });
    });

    it("accepts a loaded active unit when systemctl emits benign diagnostics", () => {
        const startedAt = "2026-07-26T03:00:00.000Z";
        createVerifyingDeployment(startedAt);
        const originalPath = process.env.PATH;
        let fakeBin: string | undefined;
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            fakeBin = mkdtempSync(path.join(tmpdir(), "mira-systemctl-test-"));
            const systemctl = path.join(fakeBin, "systemctl");
            writeFileSync(
                systemctl,
                String.raw`#!/usr/bin/env bash
printf 'benign diagnostic\n' >&2
printf 'LoadState=loaded\nActiveState=active\n'
`
            );
            chmodSync(systemctl, 0o755);
            process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
            const recovery = jest.fn(() => true);
            expect(
                reconcileOrphanedDeploymentCutovers(
                    "2026-07-26T03:11:00.000Z",
                    undefined,
                    recovery
                )
            ).toBe(0);
            expect(recovery).not.toHaveBeenCalled();
            expect(warning).toHaveBeenCalledWith(
                "[ScheduledJobs] systemctl show reported diagnostics",
                expect.objectContaining({
                    stderr: "benign diagnostic",
                })
            );
        } finally {
            warning.mockRestore();
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
            if (fakeBin) {
                rmSync(fakeBin, { force: true, recursive: true });
            }
        }
    });

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

    it("keeps shared queued work when its observer times out", async () => {
        const queued = enqueueJobExecution({
            actionKey: `test.shared-wait-timeout-${Bun.randomUUIDv7()}`,
            displayName: "Shared timed out wait",
            resourceClass: "network",
            timeoutMs: 60_000,
        });
        testExecutionIds.add(queued.id);

        await expect(
            waitForJobExecution(queued.id, {
                cancelQueuedOnTimeout: false,
                pollIntervalMs: 10,
                timeoutMs: 0,
            })
        ).rejects.toMatchObject({
            executionId: queued.id,
            statusCode: 504,
        });
        expect(getJobExecution(queued.id)).toMatchObject({
            status: "queued",
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

    it("requires a fresh heartbeat from the requested worker release", () => {
        const releaseCommit = "a".repeat(40);
        const workerId = `dashboard-worker:${releaseCommit}:123:${Bun.randomUUIDv7()}`;
        registerJobWorker(workerId, 1, "2026-07-22T10:00:00.000Z");
        try {
            expect(
                isJobWorkerReleaseReady(
                    releaseCommit,
                    Date.parse("2026-07-22T10:00:29.000Z")
                )
            ).toBe(true);
            expect(
                isJobWorkerReleaseReady(
                    releaseCommit,
                    Date.parse("2026-07-22T10:00:31.000Z")
                )
            ).toBe(false);
            expect(
                isJobWorkerReleaseReady(
                    "b".repeat(40),
                    Date.parse("2026-07-22T10:00:29.000Z")
                )
            ).toBe(false);
            expect(isJobWorkerReleaseReady("not-a-commit")).toBe(false);
        } finally {
            unregisterJobWorker(workerId);
        }
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

    it("preserves only user-bus variables for scoped children with restricted env", () => {
        const restrictedEnvironment = { PATH: "/usr/bin" };
        const inheritedEnvironment = {
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
            INTERNAL_SECRET: "must-not-leak",
            XDG_RUNTIME_DIR: "/run/user/1000",
        };

        const expectedEnvironment = {
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
            PATH: "/usr/bin",
            XDG_RUNTIME_DIR: "/run/user/1000",
        };

        expect(
            scopedJobProcessEnvironment(
                "systemd-run",
                restrictedEnvironment,
                inheritedEnvironment
            )
        ).toEqual(expectedEnvironment);
        expect(
            scopedJobProcessEnvironment(
                "/usr/bin/systemd-run",
                restrictedEnvironment,
                inheritedEnvironment
            )
        ).toEqual(expectedEnvironment);
        expect(
            scopedJobProcessEnvironment(
                "bash",
                restrictedEnvironment,
                inheritedEnvironment
            )
        ).toBe(restrictedEnvironment);
        expect(
            scopedJobProcessEnvironment("systemd-run", undefined, inheritedEnvironment)
        ).toBeUndefined();
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

    it("cancels queued system work when its scheduled job is disabled", async () => {
        const actionKey = `test.disabled-system-${Bun.randomUUIDv7()}`;
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
            name: "Disabled system test job",
            scheduleType: "interval",
        });
        const run = enqueueScheduledJob(jobId, "system");
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
