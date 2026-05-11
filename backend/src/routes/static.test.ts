import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import express from "express";

import staticRoutes from "./static.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(frontendPath: string): Promise<TestServer> {
    const app = express();
    staticRoutes(app, frontendPath);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("static routes", () => {
    const tempDirs: string[] = [];
    const servers: TestServer[] = [];

    after(async () => {
        for (const server of servers) {
            await server.close();
        }
        for (const dir of tempDirs) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("serves built frontend assets and SPA fallback with no-store caching", async () => {
        const frontendPath = await mkdtemp(path.join(os.tmpdir(), "mira-static-built-"));
        tempDirs.push(frontendPath);
        await mkdir(path.join(frontendPath, "assets"));
        await writeFile(
            path.join(frontendPath, "index.html"),
            "<main>Mira Dashboard</main>"
        );
        await writeFile(
            path.join(frontendPath, "assets", "app.js"),
            "console.log('ok');"
        );

        const server = await startServer(frontendPath);
        servers.push(server);

        const asset = await fetch(`${server.baseUrl}/assets/app.js`);
        assert.equal(asset.status, 200);
        assert.equal(asset.headers.get("cache-control"), "no-store");
        assert.equal(await asset.text(), "console.log('ok');");

        const spa = await fetch(`${server.baseUrl}/sessions/agent%3Amain%3Amain`);
        assert.equal(spa.status, 200);
        assert.equal(spa.headers.get("cache-control"), "no-store");
        assert.equal(await spa.text(), "<main>Mira Dashboard</main>");

        const api = await fetch(`${server.baseUrl}/api/health`);
        assert.equal(api.status, 404);
    });

    it("serves a clear placeholder when the frontend has not been built", async () => {
        const frontendPath = await mkdtemp(path.join(os.tmpdir(), "mira-static-empty-"));
        tempDirs.push(frontendPath);
        const server = await startServer(frontendPath);
        servers.push(server);

        const response = await fetch(`${server.baseUrl}/`);
        const body = await response.text();

        assert.equal(response.status, 503);
        assert.match(body, /Frontend Not Built/u);
        assert.match(body, /npm run build/u);
    });
});
