import type { DeploymentJob } from "../../../../contracts/delivery/deployments.ts";
import { database } from "../../database/connection.ts";
import { errorMessage } from "../../lib/errors.ts";
import { enqueueJobExecution } from "../jobExecutionQueue/repository.ts";
import { DEPLOYMENT_WORKER_STABILITY_SECONDS } from "../releases/cutoverCommands.ts";
import {
    assertManagedDashboardServiceContract,
    ensureManagedRuntimeForRelease,
    scheduleReleaseCutover,
    scheduleReleaseRollback,
} from "../releases/cutoverOperations.ts";
import { didScheduleOrphanedReleaseCutoverRecovery } from "../releases/cutoverRecovery.ts";
import { stageDashboardRelease } from "../releases/deployment.ts";
import { readDashboardReleaseState } from "../releases/releaseActivation.ts";
import { resolveDashboardReleasesRoot } from "../releases/releaseLayout.ts";
import { assertDashboardReleaseRuntimeAvailable } from "../releases/schemaCompatibility.ts";
import {
    registerScheduledJobAction,
    ScheduledJobActionError,
} from "../scheduledJobs/actionRegistry.ts";
import { registerDeploymentCutoverRecoveryHandler } from "../scheduledJobs/runtime.ts";
import { getDashboardRoot, getDashboardWorktreeRoot } from "./config.ts";
import {
    createDeploymentCutoverContext,
    type DeploymentCutoverContext,
} from "./deploymentCutoverContext.ts";
import { readDeploymentJob, writeDeploymentJob } from "./deploymentJobRepository.ts";
import {
    acquireDeploymentLock,
    refreshDeploymentHeartbeat,
    registerPullRequestJobLifecycleHandlers,
    releaseDeploymentLock,
} from "./deploymentLock.ts";
import { runCommand } from "./githubCommandClient.ts";
import { rollbackIneligibilityReason } from "./releaseStatus.ts";
import {
    dateToISOString,
    FULL_COMMIT_SHA_PATTERN,
    pullRequestLogger as logger,
} from "./support.ts";
import { syncMain } from "./worktreeManager.ts";

const DEPLOYMENT_RESTART_STATUS_POLL_MS = 1000;
const DEPLOYMENT_RESTART_CLAIM_PAUSE_TIMEOUT_MS = 2 * 60 * 1000;
const ACTIVE_DEPLOYMENT_STATUSES = new Set(["building", "verifying"]);

async function runDeploymentJob(
    job: DeploymentJob,
    persistCutover: (cutover: DeploymentCutoverContext) => void,
    signal?: AbortSignal
): Promise<DeploymentCutoverContext | undefined> {
    let currentJob = job;
    const dashboardRoot = getDashboardRoot();
    const releasesRoot = resolveDashboardReleasesRoot();
    try {
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await syncMain(signal);
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await assertManagedDashboardServiceContract(signal);
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const currentState = await readDashboardReleaseState(releasesRoot);
        if (!currentState.current) {
            throw new Error("Managed deployment requires an active current release");
        }
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const { stdout: commitSha } = await runCommand("git", ["rev-parse", "HEAD"], {
            signal,
            timeoutMs: 30_000,
        });
        const expectedCommit = commitSha.trim();
        const isRedeploy = currentState.current.commitSha === expectedCommit;
        const rollbackRelease = isRedeploy ? currentState.previous : currentState.current;
        if (!rollbackRelease || rollbackRelease.commitSha === expectedCommit) {
            throw new Error(
                "Managed deployment requires a distinct verified rollback release"
            );
        }
        if (isRedeploy) {
            const ineligibilityReason = await rollbackIneligibilityReason(
                currentState.current,
                rollbackRelease,
                job.id
            );
            if (ineligibilityReason) {
                throw new Error(
                    `Automatic redeploy fallback is not eligible: ${ineligibilityReason}`
                );
            }
        }
        await ensureManagedRuntimeForRelease(rollbackRelease);

        const candidate = await stageDashboardRelease(expectedCommit, {
            commandRunner: async (command, arguments_, options) =>
                runCommand(command, [...arguments_], {
                    cwd: options.cwd,
                    environment: options.environment,
                    signal: options.signal,
                    timeoutMs: options.timeoutMs,
                }),
            onProgress: () => {
                currentJob = refreshDeploymentHeartbeat(currentJob);
            },
            releasesRoot,
            signal,
            sourceRoot: dashboardRoot,
            worktreeRoot: getDashboardWorktreeRoot(),
        });
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const releaseCutover = createDeploymentCutoverContext(
            expectedCommit,
            Bun.randomUUIDv7(),
            currentState.current.commitSha,
            rollbackRelease.commitSha,
            currentState.previous?.commitSha
        );
        persistCutover(releaseCutover);

        const cutoverJob: DeploymentJob = {
            ...currentJob,
            status: "verifying",
            updatedAt: dateToISOString(new Date()),
            commit: candidate.manifest.commitSha,
            commitTitle: candidate.manifest.commitTitle,
            note: `Release published. Pausing Dashboard writes, snapshotting SQLite, activating it, then verifying web, worker, deployed commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS} seconds of worker stability; code-and-data rollback is armed`,
        };
        writeDeploymentJob(cutoverJob);
        await scheduleReleaseCutover(cutoverJob, releaseCutover, signal);
        return releaseCutover;
    } catch (error) {
        const failed: DeploymentJob = {
            ...currentJob,
            status: "failed",
            updatedAt: dateToISOString(new Date()),
            note: errorMessage(error, "Deploy failed"),
        };
        try {
            writeDeploymentJob(failed);
        } finally {
            releaseDeploymentLock(job.id);
        }
        return undefined;
    }
}

