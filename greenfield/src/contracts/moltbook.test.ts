import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    moltbookFeedMaximumPosts,
    moltbookFeedSchema,
    moltbookProcedureContracts,
    moltbookSnapshotResultSchema,
    moltbookSnapshotStatusSchema,
} from "./moltbook.ts";

const post = Object.freeze({
    author: { name: "mira" },
    commentCount: 0,
    contentPreview: "preview",
    createdAtMs: 1000,
    downvotes: 0,
    id: "post-1",
    submoltName: "agents",
    title: "Title",
    upvotes: 1,
});

describe("Moltbook contracts", () => {
    test("keeps provider content strict and within row budgets", () => {
        expect(
            v.safeParse(moltbookFeedSchema, {
                hasMore: false,
                posts: [post],
                sort: "hot",
            }).success
        ).toBe(true);
        expect(
            v.safeParse(moltbookFeedSchema, {
                hasMore: false,
                posts: Array.from({ length: moltbookFeedMaximumPosts + 1 }, () => post),
                sort: "hot",
            }).success
        ).toBe(false);
        expect(
            v.safeParse(moltbookFeedSchema, {
                extra: "provider field",
                hasMore: false,
                posts: [],
                sort: "hot",
            }).success
        ).toBe(false);
    });

    test("requires refresh failure details to match the latest attempt", () => {
        expect(
            v.safeParse(moltbookSnapshotStatusSchema, {
                freshness: "stale",
                lastAttemptAtMs: 2000,
                lastAttemptStatus: "failed",
                lastSuccessAtMs: 1000,
                refreshFailureMessage: "Moltbook refresh failed.",
            }).success
        ).toBe(true);
        expect(
            v.safeParse(moltbookSnapshotStatusSchema, {
                freshness: "fresh",
                lastAttemptAtMs: 2000,
                lastAttemptStatus: "failed",
                lastSuccessAtMs: 1000,
            }).success
        ).toBe(false);
        expect(
            v.safeParse(moltbookSnapshotStatusSchema, {
                freshness: "missing",
                lastAttemptAtMs: 2000,
                lastAttemptStatus: "succeeded",
                lastSuccessAtMs: 2000,
            }).success
        ).toBe(false);
    });

    test("exposes one strict combined browser snapshot without removing legacy reads", () => {
        const snapshot = {
            content: { comments: [], posts: [] },
            feed: { hasMore: false, posts: [post], sort: "hot" },
            home: {
                activityOnYourPostsCount: 0,
                exploreCount: 0,
                nextActions: [],
                pendingRequestCount: 0,
                postsFromAccountsYouFollowCount: 0,
                unreadMessageCount: 0,
                unreadNotificationCount: 0,
            },
            status: {
                freshness: "fresh",
                lastAttemptAtMs: 2000,
                lastAttemptStatus: "succeeded",
                lastSuccessAtMs: 2000,
            },
        } as const;
        expect(v.safeParse(moltbookSnapshotResultSchema, snapshot).success).toBe(true);
        expect(
            v.safeParse(moltbookSnapshotResultSchema, {
                ...snapshot,
                providerPath: "/private/moltbook",
            }).success
        ).toBe(false);
        expect(moltbookProcedureContracts.map(({ name }) => name)).toEqual([
            "moltbook.feed",
            "moltbook.home",
            "moltbook.listMyPosts",
            "moltbook.profile",
            "moltbook.snapshot",
        ]);
    });
});
