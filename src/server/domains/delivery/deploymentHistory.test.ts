import { describe, expect, test } from "bun:test";

import { createDeliveryDeploymentHistoryReader } from "./deploymentHistory.ts";

const sha = "a".repeat(40);
const revision = "b".repeat(64);

describe("Delivery deployment history", () => {
    test("queries only the versioned production action and sanitizes rows", () => {
        const calls: unknown[] = [];
        const reader = createDeliveryDeploymentHistoryReader({
            nowMs: () => 3000,
            repository: {
                listByActionKey(actionKey, limit) {
                    calls.push([actionKey, limit]);
                    return [
                        {
                            actionKey: "delivery.production.v1",
                            id: "018f0000-0000-7000-8000-000000000001",
                            payloadJson: JSON.stringify({
                                activationRevision: revision,
                                checkoutRevision: revision,
                                expectedMainHeadSha: sha,
                                operation: "deploy",
                                sourceRevision: revision,
                            }),
                            queuedAt: new Date(1000),
                            resultJson: JSON.stringify({
                                completedAtMs: 2000,
                                operation: "deploy",
                                outcome: "completed",
                                postSettlementWarnings: [
                                    "delivery-overview-refresh-failed",
                                ],
                                releaseId: sha,
                            }),
                            state: "succeeded",
                            terminalMessage: "Deployment completed",
                            updatedAt: new Date(2000),
                        },
                    ];
                },
            },
        });
        expect(reader.read()).toEqual({
            checkedAtMs: 3000,
            deployments: [
                {
                    commitSha: sha,
                    jobRunId: "018f0000-0000-7000-8000-000000000001",
                    note: "Deployment completed",
                    operation: "deploy",
                    outcome: "completed",
                    postSettlementWarnings: ["delivery-overview-refresh-failed"],
                    queuedAtMs: 1000,
                    state: "succeeded",
                    updatedAtMs: 2000,
                },
            ],
            state: "fresh",
        });
        expect(calls).toEqual([["delivery.production.v1", 10]]);
    });

    test("fails closed for a wrong action or non-production payload", () => {
        const reader = createDeliveryDeploymentHistoryReader({
            nowMs: () => 3000,
            repository: {
                listByActionKey: () => [
                    {
                        actionKey: "delivery.github",
                        id: "018f0000-0000-7000-8000-000000000001",
                        payloadJson: "{}",
                        queuedAt: new Date(1000),
                        resultJson: null,
                        state: "failed",
                        terminalMessage: "secret provider failure",
                        updatedAt: new Date(2000),
                    },
                ],
            },
        });
        expect(reader.read()).toEqual({ checkedAtMs: 3000, state: "unavailable" });
    });

    test("retains enqueued and partial production outcomes instead of projecting green success", () => {
        const payload = JSON.stringify({
            activationRevision: revision,
            checkoutRevision: revision,
            deploy: true,
            expectedHeads: [{ headSha: sha, number: 42 }],
            mergeStack: false,
            number: 42,
            operation: "merge-pull-request",
            sourceRevision: revision,
        });
        const reader = createDeliveryDeploymentHistoryReader({
            nowMs: () => 4000,
            repository: {
                listByActionKey: () => [
                    {
                        actionKey: "delivery.production.v1",
                        id: "018f0000-0000-7000-8000-000000000002",
                        payloadJson: payload,
                        queuedAt: new Date(1000),
                        resultJson: JSON.stringify({
                            operation: "merge-pull-request",
                            outcome: "enqueued",
                        }),
                        state: "succeeded",
                        terminalMessage: null,
                        updatedAt: new Date(3000),
                    },
                    {
                        actionKey: "delivery.production.v1",
                        id: "018f0000-0000-7000-8000-000000000003",
                        payloadJson: payload,
                        queuedAt: new Date(1000),
                        resultJson: JSON.stringify({
                            operation: "merge-pull-request",
                            outcome: "completed-with-warnings",
                            warnings: ["deployment-not-started"],
                        }),
                        state: "succeeded",
                        terminalMessage: null,
                        updatedAt: new Date(2000),
                    },
                ],
            },
        });

        const result = reader.read();
        expect(result.state).toBe("fresh");
        if (result.state !== "fresh") throw new Error("Expected fresh history");
        expect(
            result.deployments.map((deployment) => ({
                outcome: "outcome" in deployment ? deployment.outcome : undefined,
                warnings: "warnings" in deployment ? deployment.warnings : undefined,
            }))
        ).toEqual([
            { outcome: "enqueued", warnings: undefined },
            {
                outcome: "completed-with-warnings",
                warnings: ["deployment-not-started"],
            },
        ]);
    });
});
