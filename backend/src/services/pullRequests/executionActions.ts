import type { PullRequestExpectedHead } from "../../../../contracts/delivery/pullRequests.ts";
import type { ScheduledJob } from "../../../../contracts/jobs/scheduled.ts";
import {
    enqueueJobExecution,
    type JobExecutionRecord,
} from "../jobExecutionQueue/repository.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "../queuedJobExecution.ts";
import {
    registerScheduledJobAction,
    type ScheduledJobActionContext,
    ScheduledJobActionError,
} from "../scheduledJobs/actionRegistry.ts";
import {
    approvePullRequestReview,
    rejectPullRequest,
    updatePullRequestBranch,
} from "./actionService.ts";
import {
    acquireDeploymentLock,
    registerPullRequestJobLifecycleHandlers,
    releaseDeploymentLock,
} from "./deploymentLock.ts";
import { registerDeploymentExecutionActions } from "./deploymentService.ts";
import { validatePrNumber } from "./githubPullRequestListing.ts";
import {
    createPullRequestStack,
    STACK_MERGE_JOB_TIMEOUT_MS,
} from "./githubStackClient.ts";
import { approvePullRequest, requireExpectedStackHeads } from "./mergeService.ts";
import { FULL_COMMIT_SHA_PATTERN } from "./support.ts";

function queuedPullRequestResult<T>(execution: JobExecutionRecord): T {
    if ("result" in execution.output) return execution.output.result as T;
    successfulJobExecutionOutput(execution);
    throw new Error("Pull request result was missing");
}

/**
 * Creates a native GitHub stack through the persistent execution plane.
 * @param pullRequests Pull request numbers ordered from bottom to top.
 * @returns Promise resolving to the stack creation result.
 */
export async function runPullRequestStackCreation(pullRequests: number[]) {
    const execution = enqueueJobExecution({
        actionKey: "github.stack-create",
        displayName: `Create GitHub stack from ${pullRequests.length} PRs`,
        payload: { pullRequests },
        resourceClass: "exclusive",
        timeoutMs: 5 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof createPullRequestStack>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/**
 * Runs PR merge/deploy through the shared persistent execution plane.
 * @param number Number value.
 * @param willDeploy Whether will deploy.
 * @param options Exact-head and native stack merge options.
 * @returns Promise resolving to the run pull request approval result.
 */
export async function runPullRequestApproval(
    number: number,
    willDeploy: boolean,
    options: {
        expectedHeadSha: string;
        expectedStackHeads?: PullRequestExpectedHead[];
        mergeStack?: boolean;
    }
) {
    registerPullRequestJobLifecycleHandlers();
    const expectedStackHeads = requireExpectedStackHeads(
        options.expectedStackHeads,
        options.mergeStack === true
    );
    const deploymentLockId = `approve-${Bun.randomUUIDv7()}`;
    acquireDeploymentLock(deploymentLockId);
    let timeoutMs = 10 * 60 * 1000;
    if (options.mergeStack) timeoutMs = STACK_MERGE_JOB_TIMEOUT_MS;
    if (willDeploy) timeoutMs = 45 * 60 * 1000;
    let execution: JobExecutionRecord;
    try {
        execution = enqueueJobExecution({
            actionKey: willDeploy ? "github.merge-deploy" : "github.merge",
            displayName: willDeploy
                ? `Merge and deploy ${options.mergeStack ? "stack through " : ""}PR #${number}`
                : `Merge ${options.mergeStack ? "stack through " : ""}PR #${number}`,
            payload: {
                deploymentLockId,
                expectedHeadSha: options.expectedHeadSha,
                expectedStackHeads,
                mergeStack: options.mergeStack === true,
                number,
                willDeploy,
            },
            resourceClass: "exclusive",
            timeoutMs,
        });
    } catch (error) {
        releaseDeploymentLock(deploymentLockId);
        throw error;
    }
    return queuedPullRequestResult<Awaited<ReturnType<typeof approvePullRequest>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 60 * 60 * 1000 })
    );
}
/**
 * Records a GitHub review approval in the shared execution plane.
 * @param number Number value.
 * @returns Promise resolving to the run pull request review approval result.
 */
