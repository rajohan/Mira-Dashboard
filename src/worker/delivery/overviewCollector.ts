import * as v from "valibot";

import {
    deliveryCheckoutCachePayloadSchema,
    deliveryOperationAuthoritySnapshotSchema,
    deliveryPreviewCachePayloadSchema,
    deliveryPullRequestsCachePayloadSchema,
    deliveryReleasesSchema,
    deliveryReleasesCachePayloadSchema,
    type DeliveryCheckoutCachePayload,
    type DeliveryOperationAuthoritySnapshot,
    type DeliveryPreviewCachePayload,
    type DeliveryPullRequestsCachePayload,
    type DeliveryReleases,
    type DeliveryReleasesCachePayload,
} from "../../contracts/delivery.ts";
import type {
    DeliveryDashboardMainGitSyncPort,
    DeliveryGitHubPullRequestReadPort,
    DeliveryGitHubPublishedRelease,
} from "../../contracts/deliveryGithub.ts";
import type {
    DeliveryOperationJobPayload,
    DeliveryOverviewPreviousSections,
    DeliveryOverviewSectionRefreshResult,
} from "../../contracts/deliveryWorker.ts";
import {
    projectDeliveryCheckout,
    projectDeliveryOperationAuthority,
    projectDeliveryPreview,
    projectDeliveryPullRequests,
    projectDeliveryReleases,
    type DeliveryOverviewProjectionInput,
    type DeliveryProductionAuthoritySnapshot,
    type DeliveryReviewerAuthority,
} from "./overviewProjection.ts";
import type { PreviewHostStatus } from "./previewHost.ts";

export interface DeliveryPreviewReadPort {
    readonly reconcile?: (signal?: AbortSignal) => Promise<PreviewHostStatus>;
    readonly status: (signal?: AbortSignal) => Promise<PreviewHostStatus>;
}

export interface DeliveryProductionReadPort {
    readonly read: (signal?: AbortSignal) => Promise<DeliveryProductionAuthoritySnapshot>;
    readonly readForOperation?: (
        runId: string,
        signal?: AbortSignal
    ) => Promise<DeliveryProductionAuthoritySnapshot>;
}

export interface DeliveryReviewerCapabilityProbe {
    readonly probe: (signal?: AbortSignal) => Promise<DeliveryReviewerAuthority>;
}

export interface DeliveryOverviewCollectorOptions {
    readonly activePreviewOperation?: (
        signal?: AbortSignal
    ) => Promise<
        | Extract<
              DeliveryOperationJobPayload,
              { operation: "start-preview" | "stop-preview" }
          >
        | undefined
    >;
    readonly github: DeliveryGitHubPullRequestReadPort;
    readonly mainGit: DeliveryDashboardMainGitSyncPort;
    readonly nowMs?: () => number;
    readonly preview: DeliveryPreviewReadPort;
    readonly previewControlsAvailable?: boolean;
    readonly production: DeliveryProductionReadPort;
    readonly reviewer?: DeliveryReviewerCapabilityProbe;
}

export interface DeliveryOverviewCollector {
    /** Exact operation authority; production paths intentionally skip unrelated PR reads. */
    readonly collectForOperation: (
        payload: DeliveryOperationJobPayload,
        runId?: string,
        signal?: AbortSignal
    ) => Promise<DeliveryOperationAuthoritySnapshot>;
    /** Scheduled refresh result; every section settles independently. */
    readonly collectSections: (
        previous?: DeliveryOverviewPreviousSections,
        signal?: AbortSignal
    ) => Promise<readonly DeliveryOverviewSectionRefreshResult[]>;
}

type Settled<T> =
    | Readonly<{ state: "failed" }>
    | Readonly<{ state: "succeeded"; value: T }>;

const unavailableRevision = "0".repeat(64);
const unavailableHead = "0".repeat(40);

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
    return promise.then(
        (value) => Object.freeze({ state: "succeeded" as const, value }),
        () => Object.freeze({ state: "failed" as const })
    );
}