/**
 * Validates and schedules a managed rollback after the API has returned its job.
 * @returns Validation result for and schedules a managed rollback after the API has returned its job.
 */
async function runRollbackJob(
    job: DeploymentJob,
    signal?: AbortSignal
): Promise<boolean> {
    let currentJob = job;
    const releasesRoot = resolveDashboardReleasesRoot();
    try {
        currentJob = refreshDeploymentHeartbeat(currentJob);
        await assertManagedDashboardServiceContract(signal);
        currentJob = refreshDeploymentHeartbeat(currentJob);
        const state = await readDashboardReleaseState(releasesRoot);
        if (!state.current || !state.previous) {
            throw new Error(
                "Managed release rollback requires active current and previous releases"
            );
        }
        if (!job.commit || state.previous.commitSha !== job.commit) {
            throw new Error(
                "Rollback target changed before execution. Refresh release status and try again"
            );
        }
        if (state.current.commitSha === state.previous.commitSha) {
            throw new Error("Managed release rollback requires two distinct releases");
        }
        const ineligibilityReason = await rollbackIneligibilityReason(
            state.current,
            state.previous,
            job.id
        );
        if (ineligibilityReason) {
            throw new Error(
                `Previous release is not eligible for rollback: ${ineligibilityReason}`
            );
        }
        assertDashboardReleaseRuntimeAvailable(state.previous);

        const cutoverJob: DeploymentJob = {
            ...currentJob,
            status: "verifying",
            updatedAt: dateToISOString(new Date()),
            commit: state.previous.commitSha,
            commitTitle: state.previous.manifest.commitTitle,
            note: `Rollback target verified. Activating it, restarting services, then verifying web, worker, deployed commit, and ${DEPLOYMENT_WORKER_STABILITY_SECONDS} seconds of worker stability; automatic restoration is armed`,
        };
        writeDeploymentJob(cutoverJob);
        await scheduleReleaseRollback(
            cutoverJob,
            state.previous.commitSha,
            state.current.commitSha,
            signal
        );
        return true;
    } catch (error) {
        const failed: DeploymentJob = {
            ...currentJob,
            status: "failed",
            updatedAt: dateToISOString(new Date()),
            note: errorMessage(error, "Rollback failed"),
        };
        try {
            writeDeploymentJob(failed);
        } finally {
            releaseDeploymentLock(job.id);
        }
        return false;
    }
}

