import type {
    PullRequestPreviewLifecycle,
    PullRequestPreviewStatus,
    PullRequestSummary,
} from "../../../contracts/delivery.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    enqueueJobExecution,
    type JobExecutionRecord,
    listJobExecutions,
} from "./jobExecutionQueue.ts";
import {
    cleanupClosedPullRequestPreview,
    getPullRequestPreviewStatus as readPullRequestPreviewStatus,
    listManagedPullRequestPreviewStateNumbers,
    type PullRequestPreviewCandidate,
    startPullRequestPreview,
    stopPullRequestPreview,
} from "./pullRequestPreviewHost.ts";
import {
    isDashboardPullRequestOpen,
    listDashboardPullRequests,
    validatePrNumber,
} from "./pullRequests.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";
import { registerScheduledJobAction } from "./scheduledJobs.ts";

const logger = createStructuredLogger("pull-request-previews");

const PREVIEW_START_TIMEOUT_MS = 30 * 60 * 1000;
const PREVIEW_STOP_TIMEOUT_MS = 6 * 60 * 1000;
const PREVIEW_WAIT_GRACE_MS = 5 * 60 * 1000;
const PREVIEW_ACTION_KEYS = new Set([
    "dashboard.preview.cleanup",
    "dashboard.preview.start",
    "dashboard.preview.stop",
]);
const PREVIEW_CONTROLS_UNAVAILABLE_MESSAGE =
    "PR dev controls are available only from the production Dashboard.";
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

/**
 * Converts a GitHub PR summary into the constrained host-preview contract.
 * @returns Converted a GitHub PR summary into the constrained host-preview contract.
 */
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

/**
 * Validates preview output before it crosses the queued-execution boundary.
 * @param value Value to process.
 * @returns Validation result for preview output before it crosses the queued-execution boundary.
 */
export function parsePullRequestPreviewStatus(value: unknown): PullRequestPreviewStatus {
    if (!isRecord(value) || !PREVIEW_LIFECYCLES.has(value.status as never)) {
        throw new Error("Preview execution returned an invalid status");
    }
    if (
        value.controlsAvailable !== undefined &&
        typeof value.controlsAvailable !== "boolean"
    ) {
        throw new Error("Preview execution returned invalid control availability");
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
        ...(typeof value.controlsAvailable === "boolean" && {
            controlsAvailable: value.controlsAvailable,
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

function previewFromExecution(execution: JobExecutionRecord): PullRequestPreviewStatus {
    const output = successfulJobExecutionOutput(execution);
    return parsePullRequestPreviewStatus(output.preview);
}

function unavailablePreviewControls(): PullRequestPreviewStatus | undefined {
    if (
        process.env.NODE_ENV === "production" ||
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE !== "1"
    ) {
        return;
    }
    return {
        controlsAvailable: false,
        message: PREVIEW_CONTROLS_UNAVAILABLE_MESSAGE,
        status: "stopped",
    };
}

/**
 * Reads the current preview state, including queued lifecycle transitions.
 * @returns Read the current preview state, including queued lifecycle transitions.
 */
export async function getPullRequestPreviewStatus(): Promise<PullRequestPreviewStatus> {
    const unavailable = unavailablePreviewControls();
    if (unavailable) return unavailable;
    const preview = await readPullRequestPreviewStatus();
    const activeExecution = listJobExecutions(200).find(
        (execution) =>
            ["queued", "running"].includes(execution.status) &&
            PREVIEW_ACTION_KEYS.has(execution.actionKey)
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

/**
 * Queues cleanup when a successful production-base listing omits retained
 * preview data and an unfiltered GitHub lookup confirms that the PR is closed.
 * @param openPullRequests Open pull requests value.
 */
export async function reconcileClosedPullRequestPreview(
    openPullRequests: readonly PullRequestSummary[]
): Promise<void> {
    if (
        process.env.NODE_ENV !== "production" &&
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE === "1"
    ) {
        return;
    }
    try {
        if (
            listJobExecutions(200).some(
                (execution) =>
                    ["queued", "running"].includes(execution.status) &&
                    PREVIEW_ACTION_KEYS.has(execution.actionKey)
            )
        ) {
            return;
        }
        const preview = await readPullRequestPreviewStatus();
        const openPullRequestNumbers = new Set(
            openPullRequests.map((pullRequest) => pullRequest.number)
        );
        const cleanupCandidates = [
            ...(preview.number !== undefined &&
            !openPullRequestNumbers.has(preview.number)
                ? [preview.number]
                : []),
            ...listManagedPullRequestPreviewStateNumbers().filter(
                (number) => !openPullRequestNumbers.has(number)
            ),
        ];
        const uniqueCleanupCandidates = new Set(cleanupCandidates);
        for (const number of uniqueCleanupCandidates) {
            if (await isDashboardPullRequestOpen(number)) continue;
            enqueueJobExecution({
                actionKey: "dashboard.preview.cleanup",
                displayName: `Clean up closed PR #${number} preview`,
                payload: { number },
                resourceClass: "exclusive",
                timeoutMs: PREVIEW_STOP_TIMEOUT_MS,
            });
            return;
        }
    } catch (error) {
        logger.error("preview.closed_pr_reconciliation_failed", { error });
    }
}

/**
 * Queues one managed preview startup in the dedicated production worker.
 * @param number Number value.
 * @returns Promise resolving to the prepare and start pull request preview result.
 */
export async function prepareAndStartPullRequestPreview(
    number: number
): Promise<PullRequestPreviewStatus> {
    const unavailable = unavailablePreviewControls();
    if (unavailable) return unavailable;
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

/**
 * Queues a managed preview stop in the dedicated production worker.
 * @param number Number value.
 * @returns Promise resolving to the prepare and stop pull request preview result.
 */
export async function prepareAndStopPullRequestPreview(
    number?: number
): Promise<PullRequestPreviewStatus> {
    const unavailable = unavailablePreviewControls();
    if (unavailable) return unavailable;
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

/** Registers host preview lifecycle actions only in the full production worker. */
export function registerPullRequestPreviewExecutionActions(): void {
    registerScheduledJobAction(
        "dashboard.preview.cleanup",
        async (job, _signal, context) => {
            const number = executionPreviewNumber(job.actionPayload.number);
            if (await isDashboardPullRequestOpen(number)) {
                return {
                    cleanup: {
                        message: `PR #${number} is still open; managed PR dev data was kept`,
                        number,
                        status: "skipped",
                    },
                    preview: await readPullRequestPreviewStatus(),
                };
            }
            context.protectFromCancellation();
            return {
                cleanup: await cleanupClosedPullRequestPreview(number),
                preview: await readPullRequestPreviewStatus(),
            };
        }
    );
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