function settleCall<T>(call: () => PromiseLike<T> | T): Promise<Settled<T>> {
    try {
        return Promise.resolve(call()).then(
            (value) => Object.freeze({ state: "succeeded" as const, value }),
            () => Object.freeze({ state: "failed" as const })
        );
    } catch {
        return Promise.resolve(Object.freeze({ state: "failed" as const }));
    }
}

function reviewerAuthority(
    probe: DeliveryReviewerCapabilityProbe | undefined,
    signal?: AbortSignal
): Promise<DeliveryReviewerAuthority> {
    if (probe === undefined) {
        return Promise.resolve(
            Object.freeze({ reason: "credential-missing", state: "unavailable" })
        );
    }
    return probe.probe(signal).catch(() =>
        Object.freeze({
            reason: "provider-unavailable" as const,
            state: "unavailable" as const,
        })
    );
}

function assertProductionSnapshot(
    value: DeliveryProductionAuthoritySnapshot
): DeliveryProductionAuthoritySnapshot {
    if (typeof value.actionActive !== "boolean") {
        throw new TypeError("Delivery production authority is invalid");
    }
    return Object.freeze({
        actionActive: value.actionActive,
        releases: v.parse(deliveryReleasesSchema, value.releases),
    });
}

function withPublishedCandidate(
    production: DeliveryProductionAuthoritySnapshot,
    release: DeliveryGitHubPublishedRelease,
    mainHeadSha: string
): DeliveryProductionAuthoritySnapshot {
    if (release.releaseId !== mainHeadSha) return production;
    const current = production.releases.current?.releaseId;
    return assertProductionSnapshot({
        ...production,
        releases: {
            ...production.releases,
            ...(current === release.releaseId
                ? {}
                : {
                      candidate: {
                          ...release,
                      },
                  }),
        },
    });
}

function unavailableReleases(): DeliveryReleases {
    return {
        activationRevision: unavailableRevision,
        rollback: {
            actor: "mira",
            available: false,
            reason: "source-unavailable",
        },
    };
}

function fallbackProjectionInput(observedAtMs: number): DeliveryOverviewProjectionInput {
    return {
        checkoutInspection: {
            condition: "dirty",
            headSha: unavailableHead,
            safe: false,
        },
        mainHeadSha: unavailableHead,
        observedAtMs,
        previewControlsAvailable: false,
        previewStatus: { status: "stopped", updatedAtMs: observedAtMs },
        production: { actionActive: true, releases: unavailableReleases() },
        pullRequests: [],
        reviewer: { reason: "provider-unavailable", state: "unavailable" },
        supportsNativeStacks: false,
    };
}

function previewStatus(
    preview: DeliveryPreviewReadPort,
    signal?: AbortSignal
): Promise<PreviewHostStatus> {
    return preview.reconcile?.(signal) ?? preview.status(signal);
}

function overlayActivePreviewOperation(
    status: PreviewHostStatus,
    operation:
        | Extract<
              DeliveryOperationJobPayload,
              { operation: "start-preview" | "stop-preview" }
          >
        | undefined,
    observedAtMs: number
): PreviewHostStatus {
    if (operation === undefined) return status;
    if (operation.operation === "start-preview") {
        const selected = operation.expectedHeads.find(
            ({ number }) => number === operation.number
        );
        if (selected === undefined) {
            throw new TypeError("Delivery preview operation authority is invalid");
        }
        return Object.freeze({
            expectedHeads: operation.expectedHeads,
            headSha: selected.headSha,
            number: operation.number,
            previewRevision: operation.previewRevision,
            status: "starting",
            ...(status.number === operation.number && status.title !== undefined
                ? { title: status.title }
                : {}),
            updatedAtMs: observedAtMs,
        });
    }
    if (status.number !== operation.number || status.headSha === undefined) {
        throw new TypeError("Delivery preview operation authority is invalid");
    }
    return Object.freeze({
        ...status,
        previewRevision: operation.previewRevision,
        status: "stopping",
        updatedAtMs: observedAtMs,
    });
}

