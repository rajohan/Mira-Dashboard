import { describe, expect, test } from "bun:test";

import {
    deliveryPullRequestsPayloadMaximumBytes,
    type DeliveryPullRequestActionCapability,
    type DeliveryReleases,
} from "../../contracts/delivery.ts";
import type { DeliveryGitHubPullRequest } from "../../contracts/deliveryGithub.ts";
import {
    projectDeliveryOperationAuthority,
    projectDeliveryPreview,
    projectDeliveryPullRequests,
    projectDeliveryReleases,
} from "./overviewProjection.ts";

const observedAtMs = Date.parse("2026-08-13T12:00:00.000Z");

function pullRequest(
    number: number,
    overrides: Partial<DeliveryGitHubPullRequest> = {}
): DeliveryGitHubPullRequest {
    return {
        additions: 1,
        authorLogin: "mira-2026",
        baseRefName: "main",
        body: `Body ${number}`,
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
                submittedAt: "2026-08-13T11:00:00.000Z",
            },
        ],
        state: "OPEN",
        title: `PR ${number}`,
        updatedAt: "2026-08-13T11:30:00.000Z",
        url: `https://github.com/rajohan/Mira-Dashboard/pull/${number}`,
        ...overrides,
    };
}

function releases(): DeliveryReleases {
    return {
        activationRevision: "a".repeat(64),
        current: {
            builtAtMs: observedAtMs - 10_000,
            commitTitle: "Current",
            commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"a".repeat(40)}`,
            releaseId: "a".repeat(40),
            runtimeRevision: "b".repeat(40),
            schemaTarget: 1,
        },
        previous: {
            builtAtMs: observedAtMs - 20_000,
            commitTitle: "Previous",
            commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${"c".repeat(40)}`,
            releaseId: "c".repeat(40),
            runtimeRevision: "d".repeat(40),
            schemaTarget: 1,
        },
        rollback: {
            actor: "mira",
            available: true,
            target: {
                databaseSnapshotTransitionId: "01917d36-2e64-7c89-9abc-1234567890ab",
                releaseId: "c".repeat(40),
                runtimeRevision: "d".repeat(40),
            },
        },
    };
}

function project(pullRequests: readonly DeliveryGitHubPullRequest[]) {
    return projectDeliveryOperationAuthority({
        checkoutInspection: { headSha: "e".repeat(40), safe: true },
        mainHeadSha: "e".repeat(40),
        observedAtMs,
        previewStatus: { status: "stopped", updatedAtMs: observedAtMs },
        production: { actionActive: false, releases: releases() },
        pullRequests,
        reviewer: { state: "available" },
        supportsNativeStacks: true,
    });
}

