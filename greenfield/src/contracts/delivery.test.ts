import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    deliveryDeploymentSchema,
    deliveryOperationAuthoritySnapshotSchema,
    deliveryProcedureContracts,
    deliveryPullRequestsResultSchema,
    deliveryRequestOperationInputSchema,
} from "./delivery.ts";

const sha = "a".repeat(40);
const revision = "b".repeat(64);
const groupId = "c".repeat(64);
const idempotencyKey = "d".repeat(32);

function overviewPayload() {
    return {
        checkout: {
            branch: "main",
            condition: "ready" as const,
            expectedBranch: "main" as const,
            headSha: sha,
            remoteHeadSha: sha,
            revision,
            safeForDeploy: true,
            upstream: "origin/main",
        },
        observedAtMs: 1000,
        preview: {
            controlsAvailable: true,
            revision,
            status: "stopped" as const,
            updatedAtMs: 1000,
        },
        pullRequestGroups: [
            {
                id: groupId,
                kind: "standalone-mira" as const,
                members: [
                    {
                        actions: [
                            {
                                action: "merge" as const,
                                actor: "mira" as const,
                                available: true,
                                scope: "prefix" as const,
                            },
                        ],
                        additions: 4,
                        author: "mira-2026",
                        baseRef: "main",
                        changedFiles: 2,
                        checksState: "passed" as const,
                        createdAtMs: 900,
                        deletions: 1,
                        headRef: "feature",
                        headSha: sha,
                        isCrossRepository: false,
                        isDraft: false,
                        mergeState: "CLEAN",
                        mergeability: "mergeable" as const,
                        number: 42,
                        reviewState: "approved" as const,
                        title: "Feature",
                        updatedAtMs: 1000,
                        url: "https://github.com/rajohan/Mira-Dashboard/pull/42",
                    },
                ],
            },
        ],
        releases: {
            activationRevision: revision,
            rollback: {
                actor: "mira" as const,
                available: false as const,
                reason: "no-previous-release" as const,
            },
        },
        reviewerCapability: {
            actor: "raymond" as const,
            available: true as const,
            revision,
        },
        sourceRevision: revision,
    };
}

describe("Delivery contracts", () => {
    test("requires truthful terminal deployment outcomes", () => {
        const base = {
            jobRunId: "018f0000-0000-7000-8000-000000000001",
            operation: "merge-and-deploy",
            queuedAtMs: 1000,
            state: "succeeded",
            updatedAtMs: 2000,
        } as const;

        expect(
            v.safeParse(deliveryDeploymentSchema, {
                ...base,
                outcome: "enqueued",
            }).success
        ).toBe(true);
        expect(v.safeParse(deliveryDeploymentSchema, base).success).toBe(false);
        expect(
            v.safeParse(deliveryDeploymentSchema, {
                ...base,
                outcome: "completed-with-warnings",
            }).success
        ).toBe(false);
    });

    test("registers five reads and nine recent-MFA mutations", () => {
        expect(deliveryProcedureContracts).toHaveLength(14);
        expect(new Set(deliveryProcedureContracts.map(({ name }) => name)).size).toBe(14);
        expect(
            deliveryProcedureContracts.filter(({ kind }) => kind === "query")
        ).toHaveLength(5);
        const mutations = deliveryProcedureContracts.filter(
            ({ kind }) => kind === "mutation"
        );
        expect(mutations).toHaveLength(9);
        expect(mutations.every(({ access }) => access.kind === "recent-auth")).toBe(true);
    });

    test("accepts bounded operation authority and rejects cross-group duplicates", () => {
        expect(
            v.parse(deliveryOperationAuthoritySnapshotSchema, overviewPayload())
        ).toMatchObject({
            sourceRevision: revision,
        });
        const duplicate = overviewPayload();
        duplicate.pullRequestGroups.push({
            ...duplicate.pullRequestGroups[0]!,
            id: "e".repeat(64),
        });
        expect(() =>
            v.parse(deliveryOperationAuthoritySnapshotSchema, duplicate)
        ).toThrow();
    });

    test("requires actor-correct capability state and explicit reviewer availability", () => {
        const invalid = structuredClone(overviewPayload());
        Reflect.set(
            invalid.pullRequestGroups[0]!.members[0]!.actions[0]!,
            "actor",
            "raymond"
        );
        expect(() =>
            v.parse(deliveryOperationAuthoritySnapshotSchema, invalid)
        ).toThrow();
    });

    test("rejects stale freshness clocks that are not causal", () => {
        expect(() =>
            v.parse(deliveryPullRequestsResultSchema, {
                checkedAtMs: 2000,
                groups: overviewPayload().pullRequestGroups,
                observedAtMs: 1000,
                reviewerCapability: overviewPayload().reviewerCapability,
                sourceRevision: revision,
                staleSinceMs: 999,
                state: "last-known-good",
            })
        ).toThrow();
    });

    test("requires literal confirmation and exact selected stack prefix", () => {
        const input = {
            checkoutRevision: revision,
            confirmation: "merge-delivery-pull-request",
            deploy: false,
            expectedHeads: [
                { headSha: sha, number: 41 },
                { headSha: "f".repeat(40), number: 42 },
            ],
            idempotencyKey,
            mergeStack: true,
            number: 42,
            operation: "merge-pull-request",
            sourceRevision: revision,
        };
        expect(v.parse(deliveryRequestOperationInputSchema, input)).toEqual(input);
        expect(() =>
            v.parse(deliveryRequestOperationInputSchema, {
                ...input,
                confirmation: "merge",
            })
        ).toThrow();
        expect(() =>
            v.parse(deliveryRequestOperationInputSchema, { ...input, number: 41 })
        ).toThrow();
    });

    test("rejects unknown mutation keys and duplicate stack members", () => {
        expect(() =>
            v.parse(deliveryRequestOperationInputSchema, {
                confirmation: "create-delivery-stack",
                expectedHeads: [
                    { headSha: sha, number: 42 },
                    { headSha: "f".repeat(40), number: 42 },
                ],
                idempotencyKey,
                operation: "create-pull-request-stack",
                sourceRevision: revision,
            })
        ).toThrow();
        expect(() =>
            v.parse(deliveryRequestOperationInputSchema, {
                confirmation: "deploy-delivery-main",
                idempotencyKey,
                operation: "deploy",
                sourceRevision: revision,
                unexpected: true,
            })
        ).toThrow();
    });
});
