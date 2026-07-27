import {
    enqueueJobExecution,
    type JobExecution,
    listJobExecutions,
} from "./jobExecutionQueue.ts";
import {
    getPullRequestPreviewStatus as readPullRequestPreviewStatus,
    type PullRequestPreviewCandidate,
    type PullRequestPreviewLifecycle,
    type PullRequestPreviewStatus,
    startPullRequestPreview,
    stopPullRequestPreview,
} from "./pullRequestPreviewHost.ts";
import {
    listDashboardPullRequests,
    type PullRequestSummary,
    validatePrNumber,
} from "./pullRequests.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";
import { registerScheduledJobAction } from "./scheduledJobs.ts";

export type {
    PullRequestPreviewLifecycle,
    PullRequestPreviewStatus,
} from "./pullRequestPreviewHost.ts";

const PREVIEW_START_TIMEOUT_MS = 30 * 60 * 1000;
const PREVIEW_STOP_TIMEOUT_MS = 6 * 60 * 1000;
const PREVIEW_WAIT_GRACE_MS = 5 * 60 * 1000;
const COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const PREVIEW_LIFECYCLES = new Set<PullRequestPreviewLifecycle>([
    "failed",
    "running",
    "starting",
    "stopped",
    "stopping",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function executionPreviewNumber(value: unknown): number {
    return validatePrNumber(String(value));
}

function executionPreviewCommitSha(value: unknown): string {
    if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
        throw new TypeError("Preview execution requires a full commit SHA");
    }
    return value;
}

/** Converts a GitHub PR summary into the constrained host-preview contract. */
export function pullRequestPreviewCandidate(
    pullRequest: PullRequestSummary
): PullRequestPreviewCandidate {
    return {
        authorLogin: pullRequest.author?.login,
        baseRefName: pullRequest.baseRefName,
        commitSha: pullRequest.headRefOid || "",
        number: pullRequest.number,
        title: pullRequest.title,
    };
}

async function findPullRequest(number: number): Promise<PullRequestPreviewCandidate> {
    const pullRequests = await listDashboardPullRequests();
    const pullRequest = pullRequests.find((candidate) => candidate.number === number);
    if (!pullRequest) {
        throw Object.assign(new Error(`Open pull request #${number} was not found`), {
            statusCode: 404,
        });
    }
    return pullRequestPreviewCandidate(pullRequest);
}

/** Validates preview output before it crosses the queued-execution boundary. */
export function parsePullRequestPreviewStatus(value: unknown): PullRequestPreviewStatus {
    if (!isRecord(value) || !PREVIEW_LIFECYCLES.has(value.status as never)) {
        throw new Error("Preview execution returned an invalid status");
    }
    const status = value.status as PullRequestPreviewLifecycle;
    const number = value.number;
    if (number !== undefined && (!Number.isSafeInteger(number) || Number(number) <= 0)) {
        throw new Error("Preview execution returned an invalid PR number");
    }
    for (const key of [
        "commitSha",
        "message",
        "startedAt",
        "title",
        "updatedAt",
        "url",
    ]) {
        if (value[key] !== undefined && typeof value[key] !== "string") {
            throw new Error(`Preview execution returned an invalid ${key}`);
        }
    }
    return {
        ...(typeof value.backendPort === "number" && {
            backendPort: value.backendPort,
        }),
        ...(typeof value.commitSha === "string" && {
            commitSha: value.commitSha,
        }),
        ...(typeof value.frontendPort === "number" && {
            frontendPort: value.frontendPort,
        }),
        ...(typeof value.message === "string" && { message: value.message }),
        ...(typeof number === "number" && { number }),
        ...(typeof value.startedAt === "string" && {
            startedAt: value.startedAt,
        }),
        status,
        ...(typeof value.title === "string" && { title: value.title }),
        ...(typeof value.updatedAt === "string" && {
            updatedAt: value.updatedAt,
        }),
        ...(typeof value.url === "string" && { url: value.url }),
    };
}

function previewFromExecution(execution: JobExecution): PullRequestPreviewStatus {
    const output = successfulJobExecutionOutput(execution);
    return parsePullRequestPreviewStatus(output.preview);
}

/** Reads the current preview state, including queued lifecycle transitions. */
export async function getPullRequestPreviewStatus(): Promise<PullRequestPreviewStatus> {
    const preview = await readPullRequestPreviewStatus();
    const activeExecution = listJobExecutions(200).find(
        (execution) =>
            ["queued", "running"].includes(execution.status) &&
            ["dashboard.preview.start", "dashboard.preview.stop"].includes(
                execution.actionKey
            )
    );
    if (!activeExecution) return preview;

    const value = activeExecution.payload.number;
    const number = value === undefined ? preview.number : executionPreviewNumber(value);
    const executionCommit =
        activeExecution.actionKey === "dashboard.preview.start" &&
        activeExecution.payload.commitSha !== undefined
            ? executionPreviewCommitSha(activeExecution.payload.commitSha)
            : undefined;
    const isSamePreview = number !== undefined && preview.number === number;
    return {
        ...(isSamePreview && preview),
        ...(executionCommit && { commitSha: executionCommit }),
        ...(number !== undefined && { number }),
        status:
            activeExecution.actionKey === "dashboard.preview.start"
                ? "starting"
                : "stopping",
        updatedAt: activeExecution.startedAt || activeExecution.queuedAt,
    };
}

/** Queues one managed preview startup in the dedicated production worker. */
export async function prepareAndStartPullRequestPreview(
    number: number
): Promise<PullRequestPreviewStatus> {
    const candidate = await findPullRequest(number);
    const current = await getPullRequestPreviewStatus();
    if (
        ["running", "starting", "stopping"].includes(current.status) &&
        current.number !== number
    ) {
        throw Object.assign(
            new Error(
                `PR #${current.number} already owns the preview slot; stop it first`
            ),
            { statusCode: 409 }
        );
    }
    if (
        current.status === "running" &&
        current.number === number &&
        current.commitSha === candidate.commitSha
    ) {
        return current;
    }
    if (["starting", "stopping"].includes(current.status)) {
        throw Object.assign(new Error("PR preview is already changing state"), {
            statusCode: 409,
        });
    }
    const execution = enqueueJobExecution({
        actionKey: "dashboard.preview.start",
        displayName: `Start PR #${number} preview`,
        payload: {
            commitSha: executionPreviewCommitSha(candidate.commitSha),
            number,
        },
        resourceClass: "exclusive",
        timeoutMs: PREVIEW_START_TIMEOUT_MS,
    });
    return {
        commitSha: candidate.commitSha,
        number,
        status: "starting",
        title: candidate.title,
        updatedAt: execution.queuedAt,
    };
}

/** Queues a managed preview stop in the dedicated production worker. */
export async function prepareAndStopPullRequestPreview(
    number?: number
): Promise<PullRequestPreviewStatus> {
    const execution = enqueueJobExecution({
        actionKey: "dashboard.preview.stop",
        displayName: number ? `Stop PR #${number} preview` : "Stop PR preview",
        payload: { number },
        resourceClass: "exclusive",
        timeoutMs: PREVIEW_STOP_TIMEOUT_MS,
    });
    return previewFromExecution(
        await waitForJobExecution(execution.id, {
            timeoutMs: PREVIEW_STOP_TIMEOUT_MS + PREVIEW_WAIT_GRACE_MS,
        })
    );
}

/** Registers host preview start/stop actions only in the full production worker. */
export function registerPullRequestPreviewExecutionActions(): void {
    registerScheduledJobAction(
        "dashboard.preview.start",
        async (job, signal, context) => {
            const number = executionPreviewNumber(job.actionPayload.number);
            const expectedCommit = executionPreviewCommitSha(job.actionPayload.commitSha);
            const candidate = await findPullRequest(number);
            if (candidate.commitSha !== expectedCommit) {
                throw Object.assign(
                    new Error(
                        `PR #${number} changed after its dev start was queued. Review the new head and start it again`
                    ),
                    { statusCode: 409 }
                );
            }
            return {
                preview: await startPullRequestPreview(candidate, {
                    protectFromCancellation: () => context.protectFromCancellation(),
                    signal,
                }),
            };
        }
    );
    registerScheduledJobAction(
        "dashboard.preview.stop",
        async (job, _signal, context) => {
            const value = job.actionPayload.number;
            return {
                preview: await stopPullRequestPreview(
                    value === undefined ? undefined : executionPreviewNumber(value),
                    {
                        protectFromCancellation: () => context.protectFromCancellation(),
                    }
                ),
            };
        }
    );
}
