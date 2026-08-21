import { describe, expect, test } from "bun:test";

import type { DeliveryReleases } from "../../contracts/delivery.ts";
import type {
    DeliveryDashboardMainGitSyncPort,
    DeliveryGitHubPullRequest,
    DeliveryGitHubPullRequestReadPort,
} from "../../contracts/deliveryGithub.ts";
import {
    createDeliveryOverviewCollector,
    type DeliveryOverviewCollector,
    type DeliveryOverviewCollectorOptions,
} from "./overviewCollector.ts";

const nowMs = Date.parse("2026-08-13T12:00:00.000Z");
const mainHead = "e".repeat(40);

function pullRequest(headSha = "1".padStart(40, "0")): DeliveryGitHubPullRequest {
    return {
        additions: 1,
        authorLogin: "mira-2026",
        baseRefName: "main",
        body: "body",
        changedFiles: 1,
        checks: [],
        checksComplete: true,
        createdAt: "2026-08-13T10:00:00.000Z",
        deletions: 0,
        headRefName: "mira/branch-1",
        headSha,
        isCrossRepository: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        number: 1,
        reviews: [],
        state: "OPEN",
        title: "PR 1",
        updatedAt: "2026-08-13T11:30:00.000Z",
        url: "https://github.com/rajohan/Mira-Dashboard/pull/1",
    };
}

function releases(): DeliveryReleases {
    return {
        activationRevision: "a".repeat(64),
        rollback: {
            actor: "mira",
            available: false,
            reason: "no-previous-release",
        },
    };
}

function github(
    list: DeliveryGitHubPullRequestReadPort["listOpenPullRequests"]
): DeliveryGitHubPullRequestReadPort {
    return {
        findNativeStack: () => Promise.resolve(undefined),
        getPullRequest: () => Promise.reject(new Error("unused")),
        listOpenPullRequests: list,
        readMainRef: () => Promise.resolve(mainHead),
        supportsNativeStacks: () => Promise.resolve(true),
    };
}

function mainGit(): DeliveryDashboardMainGitSyncPort {
    return {
        inspect: () => Promise.resolve({ headSha: mainHead, safe: true }),
        syncMainToExactRef: () => Promise.reject(new Error("unused")),
    };
}

function options(
    overrides: Partial<DeliveryOverviewCollectorOptions> = {}
): DeliveryOverviewCollectorOptions {
    return {
        github: github(() => Promise.resolve([pullRequest()])),
        mainGit: mainGit(),
        nowMs: () => nowMs,
        preview: {
            status: () => Promise.resolve({ status: "stopped", updatedAtMs: nowMs }),
        },
        production: {
            read: () => Promise.resolve({ actionActive: false, releases: releases() }),
        },
        ...overrides,
    };
}

async function pullRequestSection(collector: DeliveryOverviewCollector) {
    const results = await collector.collectSections();
    const result = results.find(({ section }) => section === "pull-requests");
    if (result?.section !== "pull-requests" || result.state !== "succeeded") {
        throw new Error("pull request section unavailable");
    }
    return result.payload;
}

