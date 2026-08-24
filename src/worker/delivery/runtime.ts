import { Data } from "effect";
import * as v from "valibot";

import {
    deliveryOperationAuthoritySnapshotSchema,
    type DeliveryExpectedHead,
    type DeliveryOperationAuthoritySnapshot,
    type DeliveryOverviewSectionId,
} from "../../contracts/delivery.ts";
import {
    type DeliveryDashboardMainGitSyncPort,
    type DeliveryGitHubMutationOutcome,
    type DeliveryGitHubPullRequestMutationPort,
    type DeliveryGitHubPullRequestReadPort,
    type DeliveryGitHubReviewApprovalPort,
} from "../../contracts/deliveryGithub.ts";
import {
    type DeliveryJobExecutionPort,
    type DeliveryJobOperationResult,
    type DeliveryOperationJobPayload,
    type DeliveryOperationWarningCode,
    type DeliveryOverviewPreviousSections,
} from "../../contracts/deliveryWorker.ts";
import type { JobExecutionRunIdentity } from "../../contracts/jobModel.ts";
import { canonicalDeliveryOperationWarnings } from "../../shared/deliveryOperationWarnings.ts";
import { DeliveryGitHubError } from "./githubHttpTransport.ts";
import type { DeliveryOverviewCollector } from "./overviewCollector.ts";
import type { PreviewHostStatus } from "./previewHost.ts";

export interface DeliveryPreviewExecutionPort {
    readonly cleanupConfirmed?: (
        input: unknown,
        signal?: AbortSignal
    ) => Promise<boolean>;
    readonly reconcile?: (signal?: AbortSignal) => Promise<PreviewHostStatus>;
    readonly start: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
    readonly status: (signal?: AbortSignal) => Promise<PreviewHostStatus>;
    readonly stop: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
}

export interface DeliveryProductionExecutionPort {
    readonly execute: (
        payload: Extract<
            DeliveryOperationJobPayload,
            { operation: "deploy" } | { operation: "rollback-release" }
        >,
        current: DeliveryOperationAuthoritySnapshot,
        runIdentity: JobExecutionRunIdentity,
        signal?: AbortSignal
    ) => Promise<DeliveryJobOperationResult>;
}

export interface DeliveryRuntimeOptions {
    readonly collector: DeliveryOverviewCollector;
    readonly github: DeliveryGitHubPullRequestReadPort &
        DeliveryGitHubPullRequestMutationPort;
    readonly mainGit: DeliveryDashboardMainGitSyncPort;
    readonly newOperationId?: () => string;
    readonly preview: DeliveryPreviewExecutionPort;
    readonly production?: DeliveryProductionExecutionPort;
    readonly readPrevious: (section: DeliveryOverviewSectionId) => unknown;
    readonly reviewer?: DeliveryGitHubReviewApprovalPort;
}

export class DeliveryRuntimeError extends Data.TaggedError("DeliveryRuntimeError")<{
    readonly reason:
        | "conflict"
        | "production-unavailable"
        | "reviewer-unavailable"
        | "source-unavailable";
}> {}

function fail(reason: DeliveryRuntimeError["reason"]): never {
    throw new DeliveryRuntimeError({ reason });
}

function sameScope(
    left: readonly DeliveryExpectedHead[],
    right: readonly DeliveryExpectedHead[]
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (member, index) =>
                member.number === right[index]?.number &&
                member.headSha === right[index]?.headSha
        )
    );
}

function pullRequestActionId(
    payload: DeliveryOperationJobPayload
):
    | "approve-review"
    | "create-stack"
    | "merge"
    | "preview-start"
    | "reject"
    | "update-branch"
    | undefined {
    switch (payload.operation) {
        case "approve-review": {
            return "approve-review";
        }
        case "create-pull-request-stack": {
            return "create-stack";
        }
        case "merge-pull-request": {
            return "merge";
        }
        case "reject-pull-request": {
            return "reject";
        }
        case "start-preview": {
            return "preview-start";
        }
        case "update-branch": {
            return "update-branch";
        }
        default: {
            return undefined;
        }
    }
}

function operationScope(
    payload: DeliveryOperationJobPayload
): readonly DeliveryExpectedHead[] | undefined {
    if (
        payload.operation === "approve-review" ||
        payload.operation === "reject-pull-request" ||
        payload.operation === "update-branch"
    ) {
        return Object.freeze([
            { headSha: payload.expectedHeadSha, number: payload.number },
        ]);
    }
    return payload.operation === "create-pull-request-stack" ||
        payload.operation === "merge-pull-request" ||
        payload.operation === "start-preview"
        ? payload.expectedHeads
        : undefined;
}

