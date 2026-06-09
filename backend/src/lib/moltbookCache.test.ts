import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { db } from "../db.js";
import { clearCacheEntries, seedCacheEntry } from "../testUtils/cacheEntries.js";
import * as cache from "./moltbookCache.js";

const homePayload = {
    pendingRequestCount: 1,
    unreadMessageCount: 2,
    activityOnYourPostsCount: 3,
    activityOnYourPosts: [{ id: "activity-1" }],
    latestAnnouncement: {
        postId: "post-1",
        title: "News",
        authorName: "Mira",
        createdAt: "2026-05-11T00:00:00.000Z",
        preview: "hello",
    },
    postsFromAccountsYouFollowCount: 4,
    exploreCount: 5,
    nextActions: ["reply"],
    fetchedAt: "2026-05-11T00:00:00.000Z",
};

function seedFreshMoltbookEntries(): void {
    seedCacheEntry({
        key: "moltbook.home",
        data: homePayload,
        source: "moltbook",
        errorCode: "WARN",
        errorMessage: "Careful",
        consecutiveFailures: 2,
        metadata: { producer: "test" },
    });
    seedCacheEntry({
        key: "moltbook.profile",
        data: { agent: { username: "mira_2026" } },
        source: "moltbook",
    });
    seedCacheEntry({
        key: "moltbook.my-content",
        data: { posts: [{ id: "post-1" }], comments: [{ id: "comment-1" }] },
        source: "moltbook",
    });
    seedCacheEntry({
        key: "moltbook.feed.hot",
        data: {
            posts: [{ id: "hot-1" }],
            feedType: "hot",
            feedFilter: null,
            hasMore: true,
            tip: "popular",
        },
        source: "moltbook",
    });
    seedCacheEntry({
        key: "moltbook.feed.new",
        data: {
            posts: [{ id: "new-1" }],
            feedType: "new",
            feedFilter: null,
            hasMore: false,
            tip: null,
        },
        source: "moltbook",
    });
}

describe("Moltbook cache helpers", () => {
    beforeEach(() => {
        clearCacheEntries();
        seedFreshMoltbookEntries();
    });

    it("maps fresh Moltbook home and metadata cache rows", async () => {
        const home = await cache.fetchCachedMoltbookHome();

        assert.equal(home.source, "moltbook");
        assert.equal(home.status, "fresh");
        assert.equal(home.updatedAt, "2026-05-11T00:00:00.000Z");
        assert.equal(home.expiresAt, "2099-05-11T01:00:00.000Z");
        assert.equal(home.errorCode, "WARN");
        assert.equal(home.errorMessage, "Careful");
        assert.equal(home.consecutiveFailures, 2);
        assert.deepEqual(home.meta, { producer: "test" });
        assert.equal(home.data.pendingRequestCount, 1);
        assert.equal(home.data.latestAnnouncement?.title, "News");
    });

    it("fetches profile, personal content, and sorted feeds", async () => {
        const [profile, myContent, hotFeed, newFeed] = await Promise.all([
            cache.fetchCachedMoltbookProfile(),
            cache.fetchCachedMoltbookMyContent(),
            cache.fetchCachedMoltbookFeed("hot"),
            cache.fetchCachedMoltbookFeed("new"),
        ]);

        assert.deepEqual(profile.data.agent, { username: "mira_2026" });
        assert.deepEqual(myContent.data.comments, [{ id: "comment-1" }]);
        assert.deepEqual(hotFeed.data.posts, [{ id: "hot-1" }]);
        assert.equal(hotFeed.data.hasMore, true);
        assert.deepEqual(newFeed.data.posts, [{ id: "new-1" }]);
        assert.equal(newFeed.data.hasMore, false);
    });

    it("maps nullable metadata fields to null/default values", async () => {
        clearCacheEntries();
        seedCacheEntry({
            key: "moltbook.home",
            data: homePayload,
            source: "moltbook",
            updatedAt: "",
            lastAttemptAt: "",
            expiresAt: "",
        });

        const home = await cache.fetchCachedMoltbookHome();

        assert.equal(home.updatedAt, null);
        assert.equal(home.lastAttemptAt, null);
        assert.equal(home.expiresAt, null);
        assert.equal(home.errorCode, null);
        assert.equal(home.errorMessage, null);
        assert.equal(home.consecutiveFailures, 0);
        assert.deepEqual(home.meta, {});

        // Intentionally create invalid metadata to test defensive row parsing.
        db.prepare(
            "UPDATE cache_entries SET consecutive_failures = ?, metadata_json = ? WHERE key = ?"
        ).run("", "", "moltbook.home");
        const invalidMeta = await cache.fetchCachedMoltbookHome();
        assert.equal(invalidMeta.consecutiveFailures, 0);
        assert.deepEqual(invalidMeta.meta, {});
    });

    it("rejects missing, stale, and invalid Moltbook cache rows", async () => {
        clearCacheEntries();
        await assert.rejects(cache.fetchCachedMoltbookHome, {
            message: "Moltbook cache entry not found or not fresh: moltbook.home",
        });

        seedCacheEntry({
            key: "moltbook.feed.hot",
            data: { posts: [] },
            source: "moltbook",
            status: "stale",
        });
        await assert.rejects(cache.fetchCachedMoltbookFeed("hot"), {
            message: "Moltbook cache entry not found or not fresh: moltbook.feed.hot",
        });

        seedCacheEntry({
            key: "moltbook.profile",
            data: "not-json",
            source: "moltbook",
        });
        await assert.rejects(cache.fetchCachedMoltbookProfile, {
            message: "Moltbook cache payload is invalid: moltbook.profile",
        });
    });
});
