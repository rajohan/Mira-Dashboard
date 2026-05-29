import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(openclawHome: string): Promise<TestServer> {
    const prevOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
        const { default: mediaRoutes } = await import("./media.js");
        return await startServerWithMediaRoutes(
            openclawHome,
            mediaRoutes,
            prevOpenclawHome
        );
    } catch (error) {
        if (prevOpenclawHome === undefined) {
            delete process.env.OPENCLAW_HOME;
        } else {
            process.env.OPENCLAW_HOME = prevOpenclawHome;
        }
        throw error;
    }
}

async function startServerWithMediaRoutes(
    openclawHome: string,
    mediaRoutes: (app: express.Application) => void,
    prevOpenclawHome = process.env.OPENCLAW_HOME
): Promise<TestServer> {
    const restoreOpenclawHome = () => {
        if (prevOpenclawHome === undefined) {
            delete process.env.OPENCLAW_HOME;
        } else {
            process.env.OPENCLAW_HOME = prevOpenclawHome;
        }
    };
    process.env.OPENCLAW_HOME = openclawHome;
    let server: http.Server | undefined;
    try {
        const app = express();
        mediaRoutes(app);
        server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                server?.off("listening", onListening);
                server?.off("error", onError);
            };
            const onListening = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            server?.once("listening", onListening);
            server?.once("error", onError);
            server?.listen(0);
        });
    } catch (error) {
        if (server?.listening) {
            await new Promise((resolve) => server?.close(resolve));
        }
        restoreOpenclawHome();
        throw error;
    }
    assert.ok(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise((resolve) =>
                server.close(() => {
                    restoreOpenclawHome();
                    resolve();
                })
            ),
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
        await writeFile(path.join(mediaRoot, "blob.unknown"), "opaque");
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

        const unknown = await fetch(
            `${server.baseUrl}/api/media?path=${encodeURIComponent(
                path.join(mediaRoot, "blob.unknown")
            )}`
        );
        assert.equal(unknown.status, 200);
        assert.equal(unknown.headers.get("content-type"), "application/octet-stream");
    });

    it("falls back to the default media root when OPENCLAW_HOME is blank", async () => {
        const originalOpenClawHome = process.env.OPENCLAW_HOME;
        try {
            process.env.OPENCLAW_HOME = "";
            const module = await import(`./media.js?blank=${Date.now()}`);
            assert.equal(typeof module.default, "function");
            assert.equal(
                module.__testing.mediaRoot,
                path.join(os.homedir(), ".openclaw", "media")
            );
        } finally {
            if (originalOpenClawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = originalOpenClawHome;
            }
        }
    });

    it("returns not found when the media root disappears before canonicalization", async () => {
        const missingHome = path.join(tempRoot, "missing-openclaw");
        const missingMediaRoot = path.join(missingHome, "media");
        await mkdir(missingMediaRoot, { recursive: true });
        const disappearingFile = path.join(missingMediaRoot, "disappears.txt");
        await writeFile(disappearingFile, "gone");

        const previousOpenclawHome = process.env.OPENCLAW_HOME;
        process.env.OPENCLAW_HOME = missingHome;
        const module = await import(`./media.js?missing-root=${Date.now()}`);
        const missingServer = await startServerWithMediaRoutes(
            missingHome,
            module.default,
            previousOpenclawHome
        );
        const existsSync = mock.method(
            fs,
            "existsSync",
            (filePath: fs.PathLike) => filePath === disappearingFile
        );

        try {
            const response = await fetch(
                `${missingServer.baseUrl}/api/media?path=${encodeURIComponent(
                    disappearingFile
                )}`
            );
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { error: "Media not found" });
        } finally {
            existsSync.mock.restore();
            await missingServer.close();
        }
    });

    it("restores OPENCLAW_HOME when startup fails", async () => {
        const originalOpenClawHome = process.env.OPENCLAW_HOME;
        process.env.OPENCLAW_HOME = "previous-home";
        const listen = mock.method(
            http.Server.prototype,
            "listen",
            function listen(this: http.Server) {
                this.emit("error", new Error("listen failed"));
                return this;
            }
        );
        try {
            await assert.rejects(startServer(openclawHome), /listen failed/u);
            assert.equal(process.env.OPENCLAW_HOME, "previous-home");
        } finally {
            listen.mock.restore();
            if (originalOpenClawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = originalOpenClawHome;
            }
        }
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
