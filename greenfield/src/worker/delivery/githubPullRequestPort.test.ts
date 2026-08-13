import { describe, expect, test } from "bun:test";

import type { DeliveryGitHubActor } from "../../contracts/deliveryGithub.ts";
import {
    DeliveryGitHubError,
    type DeliveryGitHubHttpOperation,
    type DeliveryGitHubHttpTransport,
} from "./githubHttpTransport.ts";
import { createDeliveryGitHubPullRequestPort } from "./githubPullRequestPort.ts";
import { createDeliveryGitHubReviewerPort } from "./githubReviewer.ts";

const head = "a".repeat(40);
const mergedMainHead = "b".repeat(40);

function rawPullRequest(state: "MERGED" | "OPEN" = "OPEN", approved = true) {
    return {
        additions: 2,
        author: { login: "mira-2026" },
        baseRefName: "main",
        body: "Delivery body",
        changedFiles: 1,
        createdAt: "2026-08-13T10:00:00.000Z",
        deletions: 1,
        headRefName: "mira/delivery",
        headRefOid: head,
        isCrossRepository: false,
        isDraft: false,
        latestOpinionatedReviews: {
            nodes: approved
                ? [
                      {
                          author: { login: "rajohan" },
                          state: "APPROVED",
                          submittedAt: "2026-08-13T10:30:00.000Z",
                      },
                  ]
                : [],
        },
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
        mergeCommit: state === "MERGED" ? { oid: mergedMainHead } : null,
        number: 12,
        reviewDecision: approved ? "APPROVED" : null,
        stack: null,
        stackEntry: null,
        state,
        statusCheckRollup: {
            contexts: {
                nodes: [
                    {
                        __typename: "CheckRun",
                        checkSuite: {
                            workflowRun: { workflow: { name: "Dashboard checks" } },
                        },
                        completedAt: "2026-08-13T10:20:00.000Z",
                        conclusion: "SUCCESS",
                        name: "bun",
                        startedAt: "2026-08-13T10:10:00.000Z",
                        status: "COMPLETED",
                    },
                ],
                pageInfo: { hasNextPage: false },
            },
        },
        title: "Delivery",
        updatedAt: "2026-08-13T11:00:00.000Z",
        url: "https://github.com/rajohan/Mira-Dashboard/pull/12",
    };
}

function actor(login: "mira-2026" | "rajohan"): DeliveryGitHubActor {
    return { id: login === "mira-2026" ? 1 : 2, login, type: "User" };
}

function transport(
    login: "mira-2026" | "rajohan",
    request: (operation: DeliveryGitHubHttpOperation) => unknown
): DeliveryGitHubHttpTransport {
    return {
        actor: login,
        requestJson: (operation) => Promise.resolve(request(operation)),
        requestJsonWithStatus: (operation) =>
            Promise.resolve({
                body: request(operation),
                status: operation.kind === "pull-request-update-branch" ? 202 : 200,
            }),
        verifyIdentity: () => Promise.resolve(actor(login)),
    };
}

function graphQlResponse(
    operation: DeliveryGitHubHttpOperation,
    state: "MERGED" | "OPEN" = "OPEN",
    approved = true
) {
    if (operation.kind !== "graphql") throw new Error("Expected GraphQL");
    if (operation.document.includes("query DeliveryStackCapability")) {
        return {
            data: {
                __type: { fields: [{ name: "stack" }, { name: "stackEntry" }] },
            },
        };
    }
    if (operation.document.includes("pullRequests(")) {
        return {
            data: {
                repository: {
                    pullRequests: {
                        nodes: [rawPullRequest(state, approved)],
                        pageInfo: { endCursor: null, hasNextPage: false },
                    },
                },
            },
        };
    }
    return {
        data: { repository: { pullRequest: rawPullRequest(state, approved) } },
    };
}

