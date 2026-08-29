import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
    deliveryOverviewCacheKey,
    deliveryOverviewCacheKeys,
    deliveryOverviewSectionKeys,
    deliveryOverviewSectionSchemaIds,
    deliveryOverviewSectionSources,
    type DeliveryOperationAuthoritySnapshot,
} from "../../../contracts/delivery.ts";
import {
    deliveryGitHubActionKey,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
    type DeliveryJobExecutionPort,
    type DeliveryOperationJobPayload,
    type DeliveryOverviewSectionRefreshResult,
} from "../../../contracts/deliveryWorker.ts";
import { cacheProviderAcceptsWriter } from "../cache/providerRegistry.ts";
import {
    type JobActionExecutionContext,
    type JobCacheAttemptCommit,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
} from "./actionRegistry.ts";
import {
    createDeliveryGitHubJobExecutor,
    createDeliveryOverviewJobExecutor,
} from "./deliveryActionExecutors.ts";

const sourceRevision = "a".repeat(64);
const headSha = "b".repeat(40);

test("Delivery action settlements may write every owned overview section", () => {
    for (const actionKey of [
        deliveryGitHubActionKey,
        deliveryPreviewActionKey,
        deliveryProductionActionKey,
    ]) {
        for (const cacheKey of deliveryOverviewCacheKeys) {
            expect(cacheProviderAcceptsWriter(cacheKey, actionKey, "{}")).toBeTrue();
        }
    }
});

function overview(): DeliveryOperationAuthoritySnapshot {
    return {
        checkout: {
            branch: "main",
            condition: "ready",
            expectedBranch: "main",
            headSha,
            remoteHeadSha: headSha,
            revision: sourceRevision,
            safeForDeploy: true,
            upstream: "origin/main",
        },
        observedAtMs: 1000,
        preview: {
            controlsAvailable: true,
            revision: sourceRevision,
            status: "stopped",
            updatedAtMs: 1000,
        },
        pullRequestGroups: [],
        releases: {
            activationRevision: sourceRevision,
            rollback: {
                actor: "mira",
                available: false,
                reason: "no-previous-release",
            },
        },
        reviewerCapability: {
            actor: "raymond",
            available: true,
            revision: sourceRevision,
        },
        sourceRevision,
    };
}

function port(
    overrides: Partial<DeliveryJobExecutionPort> = {}
): DeliveryJobExecutionPort {
    const payloads = sections();
    return {
        execute: (payload) =>
            Promise.resolve({ operation: payload.operation, outcome: "completed" }),
        readPrevious: (section) => {
            const previous = payloads.find((candidate) => candidate.section === section);
            return previous?.state === "succeeded" ? previous.payload : undefined;
        },
        refresh: () => Promise.resolve(payloads),
        ...overrides,
    };
}

function sections(): readonly DeliveryOverviewSectionRefreshResult[] {
    const payload = overview();
    return [
        {
            payload: {
                checkout: payload.checkout,
                observedAtMs: payload.observedAtMs,
                sourceRevision: payload.sourceRevision,
            },
            section: "checkout",
            state: "succeeded",
        },
        {
            payload: {
                actionActive: false,
                observedAtMs: payload.observedAtMs,
                preview: payload.preview,
                sourceRevision: payload.sourceRevision,
            },
            section: "preview",
            state: "succeeded",
        },
        {
            payload: {
                groups: payload.pullRequestGroups,
                observedAtMs: payload.observedAtMs,
                reviewerCapability: payload.reviewerCapability,
                sourceRevision: payload.sourceRevision,
            },
            section: "pull-requests",
            state: "succeeded",
        },
        {
            payload: {
                actionActive: false,
                observedAtMs: payload.observedAtMs,
                releases: payload.releases,
                sourceRevision: payload.sourceRevision,
            },
            section: "releases",
            state: "succeeded",
        },
    ];
}

function context(
    attempts: JobCacheAttemptCommit[],
    outputs: string[] = []
): JobActionExecutionContext {
    return {
        armHostRestartClaimFence: () => Promise.resolve(),
        clearHostRestartClaimFence: () => Promise.resolve(),
        commitCacheAttempt: (attempt) => {
            attempts.push(attempt);
            return Promise.resolve("committed");
        },
        databaseReleaseId: "c".repeat(40),
        nowMs: () => 2000,
        reportProgress: () => Effect.succeed("appended"),
        workerInstanceId: "018f6f50-6a9e-7000-8000-000000000004",
        writeOutput: (_kind, message) => {
            outputs.push(message);
            return Effect.succeed("appended");
        },
    };
}

