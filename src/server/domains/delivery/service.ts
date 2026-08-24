import * as v from "valibot";

import {
    type DeliveryExpectedHead,
    type DeliveryOperationId,
    type DeliveryOverviewSectionId,
    type DeliveryOverviewSectionPayloadById,
    type DeliveryPullRequestActionCapability,
    type DeliveryPullRequestGroup,
    type DeliveryPullRequestsCachePayload,
    type DeliveryPreviewResult,
    type DeliveryProductionCheckoutResult,
    type DeliveryPullRequestsResult,
    type DeliveryReleasesResult,
    type DeliveryRequestOperationInput,
    type DeliveryRequestOperationResult,
    deliveryDeploymentsResultSchema,
    deliveryOverviewSectionKeys,
    deliveryOverviewSectionPayloadSchemas,
    deliveryOverviewSectionSchemaIds,
    deliveryOverviewSectionSources,
    deliveryPreviewResultSchema,
    deliveryProductionCheckoutResultSchema,
    deliveryPullRequestsResultSchema,
    deliveryReleasesResultSchema,
    deliveryRequestOperationInputSchema,
    deliveryRequestOperationResultSchema,
} from "../../../contracts/delivery.ts";
import type { DeliveryOperationJobPayload } from "../../../contracts/deliveryWorker.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { DeliveryDeploymentHistoryReader } from "./deploymentHistory.ts";
import type {
    DeliveryOperationActor,
    DeliveryOperationAuditContext,
    DeliveryOperationAuditWriter,
} from "./operationAudit.ts";
import {
    DeliveryOperationQueueError,
    type DeliveryOperationQueue,
} from "./operationQueue.ts";
import type {
    DeliveryOverviewSnapshotRecord,
    DeliveryOverviewSnapshotRepository,
} from "./snapshotRepository.ts";

export type DeliveryServiceErrorReason =
    | "audit-unavailable"
    | "conflict"
    | "not-found"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized domain failure; GitHub, Git, host, and release details stay internal. */
export class DeliveryServiceError extends Error {
    readonly reason: DeliveryServiceErrorReason;

    constructor(reason: DeliveryServiceErrorReason, options?: ErrorOptions) {
        super("Delivery request failed", options);
        this.name = "DeliveryServiceError";
        this.reason = reason;
    }
}

export interface DeliveryControlContext extends DeliveryOperationAuditContext {
    /** Re-checks this exact session and recent MFA inside durable enqueue admission. */
    readonly reauthorize: () => void;
}