function authoritativeActionScope(
    current: DeliveryOperationAuthoritySnapshot,
    selected: number,
    actionId: NonNullable<ReturnType<typeof pullRequestActionId>>
): readonly DeliveryExpectedHead[] | undefined {
    for (const group of current.pullRequestGroups) {
        const index = group.members.findIndex(({ number }) => number === selected);
        if (index === -1) continue;
        const pullRequest = group.members[index]!;
        const action = pullRequest.actions.find(({ action }) => action === actionId);
        if (action === undefined || !action.available) return undefined;
        let members: typeof group.members = [pullRequest];
        if (action.scope === "group") members = group.members;
        if (action.scope === "prefix") members = group.members.slice(0, index + 1);
        return members.map(({ headSha, number }) => ({ headSha, number }));
    }
    return undefined;
}

function authoritativeGroupKind(
    current: DeliveryOperationAuthoritySnapshot,
    selected: number
): DeliveryOperationAuthoritySnapshot["pullRequestGroups"][number]["kind"] | undefined {
    return current.pullRequestGroups.find(({ members }) =>
        members.some(({ number }) => number === selected)
    )?.kind;
}

function selectedNumber(payload: DeliveryOperationJobPayload): number | undefined {
    if (payload.operation === "create-pull-request-stack") {
        return payload.expectedHeads.at(-1)?.number;
    }
    return "number" in payload ? payload.number : undefined;
}

function authorizePullRequestOperation(
    current: DeliveryOperationAuthoritySnapshot,
    payload: DeliveryOperationJobPayload
): void {
    const actionId = pullRequestActionId(payload);
    if (actionId === undefined) return;
    const number = selectedNumber(payload);
    const scope = operationScope(payload);
    const pullRequest = current.pullRequestGroups
        .flatMap(({ members }) => members)
        .find((candidate) => candidate.number === number);
    const authoritativeScope =
        number === undefined
            ? undefined
            : authoritativeActionScope(current, number, actionId);
    const groupKind =
        number === undefined ? undefined : authoritativeGroupKind(current, number);
    if (
        pullRequest === undefined ||
        authoritativeScope === undefined ||
        scope === undefined ||
        !sameScope(authoritativeScope, scope)
    ) {
        fail("conflict");
    }
    if (
        payload.operation === "merge-pull-request" &&
        payload.mergeStack !== (groupKind === "native-stack")
    ) {
        fail("conflict");
    }
    if (
        (payload.operation === "merge-pull-request" ||
            payload.operation === "start-preview") &&
        pullRequest.number !== payload.number
    ) {
        fail("conflict");
    }
    if (
        payload.operation === "approve-review" &&
        current.reviewerCapability.revision !== payload.reviewerRevision
    ) {
        fail("conflict");
    }
    if (
        payload.operation === "start-preview" &&
        current.preview.revision !== payload.previewRevision
    ) {
        fail("conflict");
    }
    if (
        payload.operation === "merge-pull-request" &&
        current.checkout.revision !== payload.checkoutRevision
    ) {
        fail("conflict");
    }
}

function authorizeProductionOperation(
    current: DeliveryOperationAuthoritySnapshot,
    payload: DeliveryOperationJobPayload
): void {
    if (payload.operation === "deploy") {
        if (
            current.checkout.revision !== payload.checkoutRevision ||
            current.checkout.remoteHeadSha !== payload.expectedMainHeadSha ||
            !current.checkout.safeForDeploy ||
            current.releases.activationRevision !== payload.activationRevision
        ) {
            fail("conflict");
        }
        return;
    }
    if (
        payload.operation === "rollback-release" &&
        (current.releases.activationRevision !== payload.activationRevision ||
            !current.releases.rollback.available ||
            JSON.stringify(current.releases.rollback.target) !==
                JSON.stringify(payload.target))
    ) {
        fail("conflict");
    }
}

function authorizePreviewStop(
    current: DeliveryOperationAuthoritySnapshot,
    payload: DeliveryOperationJobPayload
): void {
    if (payload.operation !== "stop-preview") return;
    if (
        current.preview.revision !== payload.previewRevision ||
        current.preview.number !== payload.number ||
        current.preview.status === "stopped" ||
        !current.preview.controlsAvailable
    ) {
        fail("conflict");
    }
}

async function currentOverview(
    options: DeliveryRuntimeOptions,
    payload: DeliveryOperationJobPayload,
    signal?: AbortSignal,
    operationRunId?: string
): Promise<DeliveryOperationAuthoritySnapshot> {
    let refreshed: DeliveryOperationAuthoritySnapshot;
    try {
        refreshed = v.parse(
            deliveryOperationAuthoritySnapshotSchema,
            await options.collector.collectForOperation(payload, operationRunId, signal)
        );
    } catch {
        return fail("source-unavailable");
    }
    return refreshed;
}

