import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    deliveryGitHubExpectedHeadsSchema,
    deliveryGitHubPullRequestBodyMaximumBytes,
    deliveryGitHubPullRequestSchema,
    parseDeliveryGitHubExpectedHead,
} from "./deliveryGithub.ts";

const headA = "a".repeat(40);
const headB = "b".repeat(40);

describe("Delivery GitHub contracts", () => {
    test("accepts only full exact pull-request heads and unique ordered stack members", () => {
        expect(
            v.parse(deliveryGitHubExpectedHeadsSchema, [
                { headSha: headA, number: 12 },
                { headSha: headB, number: 13 },
            ])
        ).toEqual([
            { headSha: headA, number: 12 },
            { headSha: headB, number: 13 },
        ]);
        expect(() =>
            parseDeliveryGitHubExpectedHead({ headSha: "ABC", number: 12 })
        ).toThrow();
        expect(
            v.safeParse(deliveryGitHubExpectedHeadsSchema, [
                { headSha: headA, number: 12 },
                { headSha: headB, number: 12 },
            ]).success
        ).toBeFalse();
    });

    test("keeps the provider projection bounded and rejects non-GitHub links", () => {
        const pullRequest = {
            additions: 1,
            baseRefName: "main",
            body: "body",
            changedFiles: 1,
            checks: [],
            checksComplete: true,
            createdAt: "2026-08-13T10:00:00.000Z",
            deletions: 0,
            headRefName: "mira/topic",
            headSha: headA,
            isCrossRepository: false,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            number: 12,
            reviews: [],
            state: "OPEN",
            title: "Delivery",
            updatedAt: "2026-08-13T11:00:00.000Z",
            url: "https://github.com/rajohan/Mira-Dashboard/pull/12",
        };
        expect(v.parse(deliveryGitHubPullRequestSchema, pullRequest)).toEqual(
            pullRequest
        );
        expect(
            v.safeParse(deliveryGitHubPullRequestSchema, {
                ...pullRequest,
                body: "x".repeat(deliveryGitHubPullRequestBodyMaximumBytes + 1),
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(deliveryGitHubPullRequestSchema, {
                ...pullRequest,
                url: "https://example.com/pull/12",
            }).success
        ).toBeFalse();
    });
});
