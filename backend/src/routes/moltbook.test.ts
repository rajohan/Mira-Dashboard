import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalPath = process.env.PATH;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!${process.execPath}
const command = process.argv.at(-1) || "";
function row(key, data, meta = {}) {
  return [
    "key\tdata\tsource\tupdated_at\tlast_attempt_at\texpires_at\tstatus\terror_code\terror_message\tconsecutive_failures\tmeta",
    key + "\t" + JSON.stringify(data) + "\tmoltbook\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\t2026-05-11T01:00:00.000Z\tfresh\t\t\t0\t" + JSON.stringify(meta),
    "",
  ].join("\n");
}
if (command.includes("moltbook.home")) {
  if (process.env.MIRA_TEST_MOLTBOOK_FAIL === "home") throw new Error("home cache failed");
  process.stdout.write(row("moltbook.home", { pendingRequestCount: 1, unreadMessageCount: 2, activityOnYourPostsCount: 0, activityOnYourPosts: [], latestAnnouncement: { postId: "post-1", title: "Hello", authorName: "Mira", createdAt: "2026-05-11", preview: "Hi" }, postsFromAccountsYouFollowCount: 3, exploreCount: 4, nextActions: ["reply"], fetchedAt: "2026-05-11T00:00:00.000Z" }, { ttl: 60 }));
} else if (command.includes("moltbook.feed.new")) {
  if (process.env.MIRA_TEST_MOLTBOOK_FAIL === "feed") throw new Error("feed cache failed");
  process.stdout.write(row("moltbook.feed.new", { posts: [{ id: "new-1" }], feedType: "explore", feedFilter: "new", hasMore: false, tip: null }));
} else if (command.includes("moltbook.feed.hot")) {
  if (process.env.MIRA_TEST_MOLTBOOK_FAIL === "feed") throw new Error("feed cache failed");
  process.stdout.write(row("moltbook.feed.hot", { posts: [{ id: "hot-1" }], feedType: "explore", feedFilter: "hot", hasMore: true, tip: "Be specific" }));
} else if (command.includes("moltbook.profile")) {
  if (process.env.MIRA_TEST_MOLTBOOK_FAIL === "profile") throw new Error("profile cache failed");
  process.stdout.write(row("moltbook.profile", { agent: { username: "mira_2026" } }));
} else if (command.includes("moltbook.my-content")) {
  if (process.env.MIRA_TEST_MOLTBOOK_FAIL === "content") throw new Error("content cache failed");
  process.stdout.write(row("moltbook.my-content", { posts: [{ id: "mine-1" }], comments: [{ id: "comment-1" }] }));
} else {
  process.stderr.write("Unexpected fake docker command: " + command);
  process.exit(1);
}
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
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
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-moltbook-route-"));
        await installFakeDocker(tempDir);
        server = await startServer();
    });

    after(async () => {
        if (server) {
            await server.close();
        }
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        delete process.env.MIRA_TEST_MOLTBOOK_FAIL;
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
        }
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

    it("maps cache command failures to 503 responses", async () => {
        const cases = [
            ["home", "/api/moltbook/home", "home cache failed"],
            ["feed", "/api/moltbook/feed", "feed cache failed"],
            ["profile", "/api/moltbook/profile", "profile cache failed"],
            ["content", "/api/moltbook/my-posts", "content cache failed"],
        ] as const;

        for (const [failure, route, expectedError] of cases) {
            try {
                process.env.MIRA_TEST_MOLTBOOK_FAIL = failure;
                const response = await fetch(`${server.baseUrl}${route}`);
                const body = (await response.json()) as { error: string };
                assert.equal(response.status, 503);
                assert.match(body.error, new RegExp(expectedError, "u"));
            } finally {
                delete process.env.MIRA_TEST_MOLTBOOK_FAIL;
            }
        }
    });
});
