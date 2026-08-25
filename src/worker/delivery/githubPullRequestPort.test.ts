import { describe, expect, test } from "bun:test";

import type { DeliveryGitHubActor } from "../../contracts/deliveryGithub.ts";
import { maximumProductionReleaseReceiptBytes } from "../../shared/productionReleaseArtifactReceipt.ts";
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
    test("admits only the permanent asset pair for the latest stable release", () => {
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "release-tag-commit") {
                    expect(operation.tagName).toBe("v1.2.3");
                    return { sha: head };
                }
                if (operation.kind === "release-asset") {
                    expect(operation.assetId).toBe(1);
                    return {
                        archive: {
                            bytes: 4096,
                            name: "release.tar",
                            sha256: "c".repeat(64),
                        },
                        formatVersion: 1,
                        releaseId: head,
                        releaseManifestSha256: "d".repeat(64),
                        runtime: { revision: "e".repeat(40), version: "1.4.0" },
                    };
                }
                if (operation.kind !== "latest-release") throw new Error("unexpected");
                return {
                    assets: [
                        {
                            digest: `sha256:${"b".repeat(64)}`,
                            id: 1,
                            name: "receipt.json",
                            size: 512,
                        },
                        {
                            digest: `sha256:${"c".repeat(64)}`,
                            id: 2,
                            name: "release.tar",
                            size: 4096,
                        },
                    ],
                    draft: false,
                    prerelease: false,
                    tag_name: "v1.2.3",
                    target_commitish: "main",
                };
            }),
        });

        expect(port.readLatestPublishedRelease?.()).resolves.toEqual({
            assets: [
                {
                    digest: `sha256:${"b".repeat(64)}`,
                    name: "receipt.json",
                    size: 512,
                },
                {
                    digest: `sha256:${"c".repeat(64)}`,
                    name: "release.tar",
                    size: 4096,
                },
            ],
            releaseId: head,
            releaseManifestSha256: "d".repeat(64),
            runtime: { revision: "e".repeat(40), version: "1.4.0" },
            tagName: "v1.2.3",
        });
    });

    test.each([
        {
            assets: [
                {
                    digest: `sha256:${"b".repeat(64)}`,
                    id: 1,
                    name: "receipt.json",
                    size: 512,
                },
            ],
            draft: false,
            prerelease: false,
            tag_name: "v1.2.3",
            target_commitish: head,
        },
        {
            assets: [
                {
                    digest: `sha256:${"b".repeat(64)}`,
                    id: 1,
                    name: "receipt.json",
                    size: 512,
                },
                {
                    digest: `sha256:${"c".repeat(64)}`,
                    id: 2,
                    name: "release.tar",
                    size: 4096,
                },
            ],
            draft: false,
            prerelease: true,
            tag_name: "v1.2.3-rc.1",
            target_commitish: head,
        },
    ])("rejects an incomplete or prerelease publication", (release) => {
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind !== "latest-release") throw new Error("unexpected");
                return release;
            }),
        });

        expect(port.readLatestPublishedRelease?.()).rejects.toBeInstanceOf(
            DeliveryGitHubError
        );
    });

    test("rejects an oversized receipt before downloading release bytes", async () => {
        const operations: string[] = [];
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                operations.push(operation.kind);
                if (operation.kind !== "latest-release") {
                    throw new Error("unexpected release read");
                }
                return {
                    assets: [
                        {
                            digest: `sha256:${"b".repeat(64)}`,
                            id: 1,
                            name: "receipt.json",
                            size: maximumProductionReleaseReceiptBytes + 1,
                        },
                        {
                            digest: `sha256:${"c".repeat(64)}`,
                            id: 2,
                            name: "release.tar",
                            size: 4096,
                        },
                    ],
                    draft: false,
                    prerelease: false,
                    tag_name: "v1.2.3",
                    target_commitish: head,
                };
            }),
        });

        const failure = await port.readLatestPublishedRelease?.().then(
            () => null,
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(DeliveryGitHubError);
        expect(operations).toEqual(["latest-release"]);
    });

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

    test("merges an exact ordinary head but retains its observed branch without delete CAS", () => {
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
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(port.mergePullRequest({ headSha: head, number: 12 })).resolves.toEqual({
            mainHeadSha: mergedMainHead,
            outcome: "partial-success",
            warning: "branch-retained",
        });
        expect(operations).toContain("pull-request-merge");
        expect(operations).toContain("branch-ref");
        expect(operations).not.toContain("branch-delete");
    });

    test("reports completion when provider-managed cleanup removed the merged branch", () => {
        let merged = false;
        const baseTransport = transport("mira-2026", (operation) => {
            if (operation.kind === "graphql") {
                return graphQlResponse(operation, merged ? "MERGED" : "OPEN");
            }
            if (operation.kind === "native-stack-find") return [];
            if (operation.kind === "pull-request-merge") {
                merged = true;
                return { merged: true, message: "merged", sha: mergedMainHead };
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const port = createDeliveryGitHubPullRequestPort({
            transport: {
                ...baseTransport,
                requestJsonWithStatus: (operation) => {
                    if (operation.kind === "branch-ref") {
                        return Promise.resolve({ body: null, status: 404 });
                    }
                    return baseTransport.requestJsonWithStatus(operation);
                },
            },
        });

        expect(port.mergePullRequest({ headSha: head, number: 12 })).resolves.toEqual({
            mainHeadSha: mergedMainHead,
            outcome: "completed",
        });
    });

    test("reports unconfirmed cleanup when the post-merge branch read is unavailable", () => {
        let merged = false;
        const baseTransport = transport("mira-2026", (operation) => {
            if (operation.kind === "graphql") {
                return graphQlResponse(operation, merged ? "MERGED" : "OPEN");
            }
            if (operation.kind === "native-stack-find") return [];
            if (operation.kind === "pull-request-merge") {
                merged = true;
                return { merged: true, message: "merged", sha: mergedMainHead };
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const port = createDeliveryGitHubPullRequestPort({
            transport: {
                ...baseTransport,
                requestJsonWithStatus: (operation) => {
                    if (operation.kind === "branch-ref") {
                        return Promise.reject(new DeliveryGitHubError("unavailable"));
                    }
                    return baseTransport.requestJsonWithStatus(operation);
                },
            },
        });

        expect(port.mergePullRequest({ headSha: head, number: 12 })).resolves.toEqual({
            mainHeadSha: mergedMainHead,
            outcome: "partial-success",
            warning: "branch-cleanup-unconfirmed",
        });
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

    test("does not dispatch native merge without an atomic full-prefix head guard", () => {
        let mergeCalled = false;
        const operations: string[] = [];
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                operations.push(operation.kind);
                if (operation.kind === "native-stack-merge-start") {
                    mergeCalled = true;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.mergeNativeStack([{ headSha: head, number: 12 }])
        ).rejects.toMatchObject({ reason: "capability-unavailable" });
        expect(mergeCalled).toBeFalse();
        expect(operations).not.toContain("native-stack-merge-start");
    });

    test("does not dispatch when a lower native stack head could race", () => {
        const bottomHead = "c".repeat(40);
        let mergeCalled = false;
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "native-stack-merge-start") {
                    mergeCalled = true;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.mergeNativeStack([
                { headSha: bottomHead, number: 11 },
                { headSha: head, number: 12 },
            ])
        ).rejects.toMatchObject({ reason: "capability-unavailable" });
        expect(mergeCalled).toBeFalse();
    });

    test("does not create a native stack without atomic expected-head guards", () => {
        const bottomHead = "b".repeat(40);
        let createCalled = false;
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "native-stack-create") {
                    createCalled = true;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.createNativeStack([
                { headSha: bottomHead, number: 11 },
                { headSha: head, number: 12 },
            ])
        ).rejects.toMatchObject({ reason: "capability-unavailable" });
        expect(createCalled).toBeFalse();
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

    test("does not close a PR when GitHub cannot bind rejection to its head", () => {
        let closeCalled = false;
        let commentCalled = false;
        const port = createDeliveryGitHubPullRequestPort({
            transport: transport("mira-2026", (operation) => {
                if (operation.kind === "pull-request-close") {
                    closeCalled = true;
                    return {
                        base: { ref: "main" },
                        head: { sha: "f".repeat(40) },
                        number: 12,
                        state: "closed",
                    };
                }
                if (operation.kind === "pull-request-comment") {
                    commentCalled = true;
                    return {};
                }
                throw new Error(`Unexpected ${operation.kind}`);
            }),
        });

        expect(
            port.rejectPullRequest({ headSha: head, number: 12 })
        ).rejects.toMatchObject({ reason: "capability-unavailable" });
        expect(closeCalled).toBeFalse();
        expect(commentCalled).toBeFalse();
    });

    test("refuses to compose the ordinary port with Raymond authority", () => {
        expect(() =>
            createDeliveryGitHubPullRequestPort({
                transport: transport("rajohan", () => ({})),
            })
        ).toThrow(DeliveryGitHubError);
    });
});
