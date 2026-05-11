import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(openclawHome: string): Promise<TestServer> {
    process.env.OPENCLAW_HOME = openclawHome;
    const { default: mediaRoutes } = await import("./media.js");

    const app = express();
    mediaRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("media routes", () => {
    let server: TestServer;
    let tempRoot: string;
    let openclawHome: string;
    let mediaRoot: string;
    let outsideFile: string;

    before(async () => {
        tempRoot = await mkdtemp(path.join(os.tmpdir(), "mira-media-route-"));
        openclawHome = path.join(tempRoot, "openclaw");
        mediaRoot = path.join(openclawHome, "media");
        await mkdir(mediaRoot, { recursive: true });
        await writeFile(path.join(mediaRoot, "note.txt"), "hello media");
        await writeFile(
            path.join(mediaRoot, "picture.png"),
            Buffer.from("89504e47", "hex")
        );
        await mkdir(path.join(mediaRoot, "albums"));
        outsideFile = path.join(tempRoot, "outside.txt");
        await writeFile(outsideFile, "secret");
        await symlink(outsideFile, path.join(mediaRoot, "escape.txt"));
        server = await startServer(openclawHome);
    });

    after(async () => {
        await server.close();
        await rm(tempRoot, { recursive: true, force: true });
    });

    it("serves media files with MIME type and private cache headers", async () => {
        const mediaPath = path.join(mediaRoot, "note.txt");
        const response = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(mediaPath)}`
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
        assert.equal(await response.text(), "hello media");

        const imagePath = path.join(mediaRoot, "picture.png");
        const image = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(imagePath)}`
        );
        assert.equal(image.status, 200);
        assert.equal(image.headers.get("content-type"), "image/png");
    });

    it("rejects missing, external, and symlink-escaped media paths", async () => {
        const missing = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(
                path.join(mediaRoot, "missing.txt")
            )}`
        );
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: "Media not found" });

        const external = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(outsideFile)}`
        );
        assert.equal(external.status, 403);
        assert.deepEqual(await external.json(), { error: "Access denied" });

        const escaped = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(
                path.join(mediaRoot, "escape.txt")
            )}`
        );
        assert.equal(escaped.status, 403);
        assert.deepEqual(await escaped.json(), { error: "Access denied" });
    });

    it("rejects directories and oversized media files", async () => {
        const directory = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(
                path.join(mediaRoot, "albums")
            )}`
        );
        assert.equal(directory.status, 400);
        assert.deepEqual(await directory.json(), { error: "Media path is not a file" });

        const largePath = path.join(mediaRoot, "large.txt");
        await writeFile(largePath, Buffer.alloc(16 * 1024 * 1024 + 1));
        const large = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(largePath)}`
        );

        assert.equal(large.status, 413);
        assert.deepEqual(await large.json(), { error: "Media file too large" });
    });
});