describe("Delivery overview collector", () => {
    test("collects the minimum exact authority for every operation class", async () => {
        const productionSnapshot = {
            actionActive: false,
            releases: releases(),
        } as const;
        const productionRuns: Array<string | undefined> = [];
        const collector = createDeliveryOverviewCollector(
            options({
                preview: {
                    status: () =>
                        Promise.resolve({
                            expectedHeads: [{ headSha: mainHead, number: 1 }],
                            headSha: mainHead,
                            number: 1,
                            previewRevision: "b".repeat(64),
                            status: "running",
                            updatedAtMs: nowMs,
                        }),
                },
                production: {
                    read: () => {
                        productionRuns.push(undefined);
                        return Promise.resolve(productionSnapshot);
                    },
                    readForOperation: (runId) => {
                        productionRuns.push(runId);
                        return Promise.resolve(productionSnapshot);
                    },
                },
                reviewer: { probe: () => Promise.resolve({ state: "available" }) },
            })
        );
        const sourceRevision = "c".repeat(64);

        const deploy = await collector.collectForOperation({
            activationRevision: "a".repeat(64),
            checkoutRevision: "b".repeat(64),
            expectedMainHeadSha: mainHead,
            operation: "deploy",
            sourceRevision,
        });
        expect(deploy.checkout.remoteHeadSha).toBe(mainHead);

        const rollback = await collector.collectForOperation(
            {
                activationRevision: "a".repeat(64),
                operation: "rollback-release",
                sourceRevision,
                target: {
                    databaseSnapshotTransitionId: "019fdf70-0000-7000-8000-000000000001",
                    releaseId: "d".repeat(40),
                    runtimeRevision: "e".repeat(40),
                },
            },
            "rollback-run"
        );
        expect(rollback.releases.activationRevision).toBe("a".repeat(64));

        const stopPreview = await collector.collectForOperation({
            number: 1,
            operation: "stop-preview",
            previewRevision: "b".repeat(64),
            sourceRevision,
        });
        expect(stopPreview.preview).toMatchObject({ number: 1, status: "running" });

        const pullRequestAuthority = await collector.collectForOperation({
            expectedHeadSha: pullRequest().headSha,
            number: 1,
            operation: "approve-review",
            reviewerRevision: "d".repeat(64),
            sourceRevision,
        });
        expect(pullRequestAuthority.pullRequestGroups).toHaveLength(1);
        expect(pullRequestAuthority.reviewerCapability).toMatchObject({
            actor: "raymond",
            available: true,
        });
        expect(productionRuns).toEqual([undefined, "rollback-run", undefined, undefined]);
    });

    test("rediscovers every authority and never trusts retained cache membership", async () => {
        let calls = 0;
        const collector = createDeliveryOverviewCollector(
            options({
                github: github(() => {
                    calls += 1;
                    return Promise.resolve([
                        pullRequest(calls.toString(16).padStart(40, "0")),
                    ]);
                }),
                reviewer: { probe: () => Promise.resolve({ state: "available" }) },
            })
        );

        const first = await pullRequestSection(collector);
        const second = await pullRequestSection(collector);
        expect(calls).toBe(2);
        expect(first.sourceRevision).not.toBe(second.sourceRevision);
        expect(second.groups.flatMap(({ members }) => members)).toHaveLength(1);
    });

    test("keeps missing and unavailable Raymond authority explicit without fallback", async () => {
        const missing = await pullRequestSection(
            createDeliveryOverviewCollector(options())
        );
        expect(missing.reviewerCapability).toMatchObject({
            actor: "raymond",
            available: false,
            reason: "credential-missing",
        });

        const unavailable = await pullRequestSection(
            createDeliveryOverviewCollector(
                options({
                    reviewer: {
                        probe: () => Promise.reject(new Error("private provider detail")),
                    },
                })
            )
        );
        expect(unavailable.reviewerCapability).toMatchObject({
            actor: "raymond",
            available: false,
            reason: "provider-unavailable",
        });
        expect(JSON.stringify(unavailable)).not.toContain("private provider detail");
    });

    test("contains a GitHub failure to the pull-request section", async () => {
        const results = await createDeliveryOverviewCollector(
            options({
                github: github(() => {
                    throw new Error("provider failed");
                }),
            })
        ).collectSections();

        expect(results).toEqual([
            expect.objectContaining({ section: "checkout", state: "succeeded" }),
            expect.objectContaining({ section: "preview", state: "succeeded" }),
            { section: "pull-requests", state: "failed" },
            expect.objectContaining({ section: "releases", state: "succeeded" }),
        ]);
    });

    test("overlays the exact active Jobs preview lifecycle without hiding other sections", async () => {
        const headSha = "f".repeat(40);
        const collector = createDeliveryOverviewCollector(
            options({
                activePreviewOperation: () =>
                    Promise.resolve({
                        expectedHeads: [{ headSha, number: 42 }],
                        number: 42,
                        operation: "start-preview",
                        previewRevision: "b".repeat(64),
                        sourceRevision: "c".repeat(64),
                    }),
                production: {
                    read: () =>
                        Promise.resolve({ actionActive: true, releases: releases() }),
                },
            })
        );

        const results = await collector.collectSections();
        const preview = results.find(({ section }) => section === "preview");
        expect(preview).toMatchObject({
            payload: {
                actionActive: true,
                preview: { headSha, number: 42, status: "starting" },
            },
            state: "succeeded",
        });
        expect(results.filter(({ state }) => state === "succeeded")).toHaveLength(4);
    });
});