function resumeWorkerClaimsWhenDeploymentRestartSettles(
    deploymentId: string,
    resumeWorkerClaims: () => void
): void {
    let isSettled = false;
    const settle = () => {
        if (isSettled) return;
        isSettled = true;
        clearInterval(restartPoll);
        clearTimeout(failSafe);
        resumeWorkerClaims();
    };
    const checkRestartStatus = () => {
        try {
            const deployment = readDeploymentJob(deploymentId);
            if (!deployment || !ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status)) {
                settle();
            }
        } catch (error) {
            logger.warn("deployment.restart_inspection_failed", {
                deploymentId,
                error,
            });
        }
    };
    const restartPoll = setInterval(
        checkRestartStatus,
        DEPLOYMENT_RESTART_STATUS_POLL_MS
    );
    restartPoll.unref();
    const failSafe = setTimeout(() => {
        logger.warn("deployment.worker_claim_pause_timed_out", { deploymentId });
        settle();
    }, DEPLOYMENT_RESTART_CLAIM_PAUSE_TIMEOUT_MS);
    failSafe.unref();
    queueMicrotask(checkRestartStatus);
}

/**
 * Persists a deployment and puts its execution behind the worker lease.
 * @param lockHeldBy Lock held by value.
 * @returns Start deploy latest result.
 */
export function startDeployLatest(lockHeldBy?: string): DeploymentJob {
    registerPullRequestJobLifecycleHandlers();
    const now = dateToISOString(new Date());
    const job: DeploymentJob = {
        id: Bun.randomUUIDv7(),
        status: "building",
        startedAt: now,
        updatedAt: now,
        note: "Deploy started",
    };
    if (lockHeldBy) {
        const result = database
            .prepare(
                "UPDATE deployment_lock SET job_id = ?, updated_at = ? WHERE id = 1 AND job_id = ?"
            )
            .run(job.id, now, lockHeldBy);
        if (result.changes !== 1) {
            throw new Error("Dashboard deploy lock handoff failed");
        }
    } else {
        acquireDeploymentLock(job.id);
    }
    try {
        writeDeploymentJob(job);
        enqueueJobExecution({
            actionKey: "dashboard.deploy",
            displayName: "Deploy Mira Dashboard",
            payload: { deploymentId: job.id },
            resourceClass: "exclusive",
            timeoutMs: 45 * 60 * 1000,
        });
        return job;
    } catch (error) {
        releaseDeploymentLock(job.id);
        if (lockHeldBy) {
            releaseDeploymentLock(lockHeldBy);
        }
        writeDeploymentJob({
            ...job,
            note: errorMessage(error, "Dashboard deploy failed to queue"),
            status: "failed",
            updatedAt: dateToISOString(new Date()),
        });
        throw error;
    }
}

/**
 * Queues a direct deploy; production validation is owned by the worker action.
 * @returns Prepare and start deploy latest result.
 */
export function prepareAndStartDeployLatest(): DeploymentJob {
    return startDeployLatest();
}

/**
 * Validates the confirmed target against current release slots and queues rollback.
 * @param expectedTargetCommit Expected target commit value.
 * @returns Validation result for the confirmed target against current release slots and queues rollback.
 */
