import { describe, expect, test } from "bun:test";

import type { DeliveryGitHubPullRequest } from "../../contracts/deliveryGithub.ts";
import {
    assertExpectedPullRequestScope,
    hasReviewerApproval,
    resolvePullRequestChecksState,
    resolvePullRequestReviewState,
    resolvePullRequestScope,
} from "./pullRequestScope.ts";

function pullRequest(
    number: number,
    overrides: Partial<DeliveryGitHubPullRequest> = {}
): DeliveryGitHubPullRequest {
    return {
        additions: 1,
        authorLogin: "mira-2026",
        baseRefName: "main",
        body: "body",
        changedFiles: 1,
        checks: [
            {
                conclusion: "SUCCESS",
                identity: "check:Dashboard",
                status: "COMPLETED",
            },
        ],
        checksComplete: true,
        createdAt: "2026-08-13T10:00:00.000Z",
        deletions: 0,
        headRefName: `mira/branch-${number}`,
        headSha: number.toString(16).padStart(40, "0"),
        isCrossRepository: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        number,
        reviews: [
            {
                authorLogin: "rajohan",
                state: "APPROVED",
                submittedAt: "2026-08-13T10:00:00.000Z",
            },
        ],
        state: "OPEN",
        title: `PR ${number}`,
        updatedAt: "2026-08-13T11:00:00.000Z",
        url: `https://github.com/rajohan/Mira-Dashboard/pull/${number}`,
        ...overrides,
    };
}

describe("Delivery pull-request policy", () => {
    test("uses the latest run per check identity and blocks incomplete context pages", () => {
        const pr = pullRequest(1, {
            checks: [
                {
                    completedAt: "2026-08-13T09:00:00.000Z",
                    conclusion: "FAILURE",
                    identity: "check:Dashboard",
                    status: "COMPLETED",
                },
                {
                    completedAt: "2026-08-13T10:00:00.000Z",
                    conclusion: "SUCCESS",
                    identity: "check:Dashboard",
                    status: "COMPLETED",
                },
            ],
        });
        expect(resolvePullRequestChecksState(pr)).toBe("passed");
        expect(resolvePullRequestChecksState({ ...pr, checksComplete: false })).toBe(
            "unknown"
        );
        expect(resolvePullRequestChecksState({ ...pr, checks: [] })).toBe("none");
    });

    test("gives a failure precedence over running and attention checks", () => {
        const pr = pullRequest(1, {
            checks: [
                {
                    identity: "check:First",
                    status: "IN_PROGRESS",
                },
                {
                    conclusion: "CANCELLED",
                    identity: "check:Second",
                    status: "COMPLETED",
                },
                {
                    conclusion: "FAILURE",
                    identity: "check:Third",
                    status: "COMPLETED",
                },
            ],
        });

        expect(resolvePullRequestChecksState(pr)).toBe("failed");
    });

    test("uses Raymond's latest opinionated review", () => {
        const pr = pullRequest(1, {
            reviews: [
                {
                    authorLogin: "rajohan",
                    state: "APPROVED",
                    submittedAt: "2026-08-13T09:00:00.000Z",
                },
                {
                    authorLogin: "rajohan",
                    state: "CHANGES_REQUESTED",
                    submittedAt: "2026-08-13T10:00:00.000Z",
                },
            ],
        });
        expect(hasReviewerApproval(pr)).toBeFalse();
    });

    test("does not retain an older changes-requested label after dismissal", () => {
        const pr = pullRequest(1, {
            reviewDecision: undefined,
            reviews: [
                {
                    authorLogin: "rajohan",
                    state: "CHANGES_REQUESTED",
                    submittedAt: "2026-08-13T09:00:00.000Z",
                },
                {
                    authorLogin: "rajohan",
                    state: "DISMISSED",
                    submittedAt: "2026-08-13T10:00:00.000Z",
                },
            ],
        });

        expect(resolvePullRequestReviewState(pr)).toBe("pending");
    });

    test("resolves complete inferred and native prefixes bottom through selected", () => {
        const bottom = pullRequest(1);
        const middle = pullRequest(2, { baseRefName: bottom.headRefName });
        const top = pullRequest(3, { baseRefName: middle.headRefName });
        const inferred = resolvePullRequestScope(3, [top, bottom, middle]);
        expect(inferred?.kind).toBe("inferred");
        expect(inferred?.members.map(({ number }) => number)).toEqual([1, 2, 3]);

        const nativeBottom = pullRequest(4, {
            stack: { baseRefName: "main", number: 10, position: 1, size: 3 },
        });
        const nativeMiddle = pullRequest(5, {
            baseRefName: nativeBottom.headRefName,
            stack: { baseRefName: "main", number: 10, position: 2, size: 3 },
        });
        const nativeTop = pullRequest(6, {
            baseRefName: nativeMiddle.headRefName,
            stack: { baseRefName: "main", number: 10, position: 3, size: 3 },
        });
        const native = resolvePullRequestScope(5, [
            nativeTop,
            nativeMiddle,
            nativeBottom,
        ]);
        expect(native?.kind).toBe("native");
        expect(native?.members.map(({ number }) => number)).toEqual([4, 5]);
    });

    test("keeps forks standalone and rejects stale ordered scope heads", () => {
        const fork = pullRequest(7, {
            headRefName: "main",
            isCrossRepository: true,
        });
        expect(resolvePullRequestScope(7, [fork])?.kind).toBe("ordinary");

        const scope = resolvePullRequestScope(1, [pullRequest(1)])!;
        expect(() =>
            assertExpectedPullRequestScope(scope, [
                { headSha: "f".repeat(40), number: 1 },
            ])
        ).toThrow();
    });

    test("keeps branching or incomplete inferred chains read-only", () => {
        const bottom = pullRequest(1);
        const left = pullRequest(2, { baseRefName: bottom.headRefName });
        const right = pullRequest(3, { baseRefName: bottom.headRefName });

        expect(resolvePullRequestScope(2, [bottom, left, right])).toBeUndefined();
        expect(resolvePullRequestScope(1, [bottom, left])).toBeUndefined();
    });
});