function result(
    operation: DeliveryJobOperationResult["operation"],
    outcome: DeliveryJobOperationResult["outcome"],
    warningCodes: readonly DeliveryOperationWarningCode[] = []
): DeliveryJobOperationResult {
    const warnings = canonicalDeliveryOperationWarnings(warningCodes);
    return Object.freeze({
        operation,
        outcome,
        ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
    });
}

function githubOutcome(
    operation: DeliveryJobOperationResult["operation"],
    outcome: DeliveryGitHubMutationOutcome
): DeliveryJobOperationResult {
    switch (outcome.outcome) {
        case "completed": {
            return result(operation, "completed");
        }
        case "enqueued": {
            return result(operation, "enqueued");
        }
        case "partial-success": {
            return result(operation, "completed-with-warnings", [outcome.warning]);
        }
        case "unknown-outcome": {
            return result(operation, "unknown-outcome");
        }
    }
}

async function cleanupMergedOrClosedPreviews(
    options: DeliveryRuntimeOptions,
    heads: readonly DeliveryExpectedHead[],
    signal?: AbortSignal
): Promise<boolean> {
    if (options.preview.cleanupConfirmed === undefined) return true;
    let complete = true;
    for (const head of heads) {
        try {
            await options.preview.cleanupConfirmed(
                {
                    expectedHeadSha: head.headSha,
                    number: head.number,
                    operationId: options.newOperationId?.() ?? Bun.randomUUIDv7(),
                },
                signal
            );
        } catch {
            complete = false;
        }
    }
    return complete;
}

async function syncMainAfterMerge(
    options: DeliveryRuntimeOptions,
    current: DeliveryOperationAuthoritySnapshot,
    mergedMainHeadSha: string,
    signal?: AbortSignal
): Promise<boolean> {
    try {
        const remoteHead = await options.github.readMainRef(signal);
        if (remoteHead !== mergedMainHeadSha) return false;
        const synchronized = await options.mainGit.syncMainToExactRef(
            mergedMainHeadSha,
            current.checkout.headSha,
            signal
        );
        return (
            synchronized.outcome === "completed" &&
            synchronized.headSha === mergedMainHeadSha
        );
    } catch {
        return false;
    }
}

async function executeGithub(
    options: DeliveryRuntimeOptions,
    payload: DeliveryOperationJobPayload,
    current: DeliveryOperationAuthoritySnapshot,
    signal?: AbortSignal
): Promise<DeliveryJobOperationResult> {
    try {
        switch (payload.operation) {
            case "approve-review": {
                if (options.reviewer === undefined) fail("reviewer-unavailable");
                return githubOutcome(
                    payload.operation,
                    await options.reviewer.approveReview(
                        {
                            headSha: payload.expectedHeadSha,
                            number: payload.number,
                        },
                        signal
                    )
                );
            }
            case "create-pull-request-stack": {
                await options.github.createNativeStack(payload.expectedHeads, signal);
                return result(payload.operation, "completed");
            }
            case "merge-pull-request": {
                const outcome = payload.mergeStack
                    ? await options.github.mergeNativeStack(payload.expectedHeads, signal)
                    : await options.github.mergePullRequest(
                          payload.expectedHeads[0]!,
                          signal
                      );
                if (
                    outcome.outcome === "enqueued" ||
                    outcome.outcome === "unknown-outcome"
                ) {
                    return githubOutcome(payload.operation, outcome);
                }
                const [synchronized, cleaned] = await Promise.all([
                    syncMainAfterMerge(options, current, outcome.mainHeadSha, signal),
                    cleanupMergedOrClosedPreviews(options, payload.expectedHeads, signal),
                ]);
                const warnings: DeliveryOperationWarningCode[] = [];
                if (outcome.outcome === "partial-success") {
                    warnings.push(outcome.warning);
                }
                if (!synchronized) warnings.push("main-sync-failed");
                if (!cleaned) warnings.push("preview-cleanup-failed");
                return result(
                    payload.operation,
                    warnings.length === 0 ? "completed" : "completed-with-warnings",
                    warnings
                );
            }
            case "reject-pull-request": {
                const outcome = await options.github.rejectPullRequest(
                    {
                        headSha: payload.expectedHeadSha,
                        number: payload.number,
                    },
                    signal
                );
                if (
                    outcome.outcome === "unknown-outcome" ||
                    outcome.outcome === "enqueued"
                ) {
                    return githubOutcome(payload.operation, outcome);
                }
                const cleaned = await cleanupMergedOrClosedPreviews(
                    options,
                    [{ headSha: payload.expectedHeadSha, number: payload.number }],
                    signal
                );
                const warnings: DeliveryOperationWarningCode[] = [];
                if (outcome.outcome === "partial-success") {
                    warnings.push(outcome.warning);
                }
                if (!cleaned) warnings.push("preview-cleanup-failed");
                return result(
                    payload.operation,
                    warnings.length === 0 ? "completed" : "completed-with-warnings",
                    warnings
                );
            }
            case "update-branch": {
                return githubOutcome(
                    payload.operation,
                    await options.github.updatePullRequestBranch(
                        {
                            headSha: payload.expectedHeadSha,
                            number: payload.number,
                        },
                        signal
                    )
                );
            }
            default: {
                return fail("conflict");
            }
        }
    } catch (error) {
        if (error instanceof DeliveryRuntimeError) throw error;
        if (error instanceof DeliveryGitHubError && error.reason === "unknown-outcome") {
            return result(payload.operation, "unknown-outcome");
        }
        throw new DeliveryRuntimeError({ reason: "conflict" });
    }
}