describe("Delivery overview projection", () => {
    test("partitions complete native, inferred, standalone, fork, and read-only inventories", () => {
        const inferredBottom = pullRequest(1);
        const inferredTop = pullRequest(2, {
            baseRefName: inferredBottom.headRefName,
        });
        const nativeBottom = pullRequest(3, {
            stack: { baseRefName: "main", number: 90, position: 1, size: 2 },
        });
        const nativeTop = pullRequest(4, {
            baseRefName: nativeBottom.headRefName,
            stack: { baseRefName: "main", number: 90, position: 2, size: 2 },
        });
        const ambiguousBottom = pullRequest(5);
        const ambiguousLeft = pullRequest(6, {
            baseRefName: ambiguousBottom.headRefName,
        });
        const ambiguousRight = pullRequest(7, {
            baseRefName: ambiguousBottom.headRefName,
        });
        const standaloneMira = pullRequest(8);
        const standaloneExternal = pullRequest(9, { authorLogin: "dependabot" });
        const forkNamedMain = pullRequest(10, {
            authorLogin: "external-user",
            headRefName: "main",
            isCrossRepository: true,
        });
        const orphan = pullRequest(11, { baseRefName: "missing-parent" });
        const incompleteNative = pullRequest(12, {
            stack: { baseRefName: "main", number: 91, position: 2, size: 2 },
        });

        const payload = project([
            nativeTop,
            ambiguousRight,
            standaloneExternal,
            inferredTop,
            orphan,
            standaloneMira,
            nativeBottom,
            ambiguousBottom,
            forkNamedMain,
            inferredBottom,
            ambiguousLeft,
            incompleteNative,
        ]);
        const kinds = payload.pullRequestGroups.map(({ kind }) => kind);
        expect(kinds.filter((kind) => kind === "candidate-stack")).toHaveLength(1);
        expect(kinds.filter((kind) => kind === "native-stack")).toHaveLength(2);
        expect(kinds.filter((kind) => kind === "read-only-chain")).toHaveLength(2);
        expect(kinds.filter((kind) => kind === "standalone-mira")).toHaveLength(1);
        expect(kinds.filter((kind) => kind === "standalone-external")).toHaveLength(2);
        expect(
            payload.pullRequestGroups.find(({ members }) =>
                members.some(({ number }) => number === 10)
            )?.kind
        ).toBe("standalone-external");
        expect(
            payload.pullRequestGroups.find(({ members }) =>
                members.some(({ number }) => number === 11)
            )?.kind
        ).toBe("read-only-chain");
        expect(
            payload.pullRequestGroups
                .flatMap(({ members }) => members)
                .find(({ number }) => number === 11)
                ?.actions.find(({ action }) => action === "approve-review")
        ).toMatchObject({ available: false, reason: "not-main-rooted" });
        expect(
            payload.pullRequestGroups.find(({ members }) =>
                members.some(({ number }) => number === 12)
            )?.kind
        ).toBe("native-stack");
    });

    test("publishes authoritative scope rules and fixed actors", () => {
        const bottom = pullRequest(1);
        const top = pullRequest(2, { baseRefName: bottom.headRefName });
        const nativeBottom = pullRequest(3, {
            checks: [
                {
                    conclusion: "FAILURE",
                    identity: "check:Dashboard",
                    status: "COMPLETED",
                },
            ],
            stack: { baseRefName: "main", number: 90, position: 1, size: 2 },
        });
        const nativeTop = pullRequest(4, {
            baseRefName: nativeBottom.headRefName,
            stack: { baseRefName: "main", number: 90, position: 2, size: 2 },
        });
        const payload = project([top, bottom, nativeTop, nativeBottom]);
        const group = payload.pullRequestGroups.find(
            ({ kind }) => kind === "candidate-stack"
        )!;
        const topActions = group.members[1]!.actions;
        expect(topActions.find(({ action }) => action === "create-stack")).toMatchObject({
            actor: "mira",
            available: false,
            reason: "head-guard-unavailable",
            scope: "group",
        });
        expect(
            topActions.find(({ action }) => action === "approve-review")
        ).toMatchObject({
            actor: "raymond",
            available: false,
            reason: "already-approved",
            scope: "self",
        });
        expect(topActions.find(({ action }) => action === "merge")).toMatchObject({
            available: false,
            reason: "ambiguous-chain",
            scope: "prefix",
        });
        expect(
            payload.pullRequestGroups
                .find(({ kind }) => kind === "native-stack")!
                .members[1]!.actions.find(({ action }) => action === "merge")
        ).toMatchObject({
            available: false,
            reason: "head-guard-unavailable",
            scope: "prefix",
        });
    });

    test("publishes head-guard limitations without disabling safe ordinary actions", () => {
        const candidateBottom = pullRequest(1);
        const candidateTop = pullRequest(2, {
            baseRefName: candidateBottom.headRefName,
        });
        const nativeBottom = pullRequest(3, {
            stack: { baseRefName: "main", number: 90, position: 1, size: 2 },
        });
        const nativeTop = pullRequest(4, {
            baseRefName: nativeBottom.headRefName,
            stack: { baseRefName: "main", number: 90, position: 2, size: 2 },
        });
        const ordinary = pullRequest(5, { mergeStateStatus: "BEHIND" });
        const reviewable = pullRequest(6, { reviews: [] });
        const payload = project([
            candidateTop,
            nativeTop,
            ordinary,
            candidateBottom,
            reviewable,
            nativeBottom,
        ]);
        const member = (number: number) =>
            payload.pullRequestGroups
                .flatMap(({ members }) => members)
                .find((pullRequest) => pullRequest.number === number)!;
        const action = (
            number: number,
            id: DeliveryPullRequestActionCapability["action"]
        ) => member(number).actions.find(({ action }) => action === id);

        expect(action(candidateTop.number, "create-stack")).toMatchObject({
            available: false,
            reason: "head-guard-unavailable",
        });
        expect(action(nativeTop.number, "merge")).toMatchObject({
            available: false,
            reason: "head-guard-unavailable",
        });
        expect(action(nativeTop.number, "preview-start")).toMatchObject({
            available: true,
        });
        expect(action(ordinary.number, "reject")).toMatchObject({
            available: false,
            reason: "head-guard-unavailable",
        });
        for (const id of ["merge", "preview-start", "update-branch"] as const) {
            expect(action(ordinary.number, id)).toMatchObject({ available: true });
        }
        expect(action(reviewable.number, "approve-review")).toMatchObject({
            available: true,
        });
    });

    test("keeps untrusted native previews and merges fail-closed without blocking ordinary external PRs", () => {
        const native = pullRequest(1, {
            authorLogin: "external-user",
            stack: { baseRefName: "main", number: 90, position: 2, size: 2 },
        });
        const ordinary = pullRequest(2, { authorLogin: "external-user" });
        const payload = project([native, ordinary]);
        const merge = (number: number) =>
            payload.pullRequestGroups
                .flatMap(({ members }) => members)
                .find((pullRequest) => pullRequest.number === number)!
                .actions.find(({ action }) => action === "merge");

        expect(merge(native.number)).toMatchObject({
            available: false,
            reason: "head-guard-unavailable",
        });
        expect(
            payload.pullRequestGroups
                .flatMap(({ members }) => members)
                .find((pullRequest) => pullRequest.number === native.number)!
                .actions.find(({ action }) => action === "preview-start")
        ).toMatchObject({ available: false, reason: "untrusted-author" });
        expect(merge(ordinary.number)).toMatchObject({ available: true });
    });

    test("omits bodies deterministically before dropping any pull request inventory", () => {
        const pullRequests = Array.from({ length: 41 }, (_, index) =>
            pullRequest(index + 1, { body: "x".repeat(64 * 1024) })
        );
        const payload = project(pullRequests);
        const members = payload.pullRequestGroups.flatMap(({ members }) => members);
        expect(members).toHaveLength(41);
        expect(members.some(({ body }) => body === undefined)).toBeTrue();
        expect(
            new TextEncoder().encode(JSON.stringify(payload)).byteLength
        ).toBeLessThanOrEqual(deliveryPullRequestsPayloadMaximumBytes);
    });

    test("keeps revisions deterministic while excluding the observation clock", () => {
        const first = project([pullRequest(1)]);
        const later = projectDeliveryOperationAuthority({
            checkoutInspection: { headSha: "e".repeat(40), safe: true },
            mainHeadSha: "e".repeat(40),
            observedAtMs: observedAtMs + 1000,
            previewStatus: {
                status: "stopped",
                updatedAtMs: observedAtMs,
            },
            production: { actionActive: false, releases: releases() },
            pullRequests: [pullRequest(1)],
            reviewer: { state: "available" },
            supportsNativeStacks: true,
        });
        expect(later.sourceRevision).toBe(first.sourceRevision);
        expect(
            project([pullRequest(1, { headSha: "f".repeat(40) })]).sourceRevision
        ).not.toBe(first.sourceRevision);
        expect(
            projectDeliveryOperationAuthority({
                checkoutInspection: { headSha: "e".repeat(40), safe: true },
                mainHeadSha: "f".repeat(40),
                observedAtMs,
                previewStatus: { status: "stopped", updatedAtMs: observedAtMs },
                production: { actionActive: false, releases: releases() },
                pullRequests: [pullRequest(1)],
                reviewer: { state: "available" },
                supportsNativeStacks: true,
            }).sourceRevision
        ).not.toBe(first.sourceRevision);

        const idle = project([]);
        const active = projectDeliveryOperationAuthority({
            checkoutInspection: { headSha: "e".repeat(40), safe: true },
            mainHeadSha: "e".repeat(40),
            observedAtMs,
            previewStatus: { status: "stopped", updatedAtMs: observedAtMs },
            production: { actionActive: true, releases: releases() },
            pullRequests: [],
            reviewer: { state: "available" },
            supportsNativeStacks: true,
        });
        expect(active.sourceRevision).not.toBe(idle.sourceRevision);

        const baseInput = {
            checkoutInspection: { headSha: "e".repeat(40), safe: true },
            mainHeadSha: "e".repeat(40),
            observedAtMs,
            previewStatus: { status: "stopped" as const, updatedAtMs: observedAtMs },
            production: { actionActive: false, releases: releases() },
            pullRequests: [pullRequest(1)],
            reviewer: { state: "available" as const },
            supportsNativeStacks: true,
        };
        expect(
            projectDeliveryPreview({
                actionActive: true,
                observedAtMs,
                previewStatus: baseInput.previewStatus,
            }).sourceRevision
        ).not.toBe(
            projectDeliveryPreview({
                actionActive: false,
                observedAtMs,
                previewStatus: baseInput.previewStatus,
            }).sourceRevision
        );
        expect(
            projectDeliveryReleases({
                observedAtMs,
                production: { ...baseInput.production, actionActive: true },
            }).sourceRevision
        ).not.toBe(projectDeliveryReleases(baseInput).sourceRevision);
        expect(
            projectDeliveryPullRequests({
                ...baseInput,
                reviewer: {
                    reason: "credential-missing" as const,
                    state: "unavailable" as const,
                },
            }).sourceRevision
        ).not.toBe(projectDeliveryPullRequests(baseInput).sourceRevision);
    });
});