export async function prepareAndStartRollback(
    expectedTargetCommit: string
): Promise<DeploymentJob> {
    if (!FULL_COMMIT_SHA_PATTERN.test(expectedTargetCommit)) {
        throw Object.assign(
            new TypeError("Rollback target must be a full lowercase commit SHA"),
            { statusCode: 400 }
        );
    }
    registerPullRequestJobLifecycleHandlers();
    const now = dateToISOString(new Date());
    const deploymentId = Bun.randomUUIDv7();
    let job: DeploymentJob | undefined;
    acquireDeploymentLock(deploymentId);
    try {
        const state = await readDashboardReleaseState(resolveDashboardReleasesRoot());
        if (!state.current || !state.previous) {
            throw Object.assign(
                new Error(
                    "Managed release rollback requires active current and previous releases"
                ),
                { statusCode: 409 }
            );
        }
        if (state.current.commitSha === state.previous.commitSha) {
            throw Object.assign(
                new Error("Managed release rollback requires two distinct releases"),
                { statusCode: 409 }
            );
        }
        if (state.previous.commitSha !== expectedTargetCommit) {
            throw Object.assign(
                new Error(
                    "Rollback target changed. Refresh release status and confirm the current previous release"
                ),
                { statusCode: 409 }
            );
        }
        const ineligibilityReason = await rollbackIneligibilityReason(
            state.current,
            state.previous
        );
        if (ineligibilityReason) {
            throw Object.assign(
                new Error(
                    `Previous release is not eligible for rollback: ${ineligibilityReason}`
                ),
                { statusCode: 409 }
            );
        }
        assertDashboardReleaseRuntimeAvailable(state.previous);

        job = {
            id: deploymentId,
            status: "building",
            startedAt: now,
            updatedAt: now,
            commit: state.previous.commitSha,
            commitTitle: state.previous.manifest.commitTitle,
            note: `Rollback to ${state.previous.commitSha.slice(0, 8)} queued`,
        };
        writeDeploymentJob(job);
        enqueueJobExecution({
            actionKey: "dashboard.rollback",
            displayName: `Roll back Mira Dashboard to ${state.previous.commitSha.slice(0, 8)}`,
            payload: { deploymentId: job.id },
            resourceClass: "exclusive",
            timeoutMs: 15 * 60 * 1000,
        });
        return job;
    } catch (error) {
        releaseDeploymentLock(deploymentId);
        if (job) {
            try {
                writeDeploymentJob({
                    ...job,
                    note: errorMessage(error, "Dashboard rollback failed to queue"),
                    status: "failed",
                    updatedAt: dateToISOString(new Date()),
                });
            } catch {
                // Preserve the original rollback validation or queue error.
            }
        }
        throw error;
    }
}

/** Registers managed deploy, rollback, and interrupted-cutover worker actions. */
export function registerDeploymentExecutionActions(): void {
    registerPullRequestJobLifecycleHandlers();
    registerDeploymentCutoverRecoveryHandler(didScheduleOrphanedReleaseCutoverRecovery);
    registerScheduledJobAction("dashboard.deploy", async (job, signal, context) => {
        const deploymentId = job.actionPayload.deploymentId;
        if (typeof deploymentId !== "string" || deploymentId.trim() === "") {
            throw Object.assign(new Error("Deployment id is missing"), {
                statusCode: 400,
            });
        }
        const deployment = readDeploymentJob(deploymentId);
        if (!deployment) {
            throw Object.assign(new Error("Deployment job not found"), {
                statusCode: 404,
            });
        }
        context.protectFromCancellation();
        const releaseCutover = await runDeploymentJob(
            deployment,
            (nextCutover) => {
                context.updateOutput({
                    deploymentId,
                    releaseCutover: nextCutover,
                });
            },
            signal
        );
        if (!releaseCutover) {
            throw new ScheduledJobActionError("Dashboard deploy failed", {
                deploymentId,
            });
        }
        const resumeWorkerClaims = context.pauseWorkerClaims();
        resumeWorkerClaimsWhenDeploymentRestartSettles(deploymentId, resumeWorkerClaims);
        return { deploymentId, releaseCutover };
    });
    registerScheduledJobAction("dashboard.rollback", async (job, signal, context) => {
        const deploymentId = job.actionPayload.deploymentId;
        if (typeof deploymentId !== "string" || deploymentId.trim() === "") {
            throw Object.assign(new Error("Deployment id is missing"), {
                statusCode: 400,
            });
        }
        const deployment = readDeploymentJob(deploymentId);
        if (!deployment) {
            throw Object.assign(new Error("Deployment job not found"), {
                statusCode: 404,
            });
        }
        context.protectFromCancellation();
        const isSuccess = await runRollbackJob(deployment, signal);
        if (!isSuccess) {
            throw new ScheduledJobActionError("Dashboard rollback failed", {
                deploymentId,
            });
        }
        const resumeWorkerClaims = context.pauseWorkerClaims();
        resumeWorkerClaimsWhenDeploymentRestartSettles(deploymentId, resumeWorkerClaims);
        return { deploymentId };
    });
}