async function executePreview(
    options: DeliveryRuntimeOptions,
    payload: DeliveryOperationJobPayload,
    current: DeliveryOperationAuthoritySnapshot,
    signal?: AbortSignal
): Promise<DeliveryJobOperationResult> {
    const operationId = options.newOperationId?.() ?? Bun.randomUUIDv7();
    const hostStatus = await options.preview
        .status(signal)
        .catch(() => fail("source-unavailable"));
    if (
        hostStatus.status !== current.preview.status ||
        hostStatus.number !== current.preview.number ||
        hostStatus.headSha !== current.preview.headSha ||
        hostStatus.updatedAtMs !== current.preview.updatedAtMs
    ) {
        fail("conflict");
    }
    if (payload.operation === "start-preview") {
        const selected = current.pullRequestGroups
            .flatMap(({ members }) => members)
            .find(({ number }) => number === payload.number);
        if (selected === undefined) fail("conflict");
        await options.preview.start(
            {
                expectedHeads: payload.expectedHeads,
                number: payload.number,
                operationId,
                previewRevision: hostStatus.previewRevision ?? payload.previewRevision,
                title: selected.title,
            },
            signal
        );
        return result(payload.operation, "completed");
    }
    if (payload.operation === "stop-preview") {
        await options.preview.stop(
            {
                number: payload.number,
                operationId,
                previewRevision: hostStatus.previewRevision ?? payload.previewRevision,
            },
            signal
        );
        return result(payload.operation, "completed");
    }
    return fail("conflict");
}

/**
 * Creates the narrow worker runtime for Delivery refresh and typed operations.
 * @returns A cache-backed, exact-CAS Delivery execution port.
 */
export function createDeliveryRuntime(
    options: DeliveryRuntimeOptions
): DeliveryJobExecutionPort {
    return Object.freeze({
        async execute(
            payload: DeliveryOperationJobPayload,
            signal?: AbortSignal,
            runIdentity?: JobExecutionRunIdentity
        ): Promise<DeliveryJobOperationResult> {
            const productionOperation =
                payload.operation === "deploy" ||
                payload.operation === "rollback-release";
            if (productionOperation && runIdentity === undefined) {
                return fail("production-unavailable");
            }
            const current = await currentOverview(
                options,
                payload,
                signal,
                runIdentity?.runId
            );
            if (current.sourceRevision !== payload.sourceRevision) {
                return fail("conflict");
            }
            authorizePullRequestOperation(current, payload);
            authorizeProductionOperation(current, payload);
            authorizePreviewStop(current, payload);

            if (
                payload.operation === "deploy" ||
                payload.operation === "rollback-release"
            ) {
                if (options.production === undefined) {
                    return fail("production-unavailable");
                }
                const productionResult = await options.production.execute(
                    payload,
                    current,
                    runIdentity!,
                    signal
                );
                if (productionResult.operation !== payload.operation) {
                    return result(payload.operation, "unknown-outcome");
                }
                return productionResult;
            }
            if (
                payload.operation === "start-preview" ||
                payload.operation === "stop-preview"
            ) {
                return executePreview(options, payload, current, signal);
            }
            return executeGithub(options, payload, current, signal);
        },
        readPrevious: options.readPrevious,
        refresh: (previous: DeliveryOverviewPreviousSections, signal?: AbortSignal) =>
            options.collector.collectSections(previous, signal),
    });
}
