import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { publishedReleaseAuthority } from "../testSupport/publishedReleaseAuthority.ts";
import {
    deliveryGitHubActionKey,
    deliveryJobActionKeyForPayload,
    deliveryJobOperationResultSchema,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
    parseDeliveryOperationJobPayload,
} from "./deliveryWorker.ts";

const sha = "a".repeat(40);
const revision = "b".repeat(64);

describe("Delivery worker contract", () => {
    test("routes ordinary, preview, and versioned production payloads exactly", () => {
        const github = parseDeliveryOperationJobPayload({
            expectedHeadSha: sha,
            number: 42,
            operation: "update-branch",
            sourceRevision: revision,
        });
        const preview = parseDeliveryOperationJobPayload({
            number: 42,
            operation: "stop-preview",
            previewRevision: revision,
            sourceRevision: revision,
        });
        const production = parseDeliveryOperationJobPayload({
            activationRevision: revision,
            checkoutRevision: revision,
            expectedMainHeadSha: sha,
            operation: "deploy",
            release: publishedReleaseAuthority(sha),
            sourceRevision: revision,
        });
        expect(deliveryJobActionKeyForPayload(github)).toBe(deliveryGitHubActionKey);
        expect(deliveryJobActionKeyForPayload(preview)).toBe(deliveryPreviewActionKey);
        expect(deliveryJobActionKeyForPayload(production)).toBe("delivery.production.v1");
        expect(deliveryProductionActionKey).toBe("delivery.production.v1");
    });

    test("routes pull request merges only to GitHub authority", () => {
        const base = {
            checkoutRevision: revision,
            expectedHeads: [{ headSha: sha, number: 42 }],
            mergeStack: false,
            number: 42,
            operation: "merge-pull-request" as const,
            sourceRevision: revision,
        };
        expect(
            deliveryJobActionKeyForPayload(parseDeliveryOperationJobPayload(base))
        ).toBe(deliveryGitHubActionKey);
        expect(() =>
            parseDeliveryOperationJobPayload({ ...base, deploy: true })
        ).toThrow();
    });

    test("rejects confirmations, idempotency keys, secrets, and arbitrary commands", () => {
        for (const extra of [
            { confirmation: "deploy-delivery-main" },
            { idempotencyKey: "x".repeat(32) },
            { token: "secret" },
            { argv: ["bash"] },
        ]) {
            expect(() =>
                parseDeliveryOperationJobPayload({
                    activationRevision: revision,
                    checkoutRevision: revision,
                    expectedMainHeadSha: sha,
                    operation: "deploy",
                    release: publishedReleaseAuthority(sha),
                    sourceRevision: revision,
                    ...extra,
                })
            ).toThrow();
        }
    });

    test("requires the selected pull request to end an ordered scope", () => {
        expect(() =>
            parseDeliveryOperationJobPayload({
                checkoutRevision: revision,
                expectedHeads: [{ headSha: sha, number: 42 }],
                mergeStack: false,
                number: 41,
                operation: "merge-pull-request",
                sourceRevision: revision,
            })
        ).toThrow();
    });

    test("requires warnings if and only if the result reports warnings", () => {
        expect(() =>
            v.parse(deliveryJobOperationResultSchema, {
                operation: "deploy",
                outcome: "completed-with-warnings",
            })
        ).toThrow();
        expect(() =>
            v.parse(deliveryJobOperationResultSchema, {
                operation: "deploy",
                outcome: "completed",
                warnings: ["main-sync-failed"],
            })
        ).toThrow();
        expect(
            v.parse(deliveryJobOperationResultSchema, {
                operation: "deploy",
                outcome: "completed-with-warnings",
                warnings: ["main-sync-failed"],
            })
        ).toEqual({
            operation: "deploy",
            outcome: "completed-with-warnings",
            warnings: ["main-sync-failed"],
        });
    });
});