function rejectPayload(): DeliveryOperationJobPayload {
    return {
        expectedHeadSha: headSha,
        number: 424,
        operation: "reject-pull-request",
        sourceRevision,
    };
}

describe("Delivery job action executors", () => {
    test("persists four independently claim-fenced scheduled sections", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const payloads = sections();
        const result = await Effect.runPromise(
            createDeliveryOverviewJobExecutor(
                port({ refresh: () => Promise.resolve(payloads) })
            )(context(attempts), { key: deliveryOverviewCacheKey })
        );

        expect(result).toEqual({
            cacheKeys: deliveryOverviewCacheKeys,
            completedAtMs: 2000,
        });
        expect(attempts).toHaveLength(4);
        for (const [index, section] of [
            "checkout",
            "preview",
            "pull-requests",
            "releases",
        ].entries()) {
            const expectedKey =
                deliveryOverviewSectionKeys[
                    section as keyof typeof deliveryOverviewSectionKeys
                ];
            const attempt = attempts.find(
                (candidate) =>
                    candidate.kind === "succeeded" &&
                    candidate.entries[0]?.key === expectedKey
            );
            expect(attempt).toEqual({
                durationMs: expect.any(Number),
                entries: [
                    {
                        key: expectedKey,
                        metadata: { kind: `delivery-overview-${section}` },
                        payload:
                            payloads[index]!.state === "succeeded"
                                ? payloads[index]!.payload
                                : undefined,
                        schemaId:
                            deliveryOverviewSectionSchemaIds[
                                section as keyof typeof deliveryOverviewSectionSchemaIds
                            ],
                        source: deliveryOverviewSectionSources[
                            section as keyof typeof deliveryOverviewSectionSources
                        ],
                        ttlMs: 300_000,
                    },
                ],
                kind: "succeeded",
            });
        }
    });

    test("retains the last good overview after a retryable refresh failure", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const failure = await Effect.runPromise(
            createDeliveryOverviewJobExecutor(
                port({
                    refresh: () =>
                        Promise.resolve(
                            sections().map((item) =>
                                item.section === "pull-requests"
                                    ? {
                                          section: "pull-requests" as const,
                                          state: "failed" as const,
                                      }
                                    : item
                            )
                        ),
                })
            )(context(attempts), { key: deliveryOverviewCacheKey })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(attempts).toHaveLength(4);
        expect(
            attempts.find(
                (attempt) =>
                    attempt.kind === "failed" &&
                    attempt.key === deliveryOverviewSectionKeys["pull-requests"]
            )
        ).toEqual({
            durationMs: expect.any(Number),
            failureCode: "provider/delivery-pull-requests-unavailable",
            failureMessage: "Delivery section projection could not be collected.",
            key: deliveryOverviewSectionKeys["pull-requests"],
            kind: "failed",
        });
    });

    test("does not rewrite a completed GitHub effect when overview refresh fails", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const outputs: string[] = [];
        const result = await Effect.runPromise(
            createDeliveryGitHubJobExecutor(
                port({ refresh: () => Promise.reject(new Error("cache unavailable")) })
            )(context(attempts, outputs), rejectPayload())
        );

        expect(result).toEqual({
            completedAtMs: 2000,
            operation: "reject-pull-request",
            outcome: "completed",
            postSettlementWarnings: ["delivery-overview-refresh-failed"],
        });
        expect(attempts).toEqual([]);
        expect(outputs).toEqual([
            "The Delivery operation settled, but one or more overview sections failed to refresh; the durable job result remains authoritative.",
        ]);
    });

    test("keeps an uncertain provider effect non-retryable and skips refresh", async () => {
        let refreshes = 0;
        const failure = await Effect.runPromise(
            createDeliveryGitHubJobExecutor(
                port({
                    execute: (payload) =>
                        Promise.resolve({
                            operation: payload.operation,
                            outcome: "unknown-outcome",
                        }),
                    refresh: () => {
                        refreshes += 1;
                        return Promise.resolve(sections());
                    },
                })
            )(context([]), rejectPayload())
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionOutcomeUnknownError);
        expect(refreshes).toBe(0);
    });
});