export interface DeliveryService {
    readonly approvePullRequest: (
        input: Extract<
            DeliveryRequestOperationInput,
            { operation: "merge-pull-request" }
        >,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly approveReview: (
        input: Extract<DeliveryRequestOperationInput, { operation: "approve-review" }>,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly createPullRequestStack: (
        input: Extract<
            DeliveryRequestOperationInput,
            { operation: "create-pull-request-stack" }
        >,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly deploy: (
        input: Extract<DeliveryRequestOperationInput, { operation: "deploy" }>,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly getPreview: () => DeliveryPreviewResult;
    readonly getProductionCheckout: () => DeliveryProductionCheckoutResult;
    readonly getReleases: () => DeliveryReleasesResult;
    readonly listDeployments: () => v.InferOutput<typeof deliveryDeploymentsResultSchema>;
    readonly listPullRequests: () => DeliveryPullRequestsResult;
    readonly rejectPullRequest: (
        input: Extract<
            DeliveryRequestOperationInput,
            { operation: "reject-pull-request" }
        >,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly requestOperation: (
        input: DeliveryRequestOperationInput,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly rollbackRelease: (
        input: Extract<DeliveryRequestOperationInput, { operation: "rollback-release" }>,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly startPreview: (
        input: Extract<DeliveryRequestOperationInput, { operation: "start-preview" }>,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly stopPreview: (
        input: Extract<DeliveryRequestOperationInput, { operation: "stop-preview" }>,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
    readonly updateBranch: (
        input: Extract<DeliveryRequestOperationInput, { operation: "update-branch" }>,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ) => Promise<DeliveryRequestOperationResult>;
}

export interface DeliveryServiceOptions {
    readonly auditWriter: DeliveryOperationAuditWriter;
    readonly deploymentHistory: DeliveryDeploymentHistoryReader;
    readonly lastKnownGoodMs?: number;
    readonly nowMs?: () => number;
    readonly onAuditSettlementFailure?: (event: {
        readonly operation: DeliveryOperationId;
        readonly settlement: "failed" | "queued";
    }) => void;
    readonly operationQueue: DeliveryOperationQueue;
    readonly snapshotRepository: DeliveryOverviewSnapshotRepository;
}

type ProjectedSnapshot<T> =
    | { readonly checkedAtMs: number; readonly state: "unavailable" }
    | (T & {
          readonly checkedAtMs: number;
          readonly state: "fresh";
      })
    | (T & {
          readonly checkedAtMs: number;
          readonly staleSinceMs: number;
          readonly state: "last-known-good";
      });

const defaultLastKnownGoodMs = 24 * 60 * 60 * 1000;

function checkedTime(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new DeliveryServiceError("unavailable");
    }
    return value;
}

function unavailable<T>(checkedAtMs: number): ProjectedSnapshot<T> {
    return { checkedAtMs, state: "unavailable" };
}

function projectSnapshot<TSection extends DeliveryOverviewSectionId>(
    section: TSection,
    record: DeliveryOverviewSnapshotRecord | undefined,
    checkedAtMs: number,
    lastKnownGoodMs: number
): ProjectedSnapshot<DeliveryOverviewSectionPayloadById[TSection]> {
    if (
        record === undefined ||
        record.key !== deliveryOverviewSectionKeys[section] ||
        record.schemaId !== deliveryOverviewSectionSchemaIds[section] ||
        record.source !== deliveryOverviewSectionSources[section] ||
        record.expiresAtMs === null ||
        record.lastSuccessAtMs === null
    ) {
        return unavailable(checkedAtMs);
    }
    if (
        [record.expiresAtMs, record.lastAttemptAtMs, record.lastSuccessAtMs].some(
            (value) => !Number.isSafeInteger(value) || value < 0
        ) ||
        record.lastAttemptAtMs > checkedAtMs ||
        record.lastSuccessAtMs > record.lastAttemptAtMs ||
        record.expiresAtMs <= record.lastSuccessAtMs ||
        (record.lastAttemptStatus === "succeeded" &&
            record.lastAttemptAtMs !== record.lastSuccessAtMs) ||
        checkedAtMs - record.lastSuccessAtMs > lastKnownGoodMs
    ) {
        return unavailable(checkedAtMs);
    }
    let payload: unknown = record.payload;
    if (typeof payload === "string") {
        try {
            payload = parseJsonText(payload);
        } catch {
            return unavailable(checkedAtMs);
        }
    }
    const parsed = v.safeParse(deliveryOverviewSectionPayloadSchemas[section], payload);
    if (
        !parsed.success ||
        parsed.output.observedAtMs > record.lastSuccessAtMs ||
        parsed.output.observedAtMs > checkedAtMs
    ) {
        return unavailable(checkedAtMs);
    }
    if (
        record.lastAttemptStatus === "succeeded" &&
        record.lastAttemptAtMs === record.lastSuccessAtMs &&
        record.expiresAtMs > checkedAtMs
    ) {
        return {
            ...(parsed.output as DeliveryOverviewSectionPayloadById[TSection]),
            checkedAtMs,
            state: "fresh",
        };
    }
    const staleSinceMs =
        record.lastAttemptStatus === "failed"
            ? record.lastAttemptAtMs
            : record.expiresAtMs;
    if (staleSinceMs < parsed.output.observedAtMs || staleSinceMs > checkedAtMs) {
        return unavailable(checkedAtMs);
    }
    return {
        ...(parsed.output as DeliveryOverviewSectionPayloadById[TSection]),
        checkedAtMs,
        staleSinceMs,
        state: "last-known-good",
    };
}

function headsMatch(
    left: readonly DeliveryExpectedHead[],
    right: readonly DeliveryExpectedHead[]
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (head, index) =>
                head.number === right[index]?.number &&
                head.headSha === right[index]?.headSha
        )
    );
}

function findPullRequestContext(
    snapshot: Extract<
        ProjectedSnapshot<DeliveryPullRequestsCachePayload>,
        { readonly state: "fresh" }
    >,
    number: number
):
    | Readonly<{
          group: DeliveryPullRequestGroup;
          index: number;
          pullRequest: DeliveryPullRequestGroup["members"][number];
      }>
    | undefined {
    for (const group of snapshot.groups) {
        const index = group.members.findIndex(
            (pullRequest) => pullRequest.number === number
        );
        if (index !== -1) {
            return Object.freeze({ group, index, pullRequest: group.members[index]! });
        }
    }
    return undefined;
}

function capabilityHeads(
    context: Exclude<ReturnType<typeof findPullRequestContext>, undefined>,
    capability: DeliveryPullRequestActionCapability
): readonly DeliveryExpectedHead[] {
    let members: readonly DeliveryPullRequestGroup["members"][number][] = [
        context.pullRequest,
    ];
    if (capability.scope === "group") members = context.group.members;
    if (capability.scope === "prefix") {
        members = context.group.members.slice(0, context.index + 1);
    }
    return members.map(({ headSha, number }) => ({ headSha, number }));
}

function publicActionFor(input: DeliveryRequestOperationInput) {
    if (input.operation === "merge-pull-request") {
        return "merge";
    }
    if (input.operation === "create-pull-request-stack") return "create-stack";
    if (input.operation === "start-preview") return "preview-start";
    if (input.operation === "reject-pull-request") return "reject";
    return input.operation;
}

function payloadFor(input: DeliveryRequestOperationInput): DeliveryOperationJobPayload {
    switch (input.operation) {
        case "approve-review": {
            return {
                expectedHeadSha: input.expectedHeadSha,
                number: input.number,
                operation: input.operation,
                reviewerRevision: input.reviewerRevision,
                sourceRevision: input.sourceRevision,
            };
        }
        case "create-pull-request-stack": {
            return {
                expectedHeads: input.expectedHeads,
                operation: input.operation,
                sourceRevision: input.sourceRevision,
            };
        }
        case "deploy": {
            return {
                activationRevision: input.activationRevision,
                checkoutRevision: input.checkoutRevision,
                expectedMainHeadSha: input.expectedMainHeadSha,
                operation: input.operation,
                release: input.release,
                sourceRevision: input.sourceRevision,
            };
        }
        case "merge-pull-request": {
            return {
                checkoutRevision: input.checkoutRevision,
                expectedHeads: input.expectedHeads,
                mergeStack: input.mergeStack,
                number: input.number,
                operation: input.operation,
                sourceRevision: input.sourceRevision,
            };
        }
        case "reject-pull-request":
        case "update-branch": {
            return {
                expectedHeadSha: input.expectedHeadSha,
                number: input.number,
                operation: input.operation,
                sourceRevision: input.sourceRevision,
            };
        }
        case "rollback-release": {
            return {
                activationRevision: input.activationRevision,
                operation: input.operation,
                sourceRevision: input.sourceRevision,
                target: input.target,
            };
        }
        case "start-preview": {
            return {
                expectedHeads: input.expectedHeads,
                number: input.number,
                operation: input.operation,
                previewRevision: input.previewRevision,
                sourceRevision: input.sourceRevision,
            };
        }
        case "stop-preview": {
            return {
                number: input.number,
                operation: input.operation,
                previewRevision: input.previewRevision,
                sourceRevision: input.sourceRevision,
            };
        }
    }
}

function queueFailure(error: DeliveryOperationQueueError): DeliveryServiceError {
    return new DeliveryServiceError(error.reason, { cause: error });
}

/**
 * Creates strict independent reads and audited exact-state mutation admission.
 * @param options Cache, history, queue, audit, clock, and stale-window boundaries.
 * @returns One request-safe Delivery domain service.
 */
export function createDeliveryService(options: DeliveryServiceOptions): DeliveryService {
    const lastKnownGoodMs = options.lastKnownGoodMs ?? defaultLastKnownGoodMs;
    if (!Number.isSafeInteger(lastKnownGoodMs) || lastKnownGoodMs < 0) {
        throw new RangeError("Delivery snapshot stale window is invalid");
    }
    const nowMs = options.nowMs ?? Date.now;

    function overview<TSection extends DeliveryOverviewSectionId>(
        section: TSection
    ): ProjectedSnapshot<DeliveryOverviewSectionPayloadById[TSection]> {
        let checkedAtMs = 0;
        try {
            checkedAtMs = checkedTime(nowMs);
            return projectSnapshot(
                section,
                options.snapshotRepository.read(section),
                checkedAtMs,
                lastKnownGoodMs
            );
        } catch {
            return unavailable(checkedAtMs);
        }
    }

    function freshSnapshot<TSection extends DeliveryOverviewSectionId>(
        section: TSection,
        sourceRevision?: string
    ): Extract<
        ProjectedSnapshot<DeliveryOverviewSectionPayloadById[TSection]>,
        { readonly state: "fresh" }
    > {
        const snapshot = overview(section);
        if (
            snapshot.state !== "fresh" ||
            (sourceRevision !== undefined && snapshot.sourceRevision !== sourceRevision)
        ) {
            throw new DeliveryServiceError("conflict");
        }
        return snapshot;
    }

    function authorizeOperation(
        input: DeliveryRequestOperationInput,
        actor: DeliveryOperationActor
    ): DeliveryOperationJobPayload {
        void actor;
        if (input.operation === "deploy") {
            const checkout = freshSnapshot("checkout", input.sourceRevision);
            const releases = freshSnapshot("releases");
            if (
                releases.actionActive ||
                !checkout.checkout.safeForDeploy ||
                checkout.checkout.revision !== input.checkoutRevision ||
                checkout.checkout.remoteHeadSha !== input.expectedMainHeadSha ||
                releases.releases.candidate === undefined ||
                releases.releases.current === undefined ||
                JSON.stringify(releases.releases.candidate) !==
                    JSON.stringify(input.release) ||
                input.release.runtime.revision !==
                    releases.releases.current.runtimeRevision ||
                releases.releases.activationRevision !== input.activationRevision
            ) {
                throw new DeliveryServiceError("conflict");
            }
            return payloadFor(input);
        }
        if (input.operation === "rollback-release") {
            const snapshot = freshSnapshot("releases", input.sourceRevision);
            const rollback = snapshot.releases.rollback;
            if (
                snapshot.actionActive ||
                snapshot.releases.activationRevision !== input.activationRevision ||
                !rollback.available ||
                JSON.stringify(rollback.target) !== JSON.stringify(input.target)
            ) {
                throw new DeliveryServiceError("conflict");
            }
            return payloadFor(input);
        }
        if (input.operation === "stop-preview") {
            const snapshot = freshSnapshot("preview", input.sourceRevision);
            if (
                snapshot.actionActive ||
                !snapshot.preview.controlsAvailable ||
                snapshot.preview.number !== input.number ||
                snapshot.preview.revision !== input.previewRevision ||
                snapshot.preview.status === "stopped" ||
                snapshot.preview.status === "view-only"
            ) {
                throw new DeliveryServiceError("conflict");
            }
            return payloadFor(input);
        }

        const snapshot = freshSnapshot("pull-requests", input.sourceRevision);

        const expectedHeads =
            input.operation === "create-pull-request-stack" ||
            input.operation === "merge-pull-request" ||
            input.operation === "start-preview"
                ? input.expectedHeads
                : [{ headSha: input.expectedHeadSha, number: input.number }];
        const pullRequestNumber =
            input.operation === "create-pull-request-stack"
                ? expectedHeads.at(-1)!.number
                : input.number;
        const pullRequestContext = findPullRequestContext(snapshot, pullRequestNumber);
        if (pullRequestContext === undefined) {
            throw new DeliveryServiceError("not-found");
        }
        const action = publicActionFor(input);
        const capability = pullRequestContext.pullRequest.actions.find(
            (candidate) => candidate.action === action
        );
        if (
            capability === undefined ||
            !capability.available ||
            !headsMatch(capabilityHeads(pullRequestContext, capability), expectedHeads)
        ) {
            throw new DeliveryServiceError("conflict");
        }
        if (
            input.operation === "merge-pull-request" &&
            input.mergeStack !== (pullRequestContext.group.kind === "native-stack")
        ) {
            throw new DeliveryServiceError("conflict");
        }
        if (
            input.operation === "approve-review" &&
            (!snapshot.reviewerCapability.available ||
                input.reviewerRevision !== snapshot.reviewerCapability.revision)
        ) {
            throw new DeliveryServiceError("conflict");
        }
        if (input.operation === "start-preview") {
            const preview = freshSnapshot("preview");
            if (
                preview.actionActive ||
                input.previewRevision !== preview.preview.revision
            ) {
                throw new DeliveryServiceError("conflict");
            }
        }
        if (input.operation === "merge-pull-request") {
            const checkout = freshSnapshot("checkout");
            if (
                input.checkoutRevision !== checkout.checkout.revision ||
                !checkout.checkout.safeForDeploy
            ) {
                throw new DeliveryServiceError("conflict");
            }
        }
        return payloadFor(input);
    }

    async function settleAudit(
        input: DeliveryRequestOperationInput,
        context: DeliveryOperationAuditContext,
        settlement:
            | { readonly kind: "failed" }
            | { readonly jobRunId: string; readonly kind: "queued" }
    ): Promise<void> {
        try {
            await options.auditWriter.record(
                settlement.kind === "queued"
                    ? {
                          ...context,
                          jobRunId: settlement.jobRunId,
                          operation: input.operation,
                          settlement: "queued",
                      }
                    : {
                          ...context,
                          operation: input.operation,
                          settlement: "failed",
                      }
            );
        } catch {
            try {
                options.onAuditSettlementFailure?.({
                    operation: input.operation,
                    settlement: settlement.kind,
                });
            } catch {
                // Observation cannot replace a known durable outcome.
            }
        }
    }

    async function requestOperation(
        input: DeliveryRequestOperationInput,
        context: DeliveryControlContext,
        signal?: AbortSignal
    ): Promise<DeliveryRequestOperationResult> {
        const parsed = v.parse(deliveryRequestOperationInputSchema, input);
        signal?.throwIfAborted();
        try {
            await options.auditWriter.record({
                actor: context.actor,
                operation: parsed.operation,
                requestId: context.requestId,
                settlement: "attempted",
            });
        } catch (error) {
            throw new DeliveryServiceError("audit-unavailable", { cause: error });
        }
        try {
            const result = await options.operationQueue.enqueue({
                actor: context.actor,
                authorizeDispatch: () => {
                    const payload = authorizeOperation(parsed, context.actor);
                    const serialized = JSON.stringify(payload);
                    return Promise.resolve({
                        authorize: () => {
                            context.reauthorize();
                            if (
                                JSON.stringify(
                                    authorizeOperation(parsed, context.actor)
                                ) !== serialized
                            ) {
                                throw new DeliveryServiceError("conflict");
                            }
                        },
                        payload,
                    });
                },
                input: parsed,
                requestId: context.requestId,
                signal,
            });
            const output = v.parse(deliveryRequestOperationResultSchema, result);
            await settleAudit(parsed, context, {
                jobRunId: output.jobRunId,
                kind: "queued",
            });
            return output;
        } catch (error) {
            await settleAudit(parsed, context, { kind: "failed" });
            if (error instanceof DeliveryOperationQueueError) {
                throw queueFailure(error);
            }
            if (error instanceof v.ValiError) {
                throw new DeliveryServiceError("unavailable", { cause: error });
            }
            throw error;
        }
    }

    const service: DeliveryService = {
        approvePullRequest: requestOperation,
        approveReview: requestOperation,
        createPullRequestStack: requestOperation,
        deploy: requestOperation,
        getPreview() {
            const snapshot = overview("preview");
            return snapshot.state === "unavailable"
                ? v.parse(deliveryPreviewResultSchema, snapshot)
                : v.parse(deliveryPreviewResultSchema, {
                      checkedAtMs: snapshot.checkedAtMs,
                      actionActive: snapshot.actionActive,
                      observedAtMs: snapshot.observedAtMs,
                      preview: snapshot.preview,
                      sourceRevision: snapshot.sourceRevision,
                      ...(snapshot.state === "last-known-good"
                          ? { staleSinceMs: snapshot.staleSinceMs }
                          : {}),
                      state: snapshot.state,
                  });
        },
        getProductionCheckout() {
            const snapshot = overview("checkout");
            return snapshot.state === "unavailable"
                ? v.parse(deliveryProductionCheckoutResultSchema, snapshot)
                : v.parse(deliveryProductionCheckoutResultSchema, {
                      checkedAtMs: snapshot.checkedAtMs,
                      checkout: snapshot.checkout,
                      observedAtMs: snapshot.observedAtMs,
                      sourceRevision: snapshot.sourceRevision,
                      ...(snapshot.state === "last-known-good"
                          ? { staleSinceMs: snapshot.staleSinceMs }
                          : {}),
                      state: snapshot.state,
                  });
        },
        getReleases() {
            const snapshot = overview("releases");
            return snapshot.state === "unavailable"
                ? v.parse(deliveryReleasesResultSchema, snapshot)
                : v.parse(deliveryReleasesResultSchema, {
                      checkedAtMs: snapshot.checkedAtMs,
                      actionActive: snapshot.actionActive,
                      observedAtMs: snapshot.observedAtMs,
                      releases: snapshot.releases,
                      sourceRevision: snapshot.sourceRevision,
                      ...(snapshot.state === "last-known-good"
                          ? { staleSinceMs: snapshot.staleSinceMs }
                          : {}),
                      state: snapshot.state,
                  });
        },
        listDeployments() {
            return options.deploymentHistory.read();
        },
        listPullRequests() {
            const snapshot = overview("pull-requests");
            return snapshot.state === "unavailable"
                ? v.parse(deliveryPullRequestsResultSchema, snapshot)
                : v.parse(deliveryPullRequestsResultSchema, {
                      checkedAtMs: snapshot.checkedAtMs,
                      groups: snapshot.groups,
                      observedAtMs: snapshot.observedAtMs,
                      reviewerCapability: snapshot.reviewerCapability,
                      sourceRevision: snapshot.sourceRevision,
                      ...(snapshot.state === "last-known-good"
                          ? { staleSinceMs: snapshot.staleSinceMs }
                          : {}),
                      state: snapshot.state,
                  });
        },
        rejectPullRequest: requestOperation,
        requestOperation,
        rollbackRelease: requestOperation,
        startPreview: requestOperation,
        stopPreview: requestOperation,
        updateBranch: requestOperation,
    };
    return Object.freeze(service);
}
