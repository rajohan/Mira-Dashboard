import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import express from "express";

import { clearCacheEntries, seedCacheEntry } from "../testUtils/cacheEntries.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

function seedMoltbookRouteCache(): void {
    seedCacheEntry({
        key: "moltbook.home",
        source: "moltbook",
        data: {
            pendingRequestCount: 1,
            unreadMessageCount: 2,
            activityOnYourPostsCount: 0,
            activityOnYourPosts: [],
            latestAnnouncement: {
                postId: "post-1",
                title: "Hello",
                authorName: "Mira",
                createdAt: "2026-05-11",
                preview: "Hi",
            },
            postsFromAccountsYouFollowCount: 3,
            exploreCount: 4,
            nextActions: ["reply"],
            fetchedAt: "2026-05-11T00:00:00.000Z",
        },
        metadata: { ttl: 60 },
    });
    seedCacheEntry({
        key: "moltbook.feed.hot",
        source: "moltbook",
        data: {
            posts: [{ id: "hot-1" }],
            feedType: "explore",
            feedFilter: "hot",
            hasMore: true,
            tip: "Be specific",
        },
    });
    seedCacheEntry({
        key: "moltbook.feed.new",
        source: "moltbook",
        data: {
            posts: [{ id: "new-1" }],
            feedType: "explore",
            feedFilter: "new",
            hasMore: false,
            tip: null,
        },
    });
    seedCacheEntry({
        key: "moltbook.profile",
        source: "moltbook",
        data: { agent: { username: "mira_2026" } },
    });
    seedCacheEntry({
        key: "moltbook.my-content",
        source: "moltbook",
        data: { posts: [{ id: "mine-1" }], comments: [{ id: "comment-1" }] },
    });
}

async function startServer(): Promise<TestServer> {
    const { default: moltbookRoutes } = await import("./moltbook.js");
    const app = express();
    moltbookRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            server.off("listening", onListening);
            server.off("error", onError);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };

        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("moltbook routes", () => {
    let server: TestServer;

    before(async () => {
        server = await startServer();
    });

    beforeEach(() => {
        clearCacheEntries();
        seedMoltbookRouteCache();
    });

    after(async () => {
        if (server) {
            await server.close();
        }
        await clearCacheEntries();
    });

    it("returns cached Moltbook home metadata", async () => {
        const response = await fetch(`${server.baseUrl}/api/moltbook/home`);
        const body = (await response.json()) as {
            source: string;
            status: string;
            updatedAt: string;
            data: { pendingRequestCount: number; latestAnnouncement: { title: string } };
            meta: { ttl: number };
        };

        assert.equal(response.status, 200);
        assert.equal(body.source, "moltbook");
        assert.equal(body.status, "fresh");
        assert.equal(body.updatedAt, "2026-05-11T00:00:00.000Z");
        assert.equal(body.data.pendingRequestCount, 1);
        assert.equal(body.data.latestAnnouncement.title, "Hello");
        assert.deepEqual(body.meta, { ttl: 60 });
    });

    it("returns default hot and explicit new feed data", async () => {
        const hot = await fetch(`${server.baseUrl}/api/moltbook/feed`);
        const hotBody = (await hot.json()) as {
            posts: Array<{ id: string }>;
            tip: string;
        };
        assert.equal(hot.status, 200);
        assert.deepEqual(hotBody.posts, [{ id: "hot-1" }]);
        assert.equal(hotBody.tip, "Be specific");

        const newest = await fetch(`${server.baseUrl}/api/moltbook/feed?sort=new`);
        const newBody = (await newest.json()) as {
            posts: Array<{ id: string }>;
            feedFilter: string;
        };
        assert.equal(newest.status, 200);
        assert.deepEqual(newBody.posts, [{ id: "new-1" }]);
        assert.equal(newBody.feedFilter, "new");
    });

    it("returns cached profile and personal content", async () => {
        const profile = await fetch(`${server.baseUrl}/api/moltbook/profile`);
        assert.equal(profile.status, 200);
        assert.deepEqual(await profile.json(), { agent: { username: "mira_2026" } });

        const mine = await fetch(`${server.baseUrl}/api/moltbook/my-posts`);
        assert.equal(mine.status, 200);
        assert.deepEqual(await mine.json(), {
            posts: [{ id: "mine-1" }],
            comments: [{ id: "comment-1" }],
        });
    });

    it("maps cache failures to 503 responses", async () => {
        const cases = [
            ["moltbook.home", "/api/moltbook/home", "moltbook.home"],
            ["moltbook.feed.hot", "/api/moltbook/feed", "moltbook.feed.hot"],
            ["moltbook.profile", "/api/moltbook/profile", "moltbook.profile"],
            ["moltbook.my-content", "/api/moltbook/my-posts", "moltbook.my-content"],
        ] as const;

        for (const [key, route, expectedError] of cases) {
            clearCacheEntries();
            seedMoltbookRouteCache();
            seedCacheEntry({
                key,
                source: "moltbook",
                data: {},
                status: "stale",
            });
            const response = await fetch(`${server.baseUrl}${route}`);
            const body = (await response.json()) as { error: string };
            assert.equal(response.status, 503);
            assert.ok(
                body.error.includes(expectedError),
                `unexpected error: ${body.error}`
            );
        }
    });
});