describe("Delivery GitHub pull-request port", () => {
    test("lists a bounded normalized PR projection through Mira", async () => {
        const operations: string[] = [];
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                operations.push(operation.kind);
                return graphQlResponse(operation);
            }),
        });

        const result = await port.listOpenPullRequests();

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            checksComplete: true,
            headSha: head,
            number: 12,
            state: "OPEN",
        });
        expect(result[0]?.checks[0]?.identity).toBe("check:Dashboard checks:bun");
        expect(operations).toEqual(["graphql", "graphql"]);
    });

    test("revalidates an ordinary exact head and safely deletes only its matching branch", () => {
        let merged = false;
        const operations: string[] = [];
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                operations.push(operation.kind);
                if (operation.kind === "graphql") {
                    return graphQlResponse(operation, merged ? "MERGED" : "OPEN");
                }
                if (operation.kind === "native-stack-find") return [];
                if (operation.kind === "pull-request-merge") {
                    merged = true;
                    return { merged: true, message: "merged", sha: mergedMainHead };
                }
                if (operation.kind === "branch-ref") {
                    return { object: { sha: head, type: "commit" } };
                }
                if (operation.kind === "branch-delete") return null;
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(port.mergePullRequest({ headSha: head, number: 12 })).resolves.toEqual({
            mainHeadSha: mergedMainHead,
            outcome: "completed",
        });
        expect(operations).toContain("pull-request-merge");
        expect(operations.at(-1)).toBe("branch-delete");
    });

    test("keeps Raymond approval physically separate and validates Mira readback", () => {
        let approved = false;
        const normalizedPort = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind !== "graphql") throw new Error("Unexpected");
                return graphQlResponse(operation, "OPEN", approved);
            }),
        });
        const reviewer = createDeliveryGitHubReviewerPort({
            readPort: normalizedPort,
            reviewerTransport: transport("rajohan", (operation) => {
                expect(operation.kind).toBe("pull-request-review-approve");
                approved = true;
                return { commit_id: head, state: "APPROVED", user: { login: "rajohan" } };
            }),
        });

        expect(reviewer.approveReview({ headSha: head, number: 12 })).resolves.toEqual({
            outcome: "completed",
        });
        expect(approved).toBeTrue();
    });

    test("refuses Raymond approval outside a complete main-rooted scope", () => {
        const offMain = { ...rawPullRequest("OPEN", false), baseRefName: "unrelated" };
        const normalizedPort = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind !== "graphql") throw new Error("Unexpected");
                if (operation.document.includes("query DeliveryStackCapability")) {
                    return {
                        data: {
                            __type: {
                                fields: [{ name: "stack" }, { name: "stackEntry" }],
                            },
                        },
                    };
                }
                if (operation.document.includes("pullRequests(")) {
                    return {
                        data: {
                            repository: {
                                pullRequests: {
                                    nodes: [offMain],
                                    pageInfo: {
                                        endCursor: null,
                                        hasNextPage: false,
                                    },
                                },
                            },
                        },
                    };
                }
                return { data: { repository: { pullRequest: offMain } } };
            }),
        });
        let reviewCalled = false;
        const reviewer = createDeliveryGitHubReviewerPort({
            readPort: normalizedPort,
            reviewerTransport: transport("rajohan", () => {
                reviewCalled = true;
                return {};
            }),
        });

        expect(
            reviewer.approveReview({ headSha: head, number: 12 })
        ).rejects.toBeInstanceOf(DeliveryGitHubError);
        expect(reviewCalled).toBeFalse();
    });

    test("revalidates a native exact prefix and polls its attributed merge result", () => {
        let merged = false;
        const operations: string[] = [];
        const port = createDeliveryGitHubPullRequestPort({
            pollIntervalMs: 1,
            transport: transport("mira-2026", (operation) => {
                operations.push(operation.kind);
                if (operation.kind === "graphql") {
                    if (operation.document.includes("query DeliveryStackCapability")) {
                        return {
                            data: {
                                __type: {
                                    fields: [{ name: "stack" }, { name: "stackEntry" }],
                                },
                            },
                        };
                    }
                    const row = {
                        ...rawPullRequest(merged ? "MERGED" : "OPEN"),
                        stack: { baseRefName: "main", number: 9, size: 1 },
                        stackEntry: { position: 1 },
                    };
                    return { data: { repository: { pullRequest: row } } };
                }
                if (operation.kind === "native-stack-find") {
                    return [
                        {
                            base: { ref: "main" },
                            id: 9,
                            number: 9,
                            open: true,
                            pull_requests: [
                                {
                                    draft: false,
                                    head: { ref: "mira/delivery", sha: head },
                                    merged_at: null,
                                    number: 12,
                                    state: "open",
                                },
                            ],
                        },
                    ];
                }
                if (operation.kind === "native-stack-merge-start") {
                    return {
                        details: {
                            expected_head_sha: head,
                            merge_action: "default",
                            merge_method: "squash",
                            message: "pending",
                            uuid: "merge-1",
                        },
                        status: "pending",
                    };
                }
                if (operation.kind === "native-stack-merge-poll") {
                    merged = true;
                    return {
                        details: { message: "merged", sha: mergedMainHead },
                        status: "merged",
                    };
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(port.mergeNativeStack([{ headSha: head, number: 12 }])).resolves.toEqual({
            mainHeadSha: mergedMainHead,
            outcome: "completed",
        });
        expect(operations).toContain("native-stack-merge-start");
        expect(operations).toContain("native-stack-merge-poll");
    });

    test("binds a complete native prefix to the selected layer's merge commit", () => {
        const bottomHead = "c".repeat(40);
        const bottomMergeHead = "d".repeat(40);
        let merged = false;
        const row = (number: number) => ({
            ...rawPullRequest(merged ? "MERGED" : "OPEN"),
            headRefName: number === 11 ? "mira/bottom" : "mira/delivery",
            headRefOid: number === 11 ? bottomHead : head,
            mergeCommit: merged
                ? { oid: number === 11 ? bottomMergeHead : mergedMainHead }
                : null,
            number,
            stack: { baseRefName: "main", number: 9, size: 2 },
            stackEntry: { position: number === 11 ? 1 : 2 },
        });
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "graphql") {
                    if (operation.document.includes("query DeliveryStackCapability")) {
                        return {
                            data: {
                                __type: {
                                    fields: [{ name: "stack" }, { name: "stackEntry" }],
                                },
                            },
                        };
                    }
                    return {
                        data: {
                            repository: {
                                pullRequest: row(Number(operation.variables.number)),
                            },
                        },
                    };
                }
                if (operation.kind === "native-stack-find") {
                    return [
                        {
                            base: { ref: "main" },
                            id: 9,
                            number: 9,
                            open: true,
                            pull_requests: [
                                {
                                    draft: false,
                                    head: { ref: "mira/bottom", sha: bottomHead },
                                    merged_at: null,
                                    number: 11,
                                    state: "open",
                                },
                                {
                                    draft: false,
                                    head: { ref: "mira/delivery", sha: head },
                                    merged_at: null,
                                    number: 12,
                                    state: "open",
                                },
                            ],
                        },
                    ];
                }
                if (operation.kind === "native-stack-merge-start") {
                    merged = true;
                    return {
                        details: { message: "merged", sha: mergedMainHead },
                        status: "merged",
                    };
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.mergeNativeStack([
                { headSha: bottomHead, number: 11 },
                { headSha: head, number: 12 },
            ])
        ).resolves.toEqual({
            mainHeadSha: mergedMainHead,
            outcome: "completed",
        });
    });

    test("rejects a closed unmerged lower stack layer before mutation", () => {
        let mergeCalled = false;
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "graphql") {
                    return {
                        data: {
                            __type: {
                                fields: [{ name: "stack" }, { name: "stackEntry" }],
                            },
                        },
                    };
                }
                if (operation.kind === "native-stack-find") {
                    return [
                        {
                            base: { ref: "main" },
                            id: 9,
                            number: 9,
                            open: true,
                            pull_requests: [
                                {
                                    draft: false,
                                    head: { ref: "mira/lower", sha: "b".repeat(40) },
                                    merged_at: null,
                                    number: 11,
                                    state: "closed",
                                },
                                {
                                    draft: false,
                                    head: { ref: "mira/delivery", sha: head },
                                    merged_at: null,
                                    number: 12,
                                    state: "open",
                                },
                            ],
                        },
                    ];
                }
                if (operation.kind === "native-stack-merge-start") {
                    mergeCalled = true;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.mergeNativeStack([{ headSha: head, number: 12 }])
        ).rejects.toBeInstanceOf(DeliveryGitHubError);
        expect(mergeCalled).toBeFalse();
    });

    test("revalidates trusted authors for native stack merge", () => {
        let mergeCalled = false;
        const external = {
            ...rawPullRequest(),
            author: { login: "external-contributor" },
            stack: { baseRefName: "main", number: 9, size: 1 },
            stackEntry: { position: 1 },
        };
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "graphql") {
                    if (operation.document.includes("query DeliveryStackCapability")) {
                        return {
                            data: {
                                __type: {
                                    fields: [{ name: "stack" }, { name: "stackEntry" }],
                                },
                            },
                        };
                    }
                    return { data: { repository: { pullRequest: external } } };
                }
                if (operation.kind === "native-stack-find") {
                    return [
                        {
                            base: { ref: "main" },
                            id: 9,
                            number: 9,
                            open: true,
                            pull_requests: [
                                {
                                    draft: false,
                                    head: { ref: "external/delivery", sha: head },
                                    merged_at: null,
                                    number: 12,
                                    state: "open",
                                },
                            ],
                        },
                    ];
                }
                if (operation.kind === "native-stack-merge-start") {
                    mergeCalled = true;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.mergeNativeStack([{ headSha: head, number: 12 }])
        ).rejects.toBeInstanceOf(DeliveryGitHubError);
        expect(mergeCalled).toBeFalse();
    });

    test("creates only the complete exact inferred chain", () => {
        const bottomHead = "b".repeat(40);
        const bottom = {
            ...rawPullRequest(),
            headRefName: "mira/bottom",
            headRefOid: bottomHead,
            number: 11,
            url: "https://github.com/rajohan/Mira-Dashboard/pull/11",
        };
        const top = {
            ...rawPullRequest(),
            baseRefName: bottom.headRefName,
        };
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "graphql") {
                    if (operation.document.includes("query DeliveryStackCapability")) {
                        return {
                            data: {
                                __type: {
                                    fields: [{ name: "stack" }, { name: "stackEntry" }],
                                },
                            },
                        };
                    }
                    if (operation.document.includes("pullRequests(")) {
                        return {
                            data: {
                                repository: {
                                    pullRequests: {
                                        nodes: [top, bottom],
                                        pageInfo: { endCursor: null, hasNextPage: false },
                                    },
                                },
                            },
                        };
                    }
                    return {
                        data: {
                            repository: {
                                pullRequest:
                                    operation.variables.number === 11 ? bottom : top,
                            },
                        },
                    };
                }
                if (operation.kind === "native-stack-create") {
                    expect(operation.pullRequestNumbers).toEqual([11, 12]);
                    return {
                        base: { ref: "main" },
                        id: 9,
                        number: 9,
                        open: true,
                        pull_requests: [
                            {
                                draft: false,
                                head: { ref: bottom.headRefName, sha: bottomHead },
                                merged_at: null,
                                number: 11,
                                state: "open",
                            },
                            {
                                draft: false,
                                head: { ref: top.headRefName, sha: head },
                                merged_at: null,
                                number: 12,
                                state: "open",
                            },
                        ],
                    };
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.createNativeStack([
                { headSha: bottomHead, number: 11 },
                { headSha: head, number: 12 },
            ])
        ).resolves.toMatchObject({
            number: 9,
            pullRequests: [
                { headSha: bottomHead, number: 11 },
                { headSha: head, number: 12 },
            ],
        });
    });

    test("reports GitHub's asynchronous update-branch acceptance as enqueued", () => {
        const behind = { ...rawPullRequest(), mergeStateStatus: "BEHIND" };
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "graphql") {
                    if (operation.document.includes("query DeliveryStackCapability")) {
                        return {
                            data: {
                                __type: {
                                    fields: [{ name: "stack" }, { name: "stackEntry" }],
                                },
                            },
                        };
                    }
                    if (operation.document.includes("pullRequests(")) {
                        return {
                            data: {
                                repository: {
                                    pullRequests: {
                                        nodes: [behind],
                                        pageInfo: {
                                            endCursor: null,
                                            hasNextPage: false,
                                        },
                                    },
                                },
                            },
                        };
                    }
                    return { data: { repository: { pullRequest: behind } } };
                }
                if (operation.kind === "native-stack-find") return [];
                if (operation.kind === "pull-request-update-branch") {
                    return {
                        message: "Updating pull request branch",
                        url: "https://api.github.test/update",
                    };
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.updatePullRequestBranch({ headSha: head, number: 12 })
        ).resolves.toEqual({ outcome: "enqueued" });
    });

    test("refuses to compose the ordinary port with Raymond authority", () => {
        expect(() =>
            createDeliveryGitHubPullRequestPort({
                transport: transport("rajohan", () => ({})),
            })
        ).toThrow(DeliveryGitHubError);
    });
});