export async function runPullRequestReviewApproval(number: number) {
    const execution = enqueueJobExecution({
        actionKey: "github.review-approval",
        displayName: `Approve review for PR #${number}`,
        payload: { number },
        resourceClass: "network",
        timeoutMs: 2 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof approvePullRequestReview>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/**
 * Records a GitHub branch update in the shared execution plane.
 * @param number Number value.
 * @returns Promise resolving to the run pull request branch update result.
 */
export async function runPullRequestBranchUpdate(number: number) {
    const execution = enqueueJobExecution({
        actionKey: "github.update-branch",
        displayName: `Update branch for PR #${number}`,
        payload: { number },
        resourceClass: "network",
        timeoutMs: 2 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof updatePullRequestBranch>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

/**
 * Records a PR close and local worktree cleanup in the execution plane.
 * @param number Number value.
 * @param comment Comment value.
 * @returns Promise resolving to the run pull request rejection result.
 */
export async function runPullRequestRejection(number: number, comment: string) {
    const execution = enqueueJobExecution({
        actionKey: "github.reject",
        displayName: `Reject PR #${number}`,
        payload: { comment, number },
        resourceClass: "exclusive",
        timeoutMs: 5 * 60 * 1000,
    });
    return queuedPullRequestResult<Awaited<ReturnType<typeof rejectPullRequest>>>(
        await waitForJobExecution(execution.id, { timeoutMs: 15 * 60 * 1000 })
    );
}

function executionPullRequestNumber(payload: Record<string, unknown>): number {
    const number = payload.number;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) {
        return number;
    }
    return validatePrNumber(number);
}

function executionPullRequestStackNumbers(payload: Record<string, unknown>): number[] {
    const pullRequests = payload.pullRequests;
    if (
        !Array.isArray(pullRequests) ||
        pullRequests.length < 2 ||
        pullRequests.length > 100
    ) {
        throw Object.assign(new Error("Pull request stack payload is invalid"), {
            statusCode: 400,
        });
    }
    const numbers: number[] = [];
    for (const value of pullRequests) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
            throw Object.assign(new Error("Pull request stack payload is invalid"), {
                statusCode: 400,
            });
        }
        numbers.push(value);
    }
    return numbers;
}

async function executePullRequestMerge(
    job: ScheduledJob,
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
) {
    context.protectFromCancellation();
    const number = executionPullRequestNumber(job.actionPayload);
    const willDeploy = job.actionPayload.willDeploy === true;
    const mergeStack = job.actionPayload.mergeStack === true;
    const expectedHeadSha = job.actionPayload.expectedHeadSha;
    const expectedStackHeads = requireExpectedStackHeads(
        job.actionPayload.expectedStackHeads,
        mergeStack
    );
    if (
        typeof expectedHeadSha !== "string" ||
        !FULL_COMMIT_SHA_PATTERN.test(expectedHeadSha)
    ) {
        throw Object.assign(new Error("Expected pull request head SHA is invalid"), {
            statusCode: 400,
        });
    }
    const deploymentLockId = job.actionPayload.deploymentLockId;
    if (
        deploymentLockId !== undefined &&
        (typeof deploymentLockId !== "string" || deploymentLockId.trim() === "")
    ) {
        throw Object.assign(new Error("Deployment lock id is invalid"), {
            statusCode: 400,
        });
    }
    const result = await approvePullRequest(number, willDeploy, {
        expectedHeadSha,
        expectedStackHeads,
        lockHeldBy: deploymentLockId,
        mergeStack,
        signal,
    });
    const message = result.syncError || result.deployError;
    if (message) {
        throw new ScheduledJobActionError(message, { result });
    }
    return { result };
}

/** Registers every mutating GitHub/release action exclusively in the worker. */
export function registerPullRequestExecutionActions(): void {
    registerDeploymentExecutionActions();
    registerScheduledJobAction("github.merge", executePullRequestMerge);
    registerScheduledJobAction("github.merge-deploy", executePullRequestMerge);
    registerScheduledJobAction("github.stack-create", async (job, signal, context) => {
        const pullRequests = executionPullRequestStackNumbers(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await createPullRequestStack(pullRequests, signal),
        };
    });
    registerScheduledJobAction("github.review-approval", async (job, signal, context) => {
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await approvePullRequestReview(number, signal),
        };
    });
    registerScheduledJobAction("github.update-branch", async (job, signal, context) => {
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await updatePullRequestBranch(number, signal),
        };
    });
    registerScheduledJobAction("github.reject", async (job, signal, context) => {
        const comment = job.actionPayload.comment;
        if (typeof comment !== "string" || comment.trim() === "") {
            throw Object.assign(new Error("Pull request rejection comment is missing"), {
                statusCode: 400,
            });
        }
        const number = executionPullRequestNumber(job.actionPayload);
        context.protectFromCancellation();
        return {
            result: await rejectPullRequest(number, comment, signal),
        };
    });
}
