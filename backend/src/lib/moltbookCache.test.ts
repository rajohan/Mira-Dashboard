import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { setCacheStoreDockerBinForTests } from "./cacheStore.js";

const originalPath = process.env.PATH;
const originalMode = process.env.FAKE_MOLTBOOK_CACHE_MODE;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!/usr/bin/node
const mode = process.env.FAKE_MOLTBOOK_CACHE_MODE || "fresh";
const command = process.argv.join(" ");
let key = "moltbook.home";
if (command.includes("moltbook.profile")) key = "moltbook.profile";
if (command.includes("moltbook.my-content")) key = "moltbook.my-content";
if (command.includes("moltbook.feed.hot")) key = "moltbook.feed.hot";
if (command.includes("moltbook.feed.new")) key = "moltbook.feed.new";
if (mode === "missing") {
  process.exit(0);
}
const status = mode === "stale" ? "stale" : "fresh";
const payloads = {
  "moltbook.home": { pendingRequestCount: 1, unreadMessageCount: 2, activityOnYourPostsCount: 3, activityOnYourPosts: [{ id: "activity-1" }], latestAnnouncement: { postId: "post-1", title: "News", authorName: "Mira", createdAt: "2026-05-11T00:00:00.000Z", preview: "hello" }, postsFromAccountsYouFollowCount: 4, exploreCount: 5, nextActions: ["reply"], fetchedAt: "2026-05-11T00:00:00.000Z" },
  "moltbook.profile": { agent: { username: "mira_2026" } },
  "moltbook.my-content": { posts: [{ id: "post-1" }], comments: [{ id: "comment-1" }] },
  "moltbook.feed.hot": { posts: [{ id: "hot-1" }], feedType: "hot", feedFilter: null, hasMore: true, tip: "popular" },
  "moltbook.feed.new": { posts: [{ id: "new-1" }], feedType: "new", feedFilter: null, hasMore: false, tip: null },
};
const data = mode === "invalid" ? "not-json" : JSON.stringify(payloads[key]);
process.stdout.write([
  "key\tdata\tsource\tupdated_at\tlast_attempt_at\texpires_at\tstatus\terror_code\terror_message\tconsecutive_failures\tmeta",
  key + "\t" + data + "\tmoltbook\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\t2026-05-11T01:00:00.000Z\t" + status + "\tWARN\tCareful\t2\t{\"producer\":\"test\"}",
  "",
].join("\n"));
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
    setCacheStoreDockerBinForTests(dockerPath);
}

describe("Moltbook cache helpers", () => {
    let tempDir: string;
    let cache: typeof import("./moltbookCache.js");

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-moltbook-cache-"));
        await installFakeDocker(tempDir);
        cache = await import("./moltbookCache.js");
    });

    beforeEach(() => {
        process.env.FAKE_MOLTBOOK_CACHE_MODE = "fresh";
    });

    after(async () => {
        process.env.PATH = originalPath;
        if (originalMode === undefined) {
            delete process.env.FAKE_MOLTBOOK_CACHE_MODE;
        } else {
            process.env.FAKE_MOLTBOOK_CACHE_MODE = originalMode;
        }
        setCacheStoreDockerBinForTests(undefined);
        await rm(tempDir, { recursive: true, force: true });
    });

    it("maps fresh Moltbook home and metadata cache rows", async () => {
        const home = await cache.fetchCachedMoltbookHome();

        assert.equal(home.source, "moltbook");
        assert.equal(home.status, "fresh");
        assert.equal(home.updatedAt, "2026-05-11T00:00:00.000Z");
        assert.equal(home.expiresAt, "2026-05-11T01:00:00.000Z");
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

    it("rejects missing, stale, and invalid Moltbook cache rows", async () => {
        process.env.FAKE_MOLTBOOK_CACHE_MODE = "missing";
        await assert.rejects(cache.fetchCachedMoltbookHome, {
            message: "Moltbook cache entry not found or not fresh: moltbook.home",
        });

        process.env.FAKE_MOLTBOOK_CACHE_MODE = "stale";
        await assert.rejects(cache.fetchCachedMoltbookFeed("hot"), {
            message: "Moltbook cache entry not found or not fresh: moltbook.feed.hot",
        });

        process.env.FAKE_MOLTBOOK_CACHE_MODE = "invalid";
        await assert.rejects(cache.fetchCachedMoltbookProfile, {
            message: "Moltbook cache payload is invalid: moltbook.profile",
        });
    });
});
