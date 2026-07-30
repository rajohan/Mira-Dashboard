import { describe, expect, it } from "bun:test";

import type { PullRequestSummary } from "../../../contracts/delivery";
import {
    derivePullRequestStackCandidates,
    groupNativePullRequestStacks,
    indexPullRequestStackCandidates,
    pullRequestStackMergeGroup,
} from "../components/features/delivery/pullRequestStacks";

function pullRequest(
    number: number,
    headRefName: string,
    baseRefName: string,
    overrides: Partial<PullRequestSummary> = {}
): PullRequestSummary {
    return {
        baseRefName,
        createdAt: `2026-07-30T10:${String(number).padStart(2, "0")}:00.000Z`,
        headRefName,
        headRefOid: String(number).padStart(40, "0"),
        isDraft: false,
        number,
        title: `PR ${number}`,
        updatedAt: `2026-07-30T11:${String(number).padStart(2, "0")}:00.000Z`,
        url: `https://github.test/pull/${number}`,
        ...overrides,
    };
}

describe("Delivery pull request stacks", () => {
    it("derives only complete unambiguous linear stack candidates", () => {
        const chain = [
            pullRequest(1, "models", "main"),
            pullRequest(2, "api", "models"),
            pullRequest(3, "ui", "api"),
        ];
        const candidates = derivePullRequestStackCandidates(
            [
                ...chain,
                pullRequest(4, "parallel-a", "models"),
                pullRequest(5, "parallel-b", "models"),
                pullRequest(6, "already-stacked", "main", {
                    stack: {
                        baseRefName: "main",
                        number: 42,
                        position: 1,
                        size: 2,
                    },
                }),
            ],
            "main"
        );

        expect(candidates).toEqual([]);
        const linearCandidates = derivePullRequestStackCandidates(chain, "main");
        expect(linearCandidates).toHaveLength(1);
        expect(linearCandidates[0]?.pullRequests.map((entry) => entry.number)).toEqual([
            1, 2, 3,
        ]);
        expect(indexPullRequestStackCandidates(linearCandidates).get(3)).toMatchObject({
            position: 3,
        });
    });

    it("groups native stacks bottom-to-top and merges only through the selected layer", () => {
        const stack360 = [
            pullRequest(353, "state-machine", "canonical", {
                stack: {
                    baseRefName: "main",
                    number: 360,
                    position: 2,
                    size: 3,
                },
            }),
            pullRequest(352, "canonical", "main", {
                stack: {
                    baseRefName: "main",
                    number: 360,
                    position: 1,
                    size: 3,
                },
            }),
            pullRequest(354, "contract", "state-machine", {
                stack: {
                    baseRefName: "main",
                    number: 360,
                    position: 3,
                    size: 3,
                },
            }),
        ];
        const otherStack = [
            pullRequest(400, "other-bottom", "main", {
                updatedAt: "2026-07-30T09:00:00.000Z",
                stack: {
                    baseRefName: "main",
                    number: 401,
                    position: 1,
                    size: 1,
                },
            }),
        ];

        const groups = groupNativePullRequestStacks([...otherStack, ...stack360]);
        expect(groups.map((group) => group.number)).toEqual([360, 401]);
        expect(groups[0]?.pullRequests.map((entry) => entry.number)).toEqual([
            352, 353, 354,
        ]);
        expect(
            pullRequestStackMergeGroup(stack360[0] as PullRequestSummary, stack360).map(
                (entry) => entry.number
            )
        ).toEqual([352, 353]);
    });
});