function completeOperationAuthority(input: {
    checkout: DeliveryCheckoutCachePayload;
    preview: DeliveryPreviewCachePayload;
    pullRequests: DeliveryPullRequestsCachePayload;
    releases: DeliveryReleasesCachePayload;
    sourceRevision: string;
}): DeliveryOperationAuthoritySnapshot {
    return v.parse(deliveryOperationAuthoritySnapshotSchema, {
        checkout: input.checkout.checkout,
        observedAtMs: Math.max(
            input.checkout.observedAtMs,
            input.preview.observedAtMs,
            input.pullRequests.observedAtMs,
            input.releases.observedAtMs
        ),
        preview: input.preview.preview,
        pullRequestGroups: input.pullRequests.groups,
        releases: input.releases.releases,
        reviewerCapability: input.pullRequests.reviewerCapability,
        sourceRevision: input.sourceRevision,
    });
}

/**
 * Creates the worker-owned collector with four independent cache authorities.
 * GitHub failure cannot hide preview, checkout, or release state.
 * @param options Worker-only authority ports and bounded clock.
 * @returns The section refresh and operation-authority collector.
 */
export function createDeliveryOverviewCollector(
    options: DeliveryOverviewCollectorOptions
): DeliveryOverviewCollector {
    const nowMs = options.nowMs ?? Date.now;

    async function collectSectionsWithProduction(
        productionRead: Promise<DeliveryProductionAuthoritySnapshot>,
        signal?: AbortSignal,
        includeActivePreviewOperation = true
    ): Promise<readonly DeliveryOverviewSectionRefreshResult[]> {
        signal?.throwIfAborted();
        const observedAtMs = nowMs();
        const [
            inspection,
            mainHead,
            previewState,
            activePreviewOperation,
            production,
            pullRequests,
            reviewer,
            stacks,
            publishedRelease,
        ] = await Promise.all([
            settleCall(() => options.mainGit.inspect(signal)),
            settleCall(() => options.github.readMainRef(signal)),
            settleCall(() => previewStatus(options.preview, signal)),
            settleCall(
                () =>
                    (includeActivePreviewOperation
                        ? options.activePreviewOperation?.(signal)
                        : undefined) ?? Promise.resolve(undefined)
            ),
            settle(productionRead.then(assertProductionSnapshot)),
            settleCall(() => options.github.listOpenPullRequests(signal)),
            settleCall(() => reviewerAuthority(options.reviewer, signal)),
            settleCall(() => options.github.supportsNativeStacks(signal)),
            settleCall(() => {
                const read = options.github.readLatestPublishedRelease;
                return read === undefined
                    ? Promise.reject(new Error("Published release unavailable"))
                    : read(signal);
            }),
        ]);
        signal?.throwIfAborted();
        const fallback = fallbackProjectionInput(observedAtMs);
        let projectedProduction: DeliveryProductionAuthoritySnapshot | undefined;
        if (
            production.state === "succeeded" &&
            mainHead.state === "succeeded" &&
            publishedRelease.state === "succeeded"
        ) {
            projectedProduction = withPublishedCandidate(
                production.value,
                publishedRelease.value,
                mainHead.value
            );
        }

        const checkout =
            inspection.state === "succeeded" && mainHead.state === "succeeded"
                ? settleCall(() =>
                      projectDeliveryCheckout({
                          checkoutInspection: inspection.value,
                          mainHeadSha: mainHead.value,
                          observedAtMs,
                      })
                  )
                : Promise.resolve<Settled<DeliveryCheckoutCachePayload>>({
                      state: "failed",
                  });
        const projectedPreviewStatus =
            previewState.state === "succeeded" &&
            activePreviewOperation.state === "succeeded"
                ? await settleCall(() =>
                      overlayActivePreviewOperation(
                          previewState.value,
                          activePreviewOperation.value,
                          observedAtMs
                      )
                  )
                : ({ state: "failed" } as const);
        const preview =
            projectedPreviewStatus.state === "succeeded"
                ? settleCall(() =>
                      projectDeliveryPreview({
                          actionActive:
                              production.state === "succeeded"
                                  ? production.value.actionActive
                                  : true,
                          observedAtMs,
                          previewControlsAvailable: options.previewControlsAvailable,
                          previewStatus: projectedPreviewStatus.value,
                      })
                  )
                : Promise.resolve<Settled<DeliveryPreviewCachePayload>>({
                      state: "failed",
                  });
        const releases =
            projectedProduction === undefined
                ? Promise.resolve<Settled<DeliveryReleasesCachePayload>>({
                      state: "failed",
                  })
                : settleCall(() =>
                      projectDeliveryReleases({
                          observedAtMs,
                          production: projectedProduction,
                      })
                  );

        let pullRequestResult: Settled<DeliveryPullRequestsCachePayload> = {
            state: "failed",
        };
        if (pullRequests.state === "succeeded") {
            const projectedInput: DeliveryOverviewProjectionInput = {
                ...fallback,
                ...(inspection.state === "succeeded" && mainHead.state === "succeeded"
                    ? {
                          checkoutInspection: inspection.value,
                          mainHeadSha: mainHead.value,
                      }
                    : {}),
                observedAtMs,
                ...(projectedPreviewStatus.state === "succeeded"
                    ? {
                          previewControlsAvailable: options.previewControlsAvailable,
                          previewStatus: projectedPreviewStatus.value,
                      }
                    : {}),
                ...(projectedProduction === undefined
                    ? {}
                    : { production: projectedProduction }),
                pullRequests: pullRequests.value,
                reviewer:
                    reviewer.state === "succeeded" ? reviewer.value : fallback.reviewer,
                supportsNativeStacks: stacks.state === "succeeded" ? stacks.value : false,
            };
            pullRequestResult = await settleCall(() =>
                projectDeliveryPullRequests(projectedInput)
            );
        }
        const [checkoutResult, previewResult, releasesResult] = await Promise.all([
            checkout,
            preview,
            releases,
        ]);
        const output: readonly DeliveryOverviewSectionRefreshResult[] = [
            checkoutResult.state === "succeeded"
                ? {
                      payload: checkoutResult.value,
                      section: "checkout" as const,
                      state: "succeeded" as const,
                  }
                : { section: "checkout" as const, state: "failed" as const },
            previewResult.state === "succeeded"
                ? {
                      payload: previewResult.value,
                      section: "preview" as const,
                      state: "succeeded" as const,
                  }
                : { section: "preview" as const, state: "failed" as const },
            pullRequestResult.state === "succeeded"
                ? {
                      payload: pullRequestResult.value,
                      section: "pull-requests",
                      state: "succeeded",
                  }
                : { section: "pull-requests" as const, state: "failed" as const },
            releasesResult.state === "succeeded"
                ? {
                      payload: releasesResult.value,
                      section: "releases" as const,
                      state: "succeeded" as const,
                  }
                : { section: "releases" as const, state: "failed" as const },
        ];
        return Object.freeze(output);
    }

    return Object.freeze({
        async collectForOperation(
            payload: DeliveryOperationJobPayload,
            runId?: string,
            signal?: AbortSignal
        ) {
            const productionRead =
                runId === undefined
                    ? options.production.read(signal)
                    : options.production.readForOperation?.(runId, signal);
            if (productionRead === undefined) {
                throw new Error("Delivery production authority is unavailable");
            }
            const observedAtMs = nowMs();
            const fallbackWhole = projectDeliveryOperationAuthority(
                fallbackProjectionInput(observedAtMs)
            );
            const fallbackCheckout: DeliveryCheckoutCachePayload = {
                checkout: fallbackWhole.checkout,
                observedAtMs,
                sourceRevision: unavailableRevision,
            };
            const fallbackPreview: DeliveryPreviewCachePayload = {
                actionActive: true,
                observedAtMs,
                preview: fallbackWhole.preview,
                sourceRevision: unavailableRevision,
            };
            const fallbackPullRequests: DeliveryPullRequestsCachePayload = {
                groups: [],
                observedAtMs,
                reviewerCapability: fallbackWhole.reviewerCapability,
                sourceRevision: unavailableRevision,
            };
            const fallbackReleases: DeliveryReleasesCachePayload = {
                actionActive: true,
                observedAtMs,
                releases: fallbackWhole.releases,
                sourceRevision: unavailableRevision,
            };
            if (payload.operation === "deploy") {
                const readPublishedRelease = options.github.readLatestPublishedRelease;
                if (readPublishedRelease === undefined) {
                    throw new Error(
                        "Delivery published release authority is unavailable"
                    );
                }
                const [inspection, mainHead, production, publishedRelease] =
                    await Promise.all([
                        options.mainGit.inspect(signal),
                        options.github.readMainRef(signal),
                        productionRead.then(assertProductionSnapshot),
                        readPublishedRelease(signal),
                    ]);
                const checkout = projectDeliveryCheckout({
                    checkoutInspection: inspection,
                    mainHeadSha: mainHead,
                    observedAtMs,
                });
                const releases = projectDeliveryReleases({
                    observedAtMs,
                    production: withPublishedCandidate(
                        production,
                        publishedRelease,
                        mainHead
                    ),
                });
                return completeOperationAuthority({
                    checkout,
                    preview: fallbackPreview,
                    pullRequests: fallbackPullRequests,
                    releases,
                    sourceRevision: checkout.sourceRevision,
                });
            }
            if (payload.operation === "rollback-release") {
                const production = assertProductionSnapshot(await productionRead);
                const releases = projectDeliveryReleases({ observedAtMs, production });
                return completeOperationAuthority({
                    checkout: fallbackCheckout,
                    preview: fallbackPreview,
                    pullRequests: fallbackPullRequests,
                    releases,
                    sourceRevision: releases.sourceRevision,
                });
            }
            if (payload.operation === "stop-preview") {
                const [status, production] = await Promise.all([
                    previewStatus(options.preview, signal),
                    productionRead.then(assertProductionSnapshot),
                ]);
                const preview = projectDeliveryPreview({
                    actionActive: production.actionActive,
                    observedAtMs,
                    previewControlsAvailable: options.previewControlsAvailable,
                    previewStatus: status,
                });
                return completeOperationAuthority({
                    checkout: fallbackCheckout,
                    preview,
                    pullRequests: fallbackPullRequests,
                    releases: fallbackReleases,
                    sourceRevision: preview.sourceRevision,
                });
            }
            const results = await collectSectionsWithProduction(
                productionRead,
                signal,
                false
            );
            const checkoutResult = results.find(({ section }) => section === "checkout");
            const previewResult = results.find(({ section }) => section === "preview");
            const pullRequestsResult = results.find(
                ({ section }) => section === "pull-requests"
            );
            const releasesResult = results.find(({ section }) => section === "releases");
            const checkout =
                checkoutResult?.state === "succeeded"
                    ? v.parse(deliveryCheckoutCachePayloadSchema, checkoutResult.payload)
                    : {
                          ...fallbackCheckout,
                      };
            const preview =
                previewResult?.state === "succeeded"
                    ? v.parse(deliveryPreviewCachePayloadSchema, previewResult.payload)
                    : fallbackPreview;
            const pullRequests =
                pullRequestsResult?.state === "succeeded"
                    ? v.parse(
                          deliveryPullRequestsCachePayloadSchema,
                          pullRequestsResult.payload
                      )
                    : fallbackPullRequests;
            const releases =
                releasesResult?.state === "succeeded"
                    ? v.parse(deliveryReleasesCachePayloadSchema, releasesResult.payload)
                    : fallbackReleases;
            return completeOperationAuthority({
                checkout,
                preview,
                pullRequests,
                releases,
                sourceRevision: pullRequests.sourceRevision,
            });
        },
        collectSections(_previous = {}, signal?: AbortSignal) {
            return collectSectionsWithProduction(
                Promise.resolve().then(() => options.production.read(signal)),
                signal
            );
        },
    });
}
