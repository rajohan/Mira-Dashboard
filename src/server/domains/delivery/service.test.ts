import { describe, expect, test } from "bun:test";

import {
    deliveryOverviewSectionKeys,
    deliveryOverviewSectionSchemaIds,
    deliveryOverviewSectionSources,
    type DeliveryOperationAuthoritySnapshot,
    type DeliveryOverviewSectionId,
} from "../../../contracts/delivery.ts";
import { publishedReleaseAuthority } from "../../../testSupport/publishedReleaseAuthority.ts";
import { createDeliveryService, DeliveryServiceError } from "./service.ts";

const headSha = "a".repeat(40);
const sourceRevision = "b".repeat(64);
const groupId = "c".repeat(64);
const runId = "018f6f50-6a9e-7b88-8000-000000000020";
const actor = Object.freeze({
    authenticatorId: "018f6f50-6a9e-7b88-8000-000000000010",
    id: "018f6f50-6a9e-7b88-8000-000000000011",
    kind: "user" as const,
});

function payload(
    action: "approve-review" | "merge" | "reject" = "merge"
): DeliveryOperationAuthoritySnapshot {
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
        observedAtMs: 2000,
        preview: {
            controlsAvailable: true,
            revision: sourceRevision,
            status: "stopped",
            updatedAtMs: 2000,
        },
        pullRequestGroups: [
            {
                id: groupId,
                kind: "standalone-mira",
                members: [
                    {
                        actions: [
                            {
                                action,
                                actor: action === "approve-review" ? "raymond" : "mira",
                                available: true,
                                scope: action === "merge" ? "prefix" : "self",
                            },
                        ],
                        additions: 1,
                        author: "mira-2026",
                        baseRef: "main",
                        changedFiles: 1,
                        checksState: "passed",
                        createdAtMs: 1000,
                        deletions: 0,
                        headRef: "feature",
                        headSha,
                        isCrossRepository: false,
                        isDraft: false,
                        mergeState: "CLEAN",
                        mergeability: "mergeable",
                        number: 42,
                        reviewState: "approved",
                        title: "Feature",
                        updatedAtMs: 2000,
                        url: "https://github.com/rajohan/Mira-Dashboard/pull/42",
                    },
                ],
            },
        ],
        releases: {
            activationRevision: sourceRevision,
            current: {
                builtAtMs: 1000,
                commitTitle: "Current",
                commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${headSha}`,
                releaseId: headSha,
                runtimeRevision: "b".repeat(40),
                schemaTarget: 1,
            },
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

function sectionPayloads(value = payload()) {
    return {
        checkout: {
            checkout: value.checkout,
            observedAtMs: value.observedAtMs,
            sourceRevision: value.sourceRevision,
        },
        preview: {
            actionActive: false,
            observedAtMs: value.observedAtMs,
            preview: value.preview,
            sourceRevision: value.sourceRevision,
        },
        "pull-requests": {
            groups: value.pullRequestGroups,
            observedAtMs: value.observedAtMs,
            reviewerCapability: value.reviewerCapability,
            sourceRevision: value.sourceRevision,
        },
        releases: {
            actionActive: false,
            observedAtMs: value.observedAtMs,
            releases: value.releases,
            sourceRevision: value.sourceRevision,
        },
    };
}

function record(section: DeliveryOverviewSectionId, value = payload()) {
    return {
        expiresAtMs: 5000,
        key: deliveryOverviewSectionKeys[section],
        lastAttemptAtMs: 2000,
        lastAttemptStatus: "succeeded" as const,
        lastSuccessAtMs: 2000,
        payload: sectionPayloads(value)[section],
        schemaId: deliveryOverviewSectionSchemaIds[section],
        source: deliveryOverviewSectionSources[section],
    };
}

function fixture(value = payload()) {
    const audits: unknown[] = [];
    const queued: unknown[] = [];
    let currentRecords = Object.fromEntries(
        (["checkout", "preview", "pull-requests", "releases"] as const).map((section) => [
            section,
            record(section, value),
        ])
    ) as Record<DeliveryOverviewSectionId, ReturnType<typeof record>>;
    const service = createDeliveryService({
        auditWriter: {
            record(event) {
                audits.push(event);
                return Promise.resolve();
            },
        },
        deploymentHistory: {
            read: () => ({ checkedAtMs: 3000, deployments: [], state: "fresh" }),
        },
        nowMs: () => 3000,
        operationQueue: {
            async enqueue(request) {
                const dispatch = await request.authorizeDispatch();
                dispatch.authorize();
                queued.push(dispatch.payload);
                return {
                    jobRunId: runId,
                    operation: request.input.operation,
                    queued: true,
                };
            },
        },
        snapshotRepository: { read: (section) => currentRecords[section] },
    });
    return {
        audits,
        queued,
        service,
        setSchemaId(section: DeliveryOverviewSectionId, schemaId: string) {
            currentRecords = {
                ...currentRecords,
                [section]: { ...currentRecords[section], schemaId },
            };
        },
        setExpires(expiresAtMs: number) {
            currentRecords = Object.fromEntries(
                Object.entries(currentRecords).map(([section, current]) => [
                    section,
                    { ...current, expiresAtMs },
                ])
            ) as typeof currentRecords;
        },
    };
}

const context = {
    actor,
    reauthorize: () => {},
    requestId: "request-1",
};

describe("Delivery service", () => {
    test("projects the four cache reads independently and keeps Jobs history separate", () => {
        const { service } = fixture();
        expect(service.listPullRequests()).toMatchObject({ state: "fresh" });
        expect(service.getPreview()).toMatchObject({ state: "fresh" });
        expect(service.getProductionCheckout()).toMatchObject({ state: "fresh" });
        expect(service.getReleases()).toMatchObject({ state: "fresh" });
        expect(service.listDeployments()).toEqual({
            checkedAtMs: 3000,
            deployments: [],
            state: "fresh",
        });
    });

    test("demotes an expired valid snapshot to last-known-good", () => {
        const next = fixture();
        next.setExpires(2500);
        expect(next.service.listPullRequests()).toMatchObject({
            staleSinceMs: 2500,
            state: "last-known-good",
        });
    });

    test("rejects the superseded pull-request capability cache schema", () => {
        const next = fixture();
        next.setSchemaId("pull-requests", "delivery.overview.pull-requests.v1");
        expect(next.service.listPullRequests()).toEqual({
            checkedAtMs: 3000,
            state: "unavailable",
        });
    });

    test("queues only an exact fresh capability and audits attempted plus queued", async () => {
        const next = fixture();
        let reauthorizations = 0;
        const result = await next.service.approvePullRequest(
            {
                checkoutRevision: sourceRevision,
                confirmation: "merge-delivery-pull-request",
                expectedHeads: [{ headSha, number: 42 }],
                idempotencyKey: "A".repeat(43),
                mergeStack: false,
                number: 42,
                operation: "merge-pull-request",
                sourceRevision,
            },
            {
                ...context,
                reauthorize: () => {
                    reauthorizations += 1;
                },
            }
        );
        expect(result).toEqual({
            jobRunId: runId,
            operation: "merge-pull-request",
            queued: true,
        });
        expect(reauthorizations).toBe(1);
        expect(next.queued).toEqual([
            {
                checkoutRevision: sourceRevision,
                expectedHeads: [{ headSha, number: 42 }],
                mergeStack: false,
                number: 42,
                operation: "merge-pull-request",
                sourceRevision,
            },
        ]);
        expect(next.audits).toHaveLength(2);
        expect(next.audits).toEqual([
            expect.objectContaining({ settlement: "attempted" }),
            expect.objectContaining({ jobRunId: runId, settlement: "queued" }),
        ]);
    });

    test("fails review approval closed when Raymond capability is unavailable", async () => {
        const value = payload("approve-review");
        value.reviewerCapability = {
            actor: "raymond",
            available: false,
            reason: "credential-missing",
            revision: sourceRevision,
        };
        const next = fixture(value);
        try {
            await next.service.approveReview(
                {
                    confirmation: "approve-delivery-review",
                    expectedHeadSha: headSha,
                    idempotencyKey: "A".repeat(43),
                    number: 42,
                    operation: "approve-review",
                    reviewerRevision: sourceRevision,
                    sourceRevision,
                },
                context
            );
            throw new Error("expected reviewer capability conflict");
        } catch (error) {
            expect(error).toBeInstanceOf(DeliveryServiceError);
            expect((error as DeliveryServiceError).reason).toBe("conflict");
        }
        expect(next.queued).toHaveLength(0);
    });

    test("does not enqueue an action denied by the authoritative head guard", async () => {
        const value = payload("reject");
        value.pullRequestGroups[0]!.members[0]!.actions[0] = {
            action: "reject",
            actor: "mira",
            available: false,
            reason: "head-guard-unavailable",
            scope: "self",
        };
        const next = fixture(value);

        try {
            await next.service.rejectPullRequest(
                {
                    confirmation: "reject-delivery-pull-request",
                    expectedHeadSha: headSha,
                    idempotencyKey: "A".repeat(43),
                    number: 42,
                    operation: "reject-pull-request",
                    sourceRevision,
                },
                context
            );
            throw new Error("expected authoritative capability conflict");
        } catch (error) {
            expect(error).toBeInstanceOf(DeliveryServiceError);
            expect((error as DeliveryServiceError).reason).toBe("conflict");
        }
        expect(next.queued).toHaveLength(0);
    });

    test("binds deploy to the authenticated remote main head while allowing an older clean checkout", () => {
        const remoteHeadSha = "d".repeat(40);
        const value = payload();
        value.checkout = {
            ...value.checkout,
            remoteHeadSha,
        };
        const candidate = publishedReleaseAuthority(
            remoteHeadSha,
            "v1.2.3",
            "c".repeat(40)
        );
        value.releases = {
            ...value.releases,
            candidate,
        };
        const next = fixture(value);

        expect(
            next.service.deploy(
                {
                    activationRevision: sourceRevision,
                    checkoutRevision: sourceRevision,
                    confirmation: "deploy-delivery-main",
                    expectedMainHeadSha: remoteHeadSha,
                    idempotencyKey: "A".repeat(43),
                    operation: "deploy",
                    release: candidate,
                    sourceRevision,
                },
                context
            )
        ).resolves.toMatchObject({ operation: "deploy", queued: true });
        expect(next.queued).toEqual([
            {
                activationRevision: sourceRevision,
                checkoutRevision: sourceRevision,
                expectedMainHeadSha: remoteHeadSha,
                operation: "deploy",
                release: candidate,
                sourceRevision,
            },
        ]);
    });

    test("derives the automation deploy from the same fresh authoritative snapshots", () => {
        const remoteHeadSha = "d".repeat(40);
        const value = payload();
        value.checkout = { ...value.checkout, remoteHeadSha };
        const candidate = publishedReleaseAuthority(remoteHeadSha);
        value.releases = { ...value.releases, candidate };
        const next = fixture(value);
        const automationContext = {
            actor: {
                authenticatorId: "018f6f50-6a9e-7b88-8000-000000000012",
                id: "production-deploy",
                kind: "automation" as const,
            },
            reauthorize() {},
            requestId: "automation-deploy-request",
        };

        expect(
            next.service.deployCurrent(
                {
                    confirmation: "deploy-delivery-main",
                    idempotencyKey: "A".repeat(43),
                },
                automationContext
            )
        ).resolves.toMatchObject({ operation: "deploy", queued: true });
        expect(next.queued).toEqual([
            {
                activationRevision: sourceRevision,
                checkoutRevision: sourceRevision,
                expectedMainHeadSha: remoteHeadSha,
                operation: "deploy",
                release: candidate,
                sourceRevision,
            },
        ]);
    });

    test("audits an automation deploy conflict before snapshot derivation fails", async () => {
        const next = fixture();
        const automationContext = {
            actor: {
                authenticatorId: "018f6f50-6a9e-7b88-8000-000000000012",
                id: "production-deploy",
                kind: "automation" as const,
            },
            reauthorize() {},
            requestId: "automation-deploy-conflict",
        };

        const failure = await next.service
            .deployCurrent(
                {
                    confirmation: "deploy-delivery-main",
                    idempotencyKey: "A".repeat(43),
                },
                automationContext
            )
            .catch((error: unknown) => error);
        expect(failure).toMatchObject({ reason: "conflict" });
        expect(next.queued).toHaveLength(0);
        expect(next.audits).toEqual([
            {
                actor: automationContext.actor,
                operation: "deploy",
                requestId: automationContext.requestId,
                settlement: "attempted",
            },
            {
                ...automationContext,
                operation: "deploy",
                settlement: "failed",
            },
        ]);
    });

    test("rejects a cached release candidate from a different remote main head", async () => {
        const remoteHeadSha = "d".repeat(40);
        const candidate = publishedReleaseAuthority("e".repeat(40));
        const value = payload();
        value.checkout = { ...value.checkout, remoteHeadSha };
        value.releases = { ...value.releases, candidate };
        const next = fixture(value);

        try {
            await next.service.deploy(
                {
                    activationRevision: sourceRevision,
                    checkoutRevision: sourceRevision,
                    confirmation: "deploy-delivery-main",
                    expectedMainHeadSha: remoteHeadSha,
                    idempotencyKey: "A".repeat(43),
                    operation: "deploy",
                    release: candidate,
                    sourceRevision,
                },
                context
            );
            throw new Error("expected release and remote head conflict");
        } catch (error) {
            expect(error).toBeInstanceOf(DeliveryServiceError);
            expect((error as DeliveryServiceError).reason).toBe("conflict");
        }
        expect(next.queued).toHaveLength(0);
    });

    test("binds a one-member merge to authoritative native-stack identity", () => {
        const value = payload();
        value.pullRequestGroups[0]!.kind = "native-stack";
        const native = fixture(value);
        const input = {
            checkoutRevision: sourceRevision,
            confirmation: "merge-delivery-pull-request" as const,
            expectedHeads: [{ headSha, number: 42 }],
            idempotencyKey: "A".repeat(43),
            mergeStack: true,
            number: 42,
            operation: "merge-pull-request" as const,
            sourceRevision,
        };

        expect(native.service.approvePullRequest(input, context)).resolves.toMatchObject({
            operation: "merge-pull-request",
            queued: true,
        });
        expect(
            fixture(value).service.approvePullRequest(
                { ...input, mergeStack: false },
                context
            )
        ).rejects.toMatchObject({ reason: "conflict" });
    });
});
