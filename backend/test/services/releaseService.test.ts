import { describe, expect, it, jest } from "bun:test";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import { database, sqlNullable } from "../../src/database/connection.ts";
import { resolveDashboardProjectPaths } from "../../src/lib/dashboardPaths.ts";
import * as processModule from "../../src/lib/processes.ts";
import {
    ensureDashboardReleaseLayout,
    managedReleasePath,
} from "../../src/services/releases/releaseLayout.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
import {
    createReleaseFixture,
    rewriteReleaseFixtureSchemaVersion,
} from "../support/releaseFixture.ts";
import { startTestScheduledJobExecutor } from "../support/scheduledJobExecutor.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend release services", () => {
    const {
        cleanupCallbacks,
        countRollbackExecutions,
        createTemporaryRoot,
        executeSuccessfulGuardianHandoff,
        executeSuccessfulGuardianPath,
        installCurrentTestRuntime,
        rememberEnvironment,
        rollbackRouteRequest,
        startTestScheduledExecutor,
        waitFor,
    } = createServiceBehaviorHarness();
    it("maps recent deployment jobs in newest-first order", async () => {
        const olderId = `test-deploy-older-${Bun.randomUUIDv7()}`;
        const newerId = `test-deploy-newer-${Bun.randomUUIDv7()}`;
        database
            .prepare(`INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                olderId,
                "failed",
                "2026-06-24T10:00:00.000Z",
                "2026-06-24T10:01:00.000Z",
                "abc123",
                "Older deploy",
                "older note",
                "older out",
                "older err"
            );
        database
            .prepare(`INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                newerId,
                "verifying",
                "2026-06-24T11:00:00.000Z",
                "2026-06-24T11:01:00.000Z",
                "def456",
                "Newer deploy",
                "newer note",
                "newer out",
                ""
            );
        try {
            const { readDeploymentJobs } =
                await import("../../src/services/pullRequests/deploymentJobRepository.ts");
            const jobs = readDeploymentJobs();
            expect(jobs.findIndex((job) => job.id === newerId)).toBeLessThan(
                jobs.findIndex((job) => job.id === olderId)
            );
            expect(jobs.find((job) => job.id === newerId)).toMatchObject({
                id: newerId,
                status: "verifying",
                commit: "def456",
                commitTitle: "Newer deploy",
                note: "newer note",
                stdout: "newer out",
                stderr: "",
            });
        } finally {
            database
                .prepare("DELETE FROM deployment_jobs WHERE id IN (?, ?)")
                .run(olderId, newerId);
        }
    });
    it("reports managed release slots and queues rollback through the release lock", async () => {
        rememberEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE");
        rememberEnvironment("MIRA_DASHBOARD_RELEASES_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_PROJECT_ROOT");
        const projectRoot = createTemporaryRoot("mira-release-status-project-");
        const releasesRoot = createTemporaryRoot("mira-release-status-");
        const currentCommit = "a".repeat(40);
        const previousCommit = "b".repeat(40);
        await ensureDashboardReleaseLayout(releasesRoot);
        await createReleaseFixture(
            managedReleasePath(releasesRoot, currentCommit),
            currentCommit,
            {
                commitTitle: "Current dashboard release",
            }
        );
        await createReleaseFixture(
            managedReleasePath(releasesRoot, previousCommit),
            previousCommit,
            {
                commitTitle: "Previous dashboard release",
            }
        );
        symlinkSync(
            `releases/${currentCommit}`,
            path.join(releasesRoot, "current"),
            "dir"
        );
        symlinkSync(
            `releases/${previousCommit}`,
            path.join(releasesRoot, "previous"),
            "dir"
        );
        await installCurrentTestRuntime(projectRoot);
        process.env.MIRA_DASHBOARD_PROJECT_ROOT = projectRoot;
        process.env.MIRA_DASHBOARD_RELEASES_ROOT = releasesRoot;
        const { getDashboardReleaseStatus, prepareAndStartRollback } = await Promise.all([
            import("../../src/services/pullRequests/releaseStatus.ts"),
            import("../../src/services/pullRequests/deploymentService.ts"),
        ]).then(([module0, module1]) => ({
            getDashboardReleaseStatus: module0.getDashboardReleaseStatus,
            prepareAndStartRollback: module1.prepareAndStartRollback,
        }));
        const { pullRequestRoutes } =
            await import("../../src/routes/pullRequestRoutes.ts");
        const { cancelJobExecution } =
            await import("../../src/services/jobExecutionQueue/worker.ts");
        const failedRuntimeId = `test-runtime-failed-${Bun.randomUUIDv7()}`;
        database
            .prepare(`INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, 'failed', ?, ?, ?, ?, ?, NULL, NULL)`)
            .run(
                failedRuntimeId,
                "2026-07-27T12:30:00.000Z",
                "2026-07-27T12:32:00.000Z",
                previousCommit,
                "Previous dashboard release",
                "Release readiness failed; automatic rollback restored the exact pre-deploy release slots"
            );
        try {
            expect(getDashboardReleaseStatus()).resolves.toMatchObject({
                rollback: {
                    available: false,
                    reason: "Previous release failed its latest runtime readiness check",
                },
            });
            expect(prepareAndStartRollback(previousCommit)).rejects.toThrow(
                "Previous release is not eligible for rollback: Previous release failed its latest runtime readiness check"
            );
        } finally {
            database
                .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                .run(failedRuntimeId);
        }
        const status = await getDashboardReleaseStatus();
        expect(status).toMatchObject({
            current: {
                commitSha: currentCommit,
                commitTitle: "Current dashboard release",
            },
            previous: {
                commitSha: previousCommit,
                commitTitle: "Previous dashboard release",
            },
            rollback: {
                available: true,
            },
        });
        const statusResponse =
            await pullRequestRoutes["/api/pull-requests/releases"].GET();
        expect(statusResponse.status).toBe(200);
        expect(statusResponse.json()).resolves.toMatchObject({
            release: {
                rollback: {
                    available: true,
                },
            },
        });
        const rollbackResponse = await pullRequestRoutes[
            "/api/pull-requests/releases/rollback"
        ].POST(rollbackRouteRequest(previousCommit));
        expect(rollbackResponse.status).toBe(200);
        const rollbackBody = (await rollbackResponse.json()) as {
            deployment: Awaited<ReturnType<typeof prepareAndStartRollback>>;
            isOk: boolean;
        };
        expect(rollbackBody.isOk).toBe(true);
        const rollback = rollbackBody.deployment;
        try {
            expect(rollback).toMatchObject({
                commit: previousCommit,
                commitTitle: "Previous dashboard release",
                note: "Rollback to bbbbbbbb queued",
                status: "building",
            });
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toEqual({
                job_id: rollback.id,
            });
            const execution = database
                .prepare(`SELECT id, display_name
                     FROM job_executions
                     WHERE action_key = 'dashboard.rollback'
                       AND json_extract(payload_json, '$.deploymentId') = ?`)
                .get(rollback.id) as {
                display_name: string;
                id: string;
            };
            expect(execution.display_name).toBe("Roll back Mira Dashboard to bbbbbbbb");
            cancelJobExecution(execution.id);
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(rollback.id)
            ).toEqual({
                note: "Rollback cancelled before execution",
                status: "failed",
            });
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toBeNull();
            expect(prepareAndStartRollback(currentCommit)).rejects.toThrow(
                "Rollback target changed"
            );
            const changedTargetResponse = await pullRequestRoutes[
                "/api/pull-requests/releases/rollback"
            ].POST(rollbackRouteRequest(currentCommit));
            expect(changedTargetResponse.status).toBe(409);
            expect(changedTargetResponse.json()).resolves.toMatchObject(
                apiErrorExpectation(
                    "Rollback target changed. Refresh release status and confirm the current previous release"
                )
            );
            const missingTargetResponse =
                await pullRequestRoutes["/api/pull-requests/releases/rollback"].POST(
                    rollbackRouteRequest()
                );
            expect(missingTargetResponse.status).toBe(400);
            expect(missingTargetResponse.json()).resolves.toMatchObject(
                apiErrorExpectation(
                    expect.stringContaining("body.targetCommit"),
                    "invalid_request"
                )
            );
            const nullBodyResponse = await pullRequestRoutes[
                "/api/pull-requests/releases/rollback"
            ].POST(
                new Request(
                    "https://dashboard.test/api/pull-requests/releases/rollback",
                    {
                        body: "null",
                        headers: {
                            "Content-Type": "application/json",
                        },
                        method: "POST",
                    }
                )
            );
            expect(nullBodyResponse.status).toBe(400);
            expect(nullBodyResponse.json()).resolves.toMatchObject(
                apiErrorExpectation(expect.stringContaining("body"), "invalid_request")
            );
            rmSync(path.join(releasesRoot, "previous"));
            expect(getDashboardReleaseStatus()).resolves.toMatchObject({
                previous: undefined,
                rollback: {
                    available: false,
                    reason: "No distinct previous release is available",
                },
            });
            expect(prepareAndStartRollback(previousCommit)).rejects.toThrow(
                "requires active current and previous releases"
            );
            const unavailableRollbackResponse = await pullRequestRoutes[
                "/api/pull-requests/releases/rollback"
            ].POST(rollbackRouteRequest(previousCommit));
            expect(unavailableRollbackResponse.status).toBe(409);
            expect(unavailableRollbackResponse.json()).resolves.toMatchObject(
                apiErrorExpectation(
                    "Managed release rollback requires active current and previous releases"
                )
            );
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toBeNull();
            symlinkSync(
                `releases/${currentCommit}`,
                path.join(releasesRoot, "previous"),
                "dir"
            );
            expect(prepareAndStartRollback(currentCommit)).rejects.toThrow(
                "requires two distinct releases"
            );
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toBeNull();
            process.env.MIRA_DASHBOARD_RELEASES_ROOT = "relative-release-root";
            const unavailableStatusResponse =
                await pullRequestRoutes["/api/pull-requests/releases"].GET();
            expect(unavailableStatusResponse.status).toBe(500);
            process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = "1";
            const isolatedStatusResponse =
                await pullRequestRoutes["/api/pull-requests/releases"].GET();
            expect(isolatedStatusResponse.status).toBe(200);
            expect(isolatedStatusResponse.json()).resolves.toEqual({
                release: {
                    rollback: {
                        available: false,
                        reason: "Production release metadata is unavailable in isolated PR dev",
                    },
                },
            });
            delete process.env.MIRA_DASHBOARD_DEV_SAFE_MODE;
            process.env.MIRA_DASHBOARD_RELEASES_ROOT = releasesRoot;
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database
                .prepare(`DELETE FROM job_executions
                     WHERE action_key = 'dashboard.rollback'
                       AND json_extract(payload_json, '$.deploymentId') = ?`)
                .run(rollback.id);
            database.prepare("DELETE FROM deployment_jobs WHERE id = ?").run(rollback.id);
        }
    });
    it("hides schema-incompatible rollback targets before queueing work", async () => {
        rememberEnvironment("MIRA_DASHBOARD_RELEASES_ROOT");
        const releasesRoot = createTemporaryRoot("mira-release-schema-status-");
        const currentCommit = "c".repeat(40);
        const previousCommit = "d".repeat(40);
        await ensureDashboardReleaseLayout(releasesRoot);
        await createReleaseFixture(
            managedReleasePath(releasesRoot, currentCommit),
            currentCommit,
            {
                commitTitle: "Schema 9 dashboard release",
            }
        );
        const previousReleasePath = managedReleasePath(releasesRoot, previousCommit);
        await createReleaseFixture(previousReleasePath, previousCommit, {
            commitTitle: "Schema 6 dashboard release",
        });
        await rewriteReleaseFixtureSchemaVersion(previousReleasePath, 6);
        symlinkSync(
            `releases/${currentCommit}`,
            path.join(releasesRoot, "current"),
            "dir"
        );
        symlinkSync(
            `releases/${previousCommit}`,
            path.join(releasesRoot, "previous"),
            "dir"
        );
        process.env.MIRA_DASHBOARD_RELEASES_ROOT = releasesRoot;
        const { getDashboardReleaseStatus, prepareAndStartRollback } = await Promise.all([
            import("../../src/services/pullRequests/releaseStatus.ts"),
            import("../../src/services/pullRequests/deploymentService.ts"),
        ]).then(([module0, module1]) => ({
            getDashboardReleaseStatus: module0.getDashboardReleaseStatus,
            prepareAndStartRollback: module1.prepareAndStartRollback,
        }));
        const { pullRequestRoutes } =
            await import("../../src/routes/pullRequestRoutes.ts");
        const executionCountBefore = countRollbackExecutions();
        expect(getDashboardReleaseStatus()).resolves.toMatchObject({
            current: {
                commitSha: currentCommit,
                schema: {
                    maximumCompatible: 9,
                    target: 9,
                },
            },
            previous: {
                commitSha: previousCommit,
                schema: {
                    maximumCompatible: 6,
                    target: 6,
                },
            },
            rollback: {
                available: false,
                reason: "Rollback release cannot open SQLite schema 9",
            },
        });
        expect(prepareAndStartRollback(previousCommit)).rejects.toThrow(
            "Previous release is not eligible for rollback: Rollback release cannot open SQLite schema 9"
        );
        const response = await pullRequestRoutes[
            "/api/pull-requests/releases/rollback"
        ].POST(rollbackRouteRequest(previousCommit));
        expect(response.status).toBe(409);
        expect(response.json()).resolves.toMatchObject(
            apiErrorExpectation(
                "Previous release is not eligible for rollback: Rollback release cannot open SQLite schema 9"
            )
        );
        expect(countRollbackExecutions()).toBe(executionCountBefore);
        expect(
            database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
        ).toBeNull();
    });
    it("rejects malformed and missing rollback worker executions", async () => {
        const { registerPullRequestExecutionActions } =
            await import("../../src/services/pullRequests/executionActions.ts");
        const { enqueueJobExecution, getJobExecution } =
            await import("../../src/services/jobExecutionQueue/repository.ts");
        registerPullRequestExecutionActions();
        await startTestScheduledExecutor();
        const missingIdExecution = enqueueJobExecution({
            actionKey: "dashboard.rollback",
            displayName: "Rollback without deployment id",
            payload: {},
            resourceClass: "exclusive",
            timeoutMs: 1000,
        });
        const absentDeploymentId = `missing-rollback-${Bun.randomUUIDv7()}`;
        const missingDeploymentExecution = enqueueJobExecution({
            actionKey: "dashboard.rollback",
            displayName: "Rollback with missing deployment",
            payload: {
                deploymentId: absentDeploymentId,
            },
            resourceClass: "exclusive",
            timeoutMs: 1000,
        });
        try {
            await waitFor(
                () =>
                    getJobExecution(missingIdExecution.id)?.status === "failed" &&
                    getJobExecution(missingDeploymentExecution.id)?.status === "failed",
                5000
            );
            expect(getJobExecution(missingIdExecution.id)).toMatchObject({
                message: "Deployment id is missing",
                status: "failed",
            });
            expect(getJobExecution(missingDeploymentExecution.id)).toMatchObject({
                message: "Deployment job not found",
                status: "failed",
            });
        } finally {
            database
                .prepare("DELETE FROM job_executions WHERE id IN (?, ?)")
                .run(missingIdExecution.id, missingDeploymentExecution.id);
        }
    });
    it("hands manual rollback to a detached readiness-bound guardian", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_PROJECT_ROOT");
        const fakeRoot = createTemporaryRoot("mira-release-rollback-root-");
        const projectPaths = resolveDashboardProjectPaths({
            MIRA_DASHBOARD_PROJECT_ROOT: fakeRoot,
        });
        const fakeBin = createTemporaryRoot("mira-release-rollback-bin-");
        const releasesRoot = projectPaths.productionReleasesRoot;
        const systemdScriptLog = path.join(fakeRoot, "rollback-guardian.sh");
        const systemdArgumentsLog = path.join(fakeRoot, "rollback-systemd-run.args");
        const currentCommit = "c".repeat(40);
        const previousCommit = "d".repeat(40);
        mkdirSync(path.join(projectPaths.productionCheckoutRoot, "backend"), {
            recursive: true,
        });
        mkdirSync(projectPaths.productionStateRoot, {
            recursive: true,
        });
        await ensureDashboardReleaseLayout(releasesRoot);
        await createReleaseFixture(
            managedReleasePath(releasesRoot, currentCommit),
            currentCommit,
            {
                commitTitle: "Current rollback source",
            }
        );
        await createReleaseFixture(
            managedReleasePath(releasesRoot, previousCommit),
            previousCommit,
            {
                commitTitle: "Verified rollback target",
            }
        );
        symlinkSync(
            `releases/${currentCommit}`,
            path.join(releasesRoot, "current"),
            "dir"
        );
        symlinkSync(
            `releases/${previousCommit}`,
            path.join(releasesRoot, "previous"),
            "dir"
        );
        await installCurrentTestRuntime(fakeRoot);
        writeFileSync(
            path.join(fakeBin, "systemctl"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" != *"--user show"* ]]; then
  echo "unexpected systemctl args: $*" >&2
  exit 2
fi
if [[ "$*" == *"mira-dashboard-worker.service"* ]]; then
  entrypoint="dist/workerStart.js"
else
  entrypoint="dist/serverStart.js"
fi
printf '%s\n' \
  "Environment=NODE_ENV=production MIRA_DASHBOARD_PROJECT_ROOT=${fakeRoot}" \
  "ExecStart={ path=/usr/local/bin/doppler ; argv[]=/usr/local/bin/doppler run --preserve-env=NODE_ENV,MIRA_DASHBOARD_PROJECT_ROOT -- ${releasesRoot}/current/scripts/runManagedDashboardRelease.sh $entrypoint ; }" \
  "WorkingDirectory=${releasesRoot}/current/backend"
`
        );
        writeFileSync(
            path.join(fakeBin, "systemd-run"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
script="${"$"}{!#}"
/bin/bash -n <<<"$script"
printf '%s' "$script" > ${JSON.stringify(systemdScriptLog)}
printf '%s\n' "$@" > ${JSON.stringify(systemdArgumentsLog)}
printf 'scheduled\n'
`
        );
        chmodSync(path.join(fakeBin, "systemctl"), 0o755);
        chmodSync(path.join(fakeBin, "systemd-run"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_PROJECT_ROOT = fakeRoot;
        const { prepareAndStartRollback, registerPullRequestExecutionActions } =
            await Promise.all([
                import("../../src/services/pullRequests/deploymentService.ts"),
                import("../../src/services/pullRequests/executionActions.ts"),
            ]).then(([module0, module1]) => ({
                prepareAndStartRollback: module0.prepareAndStartRollback,
                registerPullRequestExecutionActions:
                    module1.registerPullRequestExecutionActions,
            }));
        const { getJobExecution } =
            await import("../../src/services/jobExecutionQueue/repository.ts");
        const { reconcileOrphanedDeploymentCutovers } =
            await import("../../src/services/scheduledJobs/runtime.ts");
        registerPullRequestExecutionActions();
        await startTestScheduledExecutor();
        const rollback = await prepareAndStartRollback(previousCommit);
        const execution = database
            .prepare(`SELECT id
                 FROM job_executions
                 WHERE action_key = 'dashboard.rollback'
                   AND json_extract(payload_json, '$.deploymentId') = ?`)
            .get(rollback.id) as {
            id: string;
        };
        try {
            await waitFor(() => {
                const row = database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(rollback.id) as
                    | {
                          note: string | null;
                          status: string;
                      }
                    | undefined;
                return (
                    row?.status === "verifying" &&
                    row.note ===
                        "Rollback target verified. Activating it, restarting services, then verifying web, worker, deployed commit, and 31 seconds of worker stability; automatic restoration is armed" &&
                    existsSync(systemdScriptLog)
                );
            }, 5000);
            await waitFor(
                () => getJobExecution(execution.id)?.status === "success",
                5000
            );
            const guardian = readFileSync(systemdScriptLog, "utf8");
            const scheduledUpdatedAt = (
                database
                    .prepare(
                        "SELECT updated_at AS updatedAt FROM deployment_jobs WHERE id = ?"
                    )
                    .get(rollback.id) as {
                    updatedAt: string;
                }
            ).updatedAt;
            expect(guardian).toContain(
                `${releasesRoot}/releases/${currentCommit}/backend/dist/releaseLifecycle.js`
            );
            expect(guardian).toContain(
                '/usr/bin/timeout --signal=KILL 5s "$runtime_path" --revision'
            );
            expect(guardian).toContain(`rollback '${currentCommit}' '${previousCommit}'`);
            expect(guardian).toContain(`rollback '${previousCommit}' '${currentCommit}'`);
            expect(guardian).toContain(
                `ready_for_commit '${previousCommit.slice(0, 8)}'`
            );
            expect(guardian).toContain(`ready_for_commit '${currentCommit.slice(0, 8)}'`);
            expect(guardian).toContain(
                "Original release cccccccc was restored automatically"
            );
            expect(guardian).toContain(
                "Atomic rollback activated dddddddd. Web, worker, commit, and 31-second worker stability checks passed"
            );
            expect(guardian).toContain("updatedAt: new Date().toISOString()");
            expect(readFileSync(systemdArgumentsLog, "utf8")).toContain(
                `--unit=mira-dashboard-deploy-${rollback.id}\n`
            );
            expect(readFileSync(systemdArgumentsLog, "utf8")).toContain(
                "--expand-environment=no\n"
            );
            expect(
                reconcileOrphanedDeploymentCutovers(
                    new Date().toISOString(),
                    () => "inactive"
                )
            ).toBe(1);
            const recoveryGuardian = readFileSync(systemdScriptLog, "utf8");
            expect(recoveryGuardian).toContain("recovery_mode='rollback'");
            expect(recoveryGuardian).toContain(
                'run_activation_lifecycle rollback "$candidate_commit" "$rollback_commit"'
            );
            expect(recoveryGuardian).toContain(
                "if restore_failed_candidate && restart_services"
            );
            expect(readFileSync(systemdArgumentsLog, "utf8")).toContain(
                "--expand-environment=no\n"
            );
            await executeSuccessfulGuardianPath(guardian);
            const completedRollback = database
                .prepare(`SELECT status, note, updated_at AS updatedAt
                     FROM deployment_jobs
                     WHERE id = ?`)
                .get(rollback.id) as {
                note: string;
                status: string;
                updatedAt: string;
            };
            expect(completedRollback).toMatchObject({
                note: "Atomic rollback activated dddddddd. Web, worker, commit, and 31-second worker stability checks passed",
                status: "isOk",
            });
            expect(new Date(completedRollback.updatedAt).toISOString()).toBe(
                completedRollback.updatedAt
            );
            expect(Date.parse(completedRollback.updatedAt)).toBeGreaterThan(
                Date.parse(scheduledUpdatedAt)
            );
        } finally {
            database
                .prepare("UPDATE deployment_jobs SET status = 'failed' WHERE id = ?")
                .run(rollback.id);
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database.prepare("DELETE FROM job_executions WHERE id = ?").run(execution.id);
            database.prepare("DELETE FROM deployment_jobs WHERE id = ?").run(rollback.id);
        }
    });
    it("rejects active deployment locks before starting deploy work", async () => {
        const jobId = `test-deploy-active-${Bun.randomUUIDv7()}`;
        const staleOwner = `test-deploy-stale-owner-${Bun.randomUUIDv7()}`;
        database
            .prepare(`INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                jobId,
                "building",
                new Date().toISOString(),
                new Date().toISOString(),
                sqlNullable(),
                sqlNullable(),
                "active",
                "",
                ""
            );
        database
            .prepare(
                "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
            )
            .run(jobId, new Date().toISOString());
        try {
            const { startDeployLatest } =
                await import("../../src/services/pullRequests/deploymentService.ts");
            expect(() => startDeployLatest()).toThrow(
                `Dashboard release action already in progress (${jobId})`
            );
            expect(() => startDeployLatest(staleOwner)).toThrow(
                "Dashboard deploy lock handoff failed"
            );
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database.prepare("DELETE FROM deployment_jobs WHERE id = ?").run(jobId);
        }
    });
    it("labels stale rollback executions as rollback failures", async () => {
        const staleRollbackId = `test-rollback-stale-${Bun.randomUUIDv7()}`;
        const { enqueueJobExecution } =
            await import("../../src/services/jobExecutionQueue/repository.ts");
        const { startDeployLatest } =
            await import("../../src/services/pullRequests/deploymentService.ts");
        database
            .prepare(`INSERT INTO deployment_jobs
                 (id, status, started_at, updated_at, commit_sha, commit_title, note, stdout, stderr)
                 VALUES (?, 'building', ?, ?, ?, ?, 'rollback queued', '', '')`)
            .run(
                staleRollbackId,
                new Date().toISOString(),
                new Date().toISOString(),
                "b".repeat(40),
                "Previous release"
            );
        database
            .prepare(
                "INSERT INTO deployment_lock (id, job_id, updated_at) VALUES (1, ?, ?)"
            )
            .run(staleRollbackId, new Date().toISOString());
        const staleExecution = enqueueJobExecution({
            actionKey: "dashboard.rollback",
            displayName: "Stale rollback",
            payload: {
                deploymentId: staleRollbackId,
            },
            resourceClass: "exclusive",
            timeoutMs: 1000,
        });
        database
            .prepare(`UPDATE job_executions
                 SET status = 'failed', finished_at = ?, message = 'worker stopped'
                 WHERE id = ?`)
            .run(new Date().toISOString(), staleExecution.id);
        let replacementId: string | undefined;
        try {
            const replacement = startDeployLatest();
            replacementId = replacement.id;
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(staleRollbackId)
            ).toEqual({
                note: "Rollback execution ended before build completion",
                status: "failed",
            });
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database
                .prepare("DELETE FROM job_executions WHERE id = ?")
                .run(staleExecution.id);
            database
                .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                .run(staleRollbackId);
            if (replacementId) {
                database
                    .prepare(`DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`)
                    .run(replacementId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(replacementId);
            }
        }
    });
    it("keeps queued deployment locks active beyond the legacy stale window", async () => {
        const { startDeployLatest } =
            await import("../../src/services/pullRequests/deploymentService.ts");
        const { cancelJobExecution } =
            await import("../../src/services/jobExecutionQueue/worker.ts");
        const first = startDeployLatest();
        let replacementId: string | undefined;
        try {
            database
                .prepare("UPDATE deployment_jobs SET updated_at = ? WHERE id = ?")
                .run("2026-01-01T00:00:00.000Z", first.id);
            database
                .prepare("UPDATE deployment_lock SET updated_at = ? WHERE job_id = ?")
                .run("2026-01-01T00:00:00.000Z", first.id);
            expect(() => startDeployLatest()).toThrow(
                `Dashboard release action already in progress (${first.id})`
            );
            const firstExecution = database
                .prepare(`SELECT id
                     FROM job_executions
                     WHERE action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?`)
                .get(first.id) as {
                id: string;
            };
            cancelJobExecution(firstExecution.id);
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(first.id)
            ).toEqual({
                note: "Deploy cancelled before execution",
                status: "failed",
            });
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toBeNull();
            const replacement = startDeployLatest();
            replacementId = replacement.id;
            expect(replacement.id).not.toBe(first.id);
        } finally {
            const deploymentIds = [first.id, replacementId].filter((id): id is string =>
                Boolean(id)
            );
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            for (const deploymentId of deploymentIds) {
                database
                    .prepare(`DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`)
                    .run(deploymentId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(deploymentId);
            }
        }
    });
    it("fails deployments and releases their locks when worker leases expire", async () => {
        const { startDeployLatest } =
            await import("../../src/services/pullRequests/deploymentService.ts");
        const { getJobExecution, recoverExpiredJobExecutions } = await Promise.all([
            import("../../src/services/jobExecutionQueue/repository.ts"),
            import("../../src/services/jobExecutionQueue/worker.ts"),
        ]).then(([module0, module1]) => ({
            getJobExecution: module0.getJobExecution,
            recoverExpiredJobExecutions: module1.recoverExpiredJobExecutions,
        }));
        const deployment = startDeployLatest();
        let replacementId: string | undefined;
        try {
            const execution = database
                .prepare(`SELECT id
                     FROM job_executions
                     WHERE action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?`)
                .get(deployment.id) as {
                id: string;
            };
            database
                .prepare(`UPDATE job_executions
                     SET status = 'running', started_at = ?, heartbeat_at = ?,
                         lease_owner = ?, lease_expires_at = ?, attempt = 1
                     WHERE id = ?`)
                .run(
                    "2100-01-01T00:00:00.000Z",
                    "2100-01-01T00:00:00.000Z",
                    "missing-deploy-worker",
                    "2100-01-01T00:02:00.000Z",
                    execution.id
                );
            expect(recoverExpiredJobExecutions("2100-01-01T00:03:00.000Z")).toBe(1);
            expect(getJobExecution(execution.id)).toMatchObject({
                message: "Job failed after its worker lease expired",
                status: "failed",
            });
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(deployment.id)
            ).toEqual({
                note: "Deploy failed after its worker lease expired",
                status: "failed",
            });
            expect(
                database.prepare("SELECT job_id FROM deployment_lock WHERE id = 1").get()
            ).toBeNull();
            const replacement = startDeployLatest();
            replacementId = replacement.id;
            expect(replacement.status).toBe("building");
        } finally {
            const deploymentIds = [deployment.id, replacementId].filter(
                (id): id is string => Boolean(id)
            );
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            for (const deploymentId of deploymentIds) {
                database
                    .prepare(`DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`)
                    .run(deploymentId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(deploymentId);
            }
        }
    });
    it("reserves the deployment lock while a pull request approval is queued", async () => {
        const { runPullRequestApproval, startDeployLatest } = await Promise.all([
            import("../../src/services/pullRequests/executionActions.ts"),
            import("../../src/services/pullRequests/deploymentService.ts"),
        ]).then(([module0, module1]) => ({
            runPullRequestApproval: module0.runPullRequestApproval,
            startDeployLatest: module1.startDeployLatest,
        }));
        const { cancelJobExecution } =
            await import("../../src/services/jobExecutionQueue/worker.ts");
        const approval = runPullRequestApproval(11, false, {
            expectedHeadSha: "1".repeat(40),
        });
        let approvalExecutionId: string | undefined;
        let deploymentId: string | undefined;
        try {
            const execution = database
                .prepare(`SELECT id
                     FROM job_executions
                     WHERE action_key = 'github.merge'
                     ORDER BY queued_at DESC, id DESC
                     LIMIT 1`)
                .get() as {
                id: string;
            };
            approvalExecutionId = execution.id;
            expect(() => startDeployLatest()).toThrow(
                "Dashboard release action already in progress"
            );
            cancelJobExecution(execution.id);
            expect(approval).rejects.toThrow("Job cancelled before execution");
            const deployment = startDeployLatest();
            deploymentId = deployment.id;
            expect(deployment.status).toBe("building");
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            if (approvalExecutionId) {
                database
                    .prepare("DELETE FROM job_executions WHERE id = ?")
                    .run(approvalExecutionId);
            }
            if (deploymentId) {
                database
                    .prepare(`DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`)
                    .run(deploymentId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(deploymentId);
            }
        }
    });
    it("publishes an immutable release and hands activation to detached cutover", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_PROJECT_ROOT");
        rememberEnvironment("PORT");
        const fakeRoot = createTemporaryRoot("mira-pr-deploy-root-");
        const projectPaths = resolveDashboardProjectPaths({
            MIRA_DASHBOARD_PROJECT_ROOT: fakeRoot,
        });
        const fakeBin = createTemporaryRoot("mira-pr-deploy-bin-");
        const worktreeRoot = projectPaths.developmentWorktreeRoot;
        const releasesRoot = projectPaths.productionReleasesRoot;
        const candidateTemplate = path.join(fakeRoot, "candidate-template");
        const priorPreviousCommit = "b".repeat(40);
        const oldCommit = "c".repeat(40);
        const candidateCommit = "d".repeat(40);
        const gitHeadFile = path.join(fakeRoot, "git-head");
        const gitLog = path.join(fakeRoot, "git.log");
        const bunLog = path.join(fakeRoot, "bun.log");
        const systemctlLog = path.join(fakeRoot, "systemctl.log");
        const systemdLog = path.join(fakeRoot, "systemd.log");
        mkdirSync(path.join(projectPaths.productionCheckoutRoot, "backend"), {
            recursive: true,
        });
        mkdirSync(worktreeRoot, {
            recursive: true,
        });
        mkdirSync(projectPaths.productionStateRoot, {
            recursive: true,
        });
        mkdirSync(candidateTemplate);
        await createReleaseFixture(candidateTemplate, candidateCommit, {
            commitTitle: "Deployable dashboard commit",
        });
        await ensureDashboardReleaseLayout(releasesRoot);
        const oldReleasePath = managedReleasePath(releasesRoot, oldCommit);
        await createReleaseFixture(oldReleasePath, oldCommit, {
            commitTitle: "Previous dashboard commit",
        });
        const priorPreviousReleasePath = managedReleasePath(
            releasesRoot,
            priorPreviousCommit
        );
        await createReleaseFixture(priorPreviousReleasePath, priorPreviousCommit, {
            commitTitle: "Older dashboard commit",
        });
        symlinkSync(`releases/${oldCommit}`, path.join(releasesRoot, "current"), "dir");
        symlinkSync(
            `releases/${priorPreviousCommit}`,
            path.join(releasesRoot, "previous"),
            "dir"
        );
        writeFileSync(gitHeadFile, candidateCommit);
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
head_commit=$(<${JSON.stringify(gitHeadFile)})
printf '%s\n' "$*" >> ${JSON.stringify(gitLog)}
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(projectPaths.productionCheckoutRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$*" == "rev-parse --short HEAD" ]]; then
  printf '%.8s\n' "$head_commit"
elif [[ "$*" == "rev-parse HEAD" ]]; then
  printf '%s\n' "$head_commit"
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  printf 'origin/main\n'
elif [[ "$*" == "status --short" ]]; then
  printf ''
elif [[ "$*" == "fetch --prune origin" || "$*" == "checkout main" || "$*" == "pull --ff-only origin main" ]]; then
  printf ''
elif [[ "$1 $2 $3" == "worktree add --detach" ]]; then
  mkdir -p "$4"
  cp -a ${JSON.stringify(`${candidateTemplate}/.`)} "$4/"
elif [[ "$1 $2 $3" == "worktree remove --force" ]]; then
  rm -rf "$4"
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        writeFileSync(
            path.join(fakeBin, "bun"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "$PWD" "$*" >> ${JSON.stringify(bunLog)}
if [[ "$*" == "install --frozen-lockfile" || "$*" == "run deploy:prepare" || "$*" == "dist/databasePreflight.js" ]]; then
  printf 'ok\n'
elif [[ "$1" == "-e" || "$1" == */releaseLifecycle.js ]]; then
  exec ${JSON.stringify(process.execPath)} "$@"
else
  echo "unexpected bun args: $*" >&2
  exit 2
fi
`
        );
        writeFileSync(
            path.join(fakeBin, "systemctl"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(systemctlLog)}
if [[ "$*" == "--user show mira-dashboard-deploy-"*".service --property=ActiveState --property=LoadState --no-pager" ]]; then
  printf 'LoadState=loaded\nActiveState=active\n'
  exit 0
fi
if [[ "$*" != *"--user show"* ]]; then
  echo "unexpected systemctl args: $*" >&2
  exit 2
fi
if [[ "$*" == *"mira-dashboard-worker.service"* ]]; then
  entrypoint="dist/workerStart.js"
else
  entrypoint="dist/serverStart.js"
fi
printf '%s\n' \
  "Environment=NODE_ENV=production MIRA_DASHBOARD_PROJECT_ROOT=${fakeRoot}" \
  "ExecStart={ path=/usr/local/bin/doppler ; argv[]=/usr/local/bin/doppler run --preserve-env=NODE_ENV,MIRA_DASHBOARD_PROJECT_ROOT -- ${releasesRoot}/current/scripts/runManagedDashboardRelease.sh $entrypoint ; }" \
  'WorkingDirectory=${releasesRoot}/current/backend'
`
        );
        writeFileSync(
            path.join(fakeBin, "systemd-run"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
script="${"$"}{!#}"
/bin/bash -n <<<"$script"
printf '%s\n' "$*" >> ${JSON.stringify(systemdLog)}
printf 'scheduled\n'
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        chmodSync(path.join(fakeBin, "bun"), 0o755);
        chmodSync(path.join(fakeBin, "systemctl"), 0o755);
        chmodSync(path.join(fakeBin, "systemd-run"), 0o755);
        const runProcess = processModule.runProcess;
        const bunProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation(async (command, arguments_, options) => {
                if (
                    command === process.execPath &&
                    (arguments_[0] === "install" ||
                        (arguments_[0] === "run" && arguments_[1] === "deploy:prepare") ||
                        arguments_[0] === "dist/databasePreflight.js")
                ) {
                    appendFileSync(
                        bunLog,
                        `${options?.cwd ?? process.cwd()}|${arguments_.join(" ")}\n`
                    );
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "ok\n",
                    };
                }
                return runProcess(command, arguments_, options);
            });
        cleanupCallbacks.push(() => bunProcessSpy.mockRestore());
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_PROJECT_ROOT = fakeRoot;
        process.env.PORT = "4310";
        const { registerPullRequestExecutionActions, startDeployLatest } =
            await Promise.all([
                import("../../src/services/pullRequests/executionActions.ts"),
                import("../../src/services/pullRequests/deploymentService.ts"),
            ]).then(([module0, module1]) => ({
                registerPullRequestExecutionActions:
                    module0.registerPullRequestExecutionActions,
                startDeployLatest: module1.startDeployLatest,
            }));
        const { enqueueJobExecution, getJobExecution } =
            await import("../../src/services/jobExecutionQueue/repository.ts");
        const {
            reconcileOrphanedDeploymentCutovers,
            registerScheduledJobAction,
            stopScheduledJobExecutor,
        } = await Promise.all([
            import("../../src/services/scheduledJobs/runtime.ts"),
            import("../../src/services/scheduledJobs/actionRegistry.ts"),
        ]).then(([module0, module1]) => ({
            reconcileOrphanedDeploymentCutovers:
                module0.reconcileOrphanedDeploymentCutovers,
            registerScheduledJobAction: module1.registerScheduledJobAction,
            stopScheduledJobExecutor: module0.stopScheduledJobExecutor,
        }));
        registerPullRequestExecutionActions();
        registerScheduledJobAction("test.after-deploy", () => Promise.try(() => ({})));
        await startTestScheduledExecutor();
        const job = startDeployLatest();
        const deploymentExecution = database
            .prepare(`SELECT id
                 FROM job_executions
                 WHERE action_key = 'dashboard.deploy'
                   AND json_extract(payload_json, '$.deploymentId') = ?`)
            .get(job.id) as {
            id: string;
        };
        const followUpExecution = enqueueJobExecution({
            actionKey: "test.after-deploy",
            displayName: "Must wait for restarted worker",
            priority: 0,
            resourceClass: "light",
            timeoutMs: 1000,
        });
        const createdDeploymentIds = [job.id];
        const failedRuntimeId = `test-runtime-failed-${Bun.randomUUIDv7()}`;
        try {
            await waitFor(() => {
                const row = database
                    .prepare(
                        "SELECT status, commit_sha, commit_title, note FROM deployment_jobs WHERE id = ?"
                    )
                    .get(job.id) as
                    | {
                          commit_sha: string | null;
                          commit_title: string | null;
                          note: string | null;
                          status: string;
                      }
                    | undefined;
                return row?.status === "verifying" && existsSync(systemdLog);
            }, 5000);
            await waitFor(
                () => getJobExecution(deploymentExecution.id)?.status === "success",
                5000
            );
            await stopScheduledJobExecutor();
            startTestScheduledJobExecutor();
            await Bun.sleep(25);
            const row = database
                .prepare(
                    "SELECT status, commit_sha, commit_title, note FROM deployment_jobs WHERE id = ?"
                )
                .get(job.id) as {
                commit_sha: string | null;
                commit_title: string | null;
                note: string | null;
                status: string;
            };
            expect(row).toEqual({
                commit_sha: candidateCommit,
                commit_title: "Deployable dashboard commit",
                note: "Release published. Pausing Dashboard writes, snapshotting SQLite, activating it, then verifying web, worker, deployed commit, and 31 seconds of worker stability; code-and-data rollback is armed",
                status: "verifying",
            });
            const scheduledUpdatedAt = (
                database
                    .prepare(
                        "SELECT updated_at AS updatedAt FROM deployment_jobs WHERE id = ?"
                    )
                    .get(job.id) as {
                    updatedAt: string;
                }
            ).updatedAt;
            expect(Bun.file(gitLog).text()).resolves.toContain(
                "pull --ff-only origin main"
            );
            expect(Bun.file(bunLog).text()).resolves.toContain(
                `${worktreeRoot}/release-${candidateCommit.slice(0, 12)}-`
            );
            expect(Bun.file(bunLog).text()).resolves.toContain("|run deploy:prepare");
            expect(Bun.file(systemctlLog).text()).resolves.toContain(
                "show mira-dashboard.service"
            );
            expect(Bun.file(systemctlLog).text()).resolves.toContain(
                `--user show mira-dashboard-deploy-${job.id}.service --property=ActiveState --property=LoadState --no-pager`
            );
            expect(Bun.file(systemdLog).text()).resolves.toContain(
                `mira-dashboard-deploy-${job.id}`
            );
            const restartCommand = await Bun.file(systemdLog).text();
            expect(restartCommand).toContain("--collect");
            expect(restartCommand).toContain("--expand-environment=no");
            expect(restartCommand).toContain(
                "/usr/local/bin/doppler run --config prd --project rajohan"
            );
            expect(restartCommand).toContain("/usr/bin/sed");
            expect(restartCommand).toContain("s/^0*//");
            expect(restartCommand).toContain(
                "http://127.0.0.1:${dashboard_port}/api/health/ready"
            );
            expect(restartCommand).not.toContain(
                "http://127.0.0.1:4310/api/health/ready"
            );
            expect(restartCommand).toContain("--connect-timeout 2 --max-time 5");
            expect(restartCommand).toContain("for attempt in {1..30}");
            expect(restartCommand).toContain("dashboard_listener_identity");
            expect(restartCommand).toContain(
                "--property=ControlGroup --property=ExecMainStartTimestampMonotonic"
            );
            expect(restartCommand).toContain(
                '/usr/bin/ss -H -ltnp "sport = :$dashboard_port"'
            );
            expect(restartCommand).toContain(
                "listener_cgroup=$(/usr/bin/sed -n 's/^0:://p' \"/proc/$listener_pid/cgroup\""
            );
            expect(restartCommand).toContain(
                'listener_backend=$(/usr/bin/readlink --canonicalize-existing "/proc/$listener_pid/cwd"'
            );
            expect(restartCommand).toContain(
                '[ "$listener_backend" = "$current_backend" ]'
            );
            expect(restartCommand).toContain(
                '[ "$dashboard_identity_after" = "$dashboard_identity_before" ]'
            );
            expect(restartCommand).toContain(
                '[ "$current_dashboard_identity" = "$initial_dashboard_identity" ]'
            );
            expect(restartCommand).toContain("worker_identity");
            expect(restartCommand).toContain("ExecMainStartTimestampMonotonic");
            expect(restartCommand).toContain("sleep 31");
            expect(restartCommand).toContain(
                "Atomic release activated. Web, worker, commit, and 31-second worker stability checks passed"
            );
            expect(restartCommand).toContain("updatedAt: new Date().toISOString()");
            expect(restartCommand).toContain(
                'current_release=$(/usr/bin/realpath --canonicalize-existing "$project_root/production/releases/current"'
            );
            expect(restartCommand).toContain(".commitSha");
            expect(restartCommand).not.toContain(".checks.release.backendCommit");
            expect(restartCommand).toContain("releaseLifecycle.js");
            expect(restartCommand).toContain("MIRA_DEPLOYMENT_SNAPSHOT_ID=");
            expect(restartCommand).toContain('execution?.status === "success"');
            expect(restartCommand).toContain("const deadline = Date.now() + 75000");
            expect(restartCommand).toContain(
                `${releasesRoot}/releases/${candidateCommit}/backend/dist/releaseLifecycle.js`
            );
            expect(restartCommand).toContain("if stop_services; then");
            expect(restartCommand).toContain("snapshot-database");
            expect(restartCommand).toContain("restore-database");
            expect(restartCommand).toContain("discard-database-snapshot");
            expect(restartCommand).toContain(
                `activate '${candidateCommit}' --coordinated-schema-cutover`
            );
            expect(restartCommand.indexOf(`activate '${candidateCommit}'`)).toBeLessThan(
                restartCommand.indexOf("if restart_services")
            );
            expect(restartCommand.indexOf("if stop_services; then")).toBeLessThan(
                restartCommand.indexOf("snapshot-database")
            );
            expect(restartCommand.indexOf("MIRA_DEPLOYMENT_SNAPSHOT_ID=")).toBeLessThan(
                restartCommand.indexOf("if stop_services; then")
            );
            await executeSuccessfulGuardianHandoff(restartCommand);
            expect(restartCommand.indexOf("snapshot-database")).toBeLessThan(
                restartCommand.indexOf(`activate '${candidateCommit}'`)
            );
            expect(
                restartCommand.indexOf(
                    "Atomic release activated. Web, worker, commit, and 31-second worker stability checks passed"
                )
            ).toBeLessThan(restartCommand.indexOf("discard-database-snapshot"));
            expect(restartCommand).toContain(
                `restore '${candidateCommit}' '${oldCommit}' '${priorPreviousCommit}'`
            );
            const automaticRollbackLine = restartCommand
                .split("\n")
                .find((line) =>
                    line.includes(
                        `restore '${candidateCommit}' '${oldCommit}' '${priorPreviousCommit}'`
                    )
                );
            if (!automaticRollbackLine) {
                throw new Error(
                    "Guardian fixture is missing its automatic rollback line"
                );
            }
            expect(automaticRollbackLine).toContain(
                `${releasesRoot}/releases/${candidateCommit}/backend/dist/releaseLifecycle.js`
            );
            expect(automaticRollbackLine).not.toContain(
                `${releasesRoot}/releases/${oldCommit}/backend/dist/releaseLifecycle.js`
            );
            expect(automaticRollbackLine).toContain("if stop_services &&");
            expect(automaticRollbackLine.indexOf("restore-database")).toBeLessThan(
                automaticRollbackLine.indexOf(
                    `restore '${candidateCommit}' '${oldCommit}' '${priorPreviousCommit}'`
                )
            );
            const exactRestoreLines = restartCommand
                .split("\n")
                .filter((line) =>
                    line.includes(
                        `restore '${candidateCommit}' '${oldCommit}' '${priorPreviousCommit}'`
                    )
                );
            expect(exactRestoreLines).toHaveLength(2);
            const activationFailureRestoreLine = exactRestoreLines.find(
                (line) => !line.includes("stop_services")
            );
            if (!activationFailureRestoreLine) {
                throw new Error(
                    "Guardian fixture is missing activation-failure link recovery"
                );
            }
            expect(activationFailureRestoreLine.indexOf("restore-database")).toBeLessThan(
                activationFailureRestoreLine.indexOf(
                    `restore '${candidateCommit}' '${oldCommit}' '${priorPreviousCommit}'`
                )
            );
            expect(
                activationFailureRestoreLine.indexOf(
                    `restore '${candidateCommit}' '${oldCommit}' '${priorPreviousCommit}'`
                )
            ).toBeLessThan(activationFailureRestoreLine.indexOf("restart_services"));
            expect(restartCommand).toContain("prune 3");
            expect(restartCommand).not.toContain("/api/job-executions");
            expect(readlinkSync(path.join(releasesRoot, "current"))).toBe(
                `releases/${oldCommit}`
            );
            expect(readlinkSync(path.join(releasesRoot, "previous"))).toBe(
                `releases/${priorPreviousCommit}`
            );
            const publishedReleasePath = managedReleasePath(
                releasesRoot,
                candidateCommit
            );
            expect(
                readFileSync(
                    path.join(publishedReleasePath, "release-manifest.json"),
                    "utf8"
                )
            ).toContain(candidateCommit);
            expect(
                existsSync(path.join(publishedReleasePath, "not-a-release-artifact.txt"))
            ).toBe(false);
            expect(getJobExecution(deploymentExecution.id)).toMatchObject({
                cancellable: false,
                output: {
                    deploymentId: job.id,
                    releaseCutover: {
                        candidateCommit,
                        databaseSnapshotId: expect.stringMatching(/^[\da-f-]{36}$/u),
                        formatVersion: 2,
                        preActivationCommit: oldCommit,
                        preActivationPreviousCommit: priorPreviousCommit,
                        rollbackCommit: oldCommit,
                    },
                },
                status: "success",
            });
            expect(getJobExecution(followUpExecution.id)).toMatchObject({
                status: "queued",
            });
            expect(
                reconcileOrphanedDeploymentCutovers(
                    new Date().toISOString(),
                    () => "inactive"
                )
            ).toBe(1);
            const recoveryCommand = await Bun.file(systemdLog).text();
            expect(recoveryCommand).toContain(`mira-dashboard-deploy-recovery-${job.id}`);
            expect(recoveryCommand).toContain("--expand-environment=no");
            expect(recoveryCommand).toContain(
                'current_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/current")'
            );
            expect(recoveryCommand).toContain(
                'activation_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/previous")'
            );
            expect(recoveryCommand).toContain(
                'candidate_release=$(/usr/bin/readlink --canonicalize-existing "$releases_root/releases/$candidate_commit")'
            );
            expect(recoveryCommand).toContain('activation_release="$candidate_release"');
            expect(recoveryCommand).toContain(
                'activation_output="$(run_candidate_lifecycle activate "$candidate_commit" --coordinated-schema-cutover)"'
            );
            expect(recoveryCommand).toContain(
                '[ "$activation_commit" = "$candidate_commit" ]'
            );
            expect(recoveryCommand).toContain(
                'if restart_services && ready_for_commit "${candidate_commit:0:8}"; then'
            );
            expect(recoveryCommand).toContain(
                "Interrupted release cutover recovered; active candidate passed restart, commit-bound readiness, and 31-second worker stability"
            );
            const recoveredSuccessStatusIndex = recoveryCommand.indexOf(
                "Interrupted release cutover recovered; active candidate passed restart, commit-bound readiness, and 31-second worker stability"
            );
            expect(recoveredSuccessStatusIndex).toBeGreaterThanOrEqual(0);
            expect(recoveredSuccessStatusIndex).toBeLessThan(
                recoveryCommand.indexOf(
                    "run_candidate_lifecycle discard-database-snapshot",
                    recoveredSuccessStatusIndex
                )
            );
            expect(
                recoveryCommand.indexOf(
                    'activation_output="$(run_candidate_lifecycle activate "$candidate_commit" --coordinated-schema-cutover)"'
                )
            ).toBeLessThan(
                recoveryCommand.indexOf(
                    'if restart_services && ready_for_commit "${candidate_commit:0:8}"; then'
                )
            );
            expect(recoveryCommand).toContain(
                'run_candidate_lifecycle restore "$candidate_commit" "$rollback_commit" "$pre_activation_previous_commit"'
            );
            expect(recoveryCommand).toContain(
                'run_candidate_lifecycle restore-database "$database_snapshot_id"'
            );
            expect(recoveryCommand).toContain(`expected_rollback_commit='${oldCommit}'`);
            expect(recoveryCommand).toContain(
                `pre_activation_previous_commit='${priorPreviousCommit}'`
            );
            expect(recoveryCommand).toContain(
                "automatic rollback restored the exact pre-deploy release slots"
            );
            expect(recoveryCommand).toContain(
                'candidate_lifecycle="$candidate_release/backend/dist/releaseLifecycle.js"'
            );
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(job.id)
            ).toEqual({
                note: "Detached release guardian ended without a terminal result; automatic rollback recovery scheduled",
                status: "verifying",
            });
            expect(
                database
                    .prepare("SELECT job_id FROM deployment_lock WHERE job_id = ?")
                    .get(job.id)
            ).toEqual({
                job_id: job.id,
            });
            database
                .prepare(`UPDATE deployment_jobs
                     SET status = 'failed',
                         updated_at = ?,
                         note = 'Detached restart failed'
                     WHERE id = ?`)
                .run(new Date().toISOString(), job.id);
            await waitFor(
                () => getJobExecution(followUpExecution.id)?.status === "success",
                5000
            );
            expect(getJobExecution(followUpExecution.id)).toMatchObject({
                status: "success",
            });
            database.prepare("DELETE FROM deployment_lock WHERE job_id = ?").run(job.id);
            writeFileSync(gitHeadFile, oldCommit);
            writeFileSync(systemdLog, "");
            const redeploy = startDeployLatest();
            createdDeploymentIds.push(redeploy.id);
            const redeployExecution = database
                .prepare(`SELECT id
                     FROM job_executions
                     WHERE action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?`)
                .get(redeploy.id) as {
                id: string;
            };
            await waitFor(() => {
                const row = database
                    .prepare("SELECT status FROM deployment_jobs WHERE id = ?")
                    .get(redeploy.id) as
                    | {
                          status: string;
                      }
                    | undefined;
                return row?.status === "verifying" && existsSync(systemdLog);
            }, 5000);
            await waitFor(
                () => getJobExecution(redeployExecution.id)?.status === "success",
                5000
            );
            const redeployCommand = await Bun.file(systemdLog).text();
            expect(redeployCommand).toContain(
                `rollback '${oldCommit}' '${priorPreviousCommit}'`
            );
            expect(redeployCommand).toContain(
                "Release readiness failed; automatic rollback activated the previous verified release bbbbbbbb"
            );
            expect(redeployCommand).not.toContain(
                "automatic rollback restored the exact pre-deploy release slots"
            );
            expect(getJobExecution(redeployExecution.id)).toMatchObject({
                output: {
                    deploymentId: redeploy.id,
                    releaseCutover: {
                        candidateCommit: oldCommit,
                        databaseSnapshotId: expect.stringMatching(/^[\da-f-]{36}$/u),
                        formatVersion: 2,
                        preActivationCommit: oldCommit,
                        preActivationPreviousCommit: priorPreviousCommit,
                        rollbackCommit: priorPreviousCommit,
                    },
                },
                status: "success",
            });
            database
                .prepare(`UPDATE deployment_jobs
                     SET status = 'failed',
                         updated_at = ?,
                         note = 'Detached restart failed'
                     WHERE id = ?`)
                .run(new Date().toISOString(), redeploy.id);
            database
                .prepare("DELETE FROM deployment_lock WHERE job_id = ?")
                .run(redeploy.id);
            database
                .prepare(`INSERT INTO deployment_jobs (
                         id, status, started_at, updated_at, commit_sha,
                         commit_title, note, stdout, stderr
                     ) VALUES (?, 'failed', ?, ?, ?, ?, ?, NULL, NULL)`)
                .run(
                    failedRuntimeId,
                    new Date().toISOString(),
                    new Date().toISOString(),
                    priorPreviousCommit,
                    "Known bad fallback",
                    "Release readiness failed; automatic rollback completed"
                );
            const blockedRedeploy = startDeployLatest();
            createdDeploymentIds.push(blockedRedeploy.id);
            const blockedExecution = database
                .prepare(`SELECT id
                     FROM job_executions
                     WHERE action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?`)
                .get(blockedRedeploy.id) as {
                id: string;
            };
            await waitFor(
                () => getJobExecution(blockedExecution.id)?.status === "failed",
                5000
            );
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(blockedRedeploy.id)
            ).toEqual({
                note: "Automatic redeploy fallback is not eligible: Previous release failed its latest runtime readiness check",
                status: "failed",
            });
            database
                .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                .run(failedRuntimeId);
            await rewriteReleaseFixtureSchemaVersion(priorPreviousReleasePath, 6);
            const schemaBlockedRedeploy = startDeployLatest();
            createdDeploymentIds.push(schemaBlockedRedeploy.id);
            const schemaBlockedExecution = database
                .prepare(`SELECT id
                     FROM job_executions
                     WHERE action_key = 'dashboard.deploy'
                       AND json_extract(payload_json, '$.deploymentId') = ?`)
                .get(schemaBlockedRedeploy.id) as {
                id: string;
            };
            await waitFor(
                () => getJobExecution(schemaBlockedExecution.id)?.status === "failed",
                5000
            );
            expect(
                database
                    .prepare("SELECT status, note FROM deployment_jobs WHERE id = ?")
                    .get(schemaBlockedRedeploy.id)
            ).toEqual({
                note: "Automatic redeploy fallback is not eligible: Rollback release cannot open SQLite schema 9",
                status: "failed",
            });
            await executeSuccessfulGuardianPath(restartCommand);
            const completedDeployment = database
                .prepare(`SELECT status, note, updated_at AS updatedAt
                     FROM deployment_jobs
                     WHERE id = ?`)
                .get(job.id) as {
                note: string;
                status: string;
                updatedAt: string;
            };
            expect(completedDeployment).toMatchObject({
                note: "Atomic release activated. Web, worker, commit, and 31-second worker stability checks passed",
                status: "isOk",
            });
            expect(new Date(completedDeployment.updatedAt).toISOString()).toBe(
                completedDeployment.updatedAt
            );
            expect(Date.parse(completedDeployment.updatedAt)).toBeGreaterThan(
                Date.parse(scheduledUpdatedAt)
            );
        } finally {
            database
                .prepare("DELETE FROM job_executions WHERE id = ?")
                .run(followUpExecution.id);
            database
                .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                .run(failedRuntimeId);
            for (const deploymentId of createdDeploymentIds) {
                database
                    .prepare("DELETE FROM deployment_lock WHERE job_id = ?")
                    .run(deploymentId);
                database
                    .prepare("DELETE FROM deployment_jobs WHERE id = ?")
                    .run(deploymentId);
                database
                    .prepare(`DELETE FROM job_executions
                         WHERE action_key = 'dashboard.deploy'
                           AND json_extract(payload_json, '$.deploymentId') = ?`)
                    .run(deploymentId);
            }
        }
    }, 10_000);
});
