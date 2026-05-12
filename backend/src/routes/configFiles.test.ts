import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

interface ConfigFileItem {
    name: string;
    path: string;
    relPath: string;
    type: "file";
    size: number;
}

async function startServer(homeDir: string): Promise<TestServer> {
    process.env.HOME = homeDir;
    const { default: configFilesRoutes } = await import("./configFiles.js");

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    configFilesRoutes(app, express);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.body === undefined
                ? undefined
                : { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("config files routes", () => {
    let server: TestServer;
    let homeDir: string;
    let openclawRoot: string;

    before(async () => {
        homeDir = await mkdtemp(path.join(os.tmpdir(), "mira-config-files-"));
        openclawRoot = path.join(homeDir, ".openclaw");
        await mkdir(path.join(openclawRoot, "cron"), { recursive: true });
        await mkdir(path.join(openclawRoot, "hooks", "transforms"), { recursive: true });
        await writeFile(path.join(openclawRoot, "openclaw.json"), '{"model":"codex"}\n');
        await writeFile(path.join(openclawRoot, "cron", "jobs.json"), "[]\n");
        server = await startServer(homeDir);
    });

    after(async () => {
        await server.close();
        await rm(homeDir, { recursive: true, force: true });
    });

    it("lists only whitelisted config files that exist", async () => {
        const response = await requestJson<{ files: ConfigFileItem[]; root: string }>(
            server,
            "/api/config-files"
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.root, openclawRoot);
        assert.deepEqual(
            response.body.files.map((file) => ({
                name: file.name,
                path: file.path,
                relPath: file.relPath,
                type: file.type,
            })),
            [
                {
                    name: "openclaw.json",
                    path: "config:openclaw.json",
                    relPath: "openclaw.json",
                    type: "file",
                },
                {
                    name: "jobs.json",
                    path: "config:cron/jobs.json",
                    relPath: "cron/jobs.json",
                    type: "file",
                },
            ]
        );
    });

    it("reads config files and blocks non-whitelisted paths", async () => {
        const response = await requestJson<{
            path: string;
            relPath: string;
            content: string;
            isBinary: boolean;
        }>(server, "/api/config-files/openclaw.json");

        assert.equal(response.status, 200);
        assert.equal(response.body.path, "config:openclaw.json");
        assert.equal(response.body.relPath, "openclaw.json");
        assert.equal(response.body.content, '{"model":"codex"}\n');
        assert.equal(response.body.isBinary, false);

        const denied = await requestJson<{ error: string }>(
            server,
            "/api/config-files/..%2Fsecret.txt"
        );
        assert.equal(denied.status, 403);
        assert.equal(denied.body.error, "Access denied: file not in allowed list");

        const missing = await requestJson<{ error: string }>(
            server,
            "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts"
        );
        assert.equal(missing.status, 404);

        const openclawConfig = path.join(openclawRoot, "openclaw.json");
        const originalOpenclawConfig = await readFile(openclawConfig, "utf8");
        await rm(openclawConfig, { force: true });
        try {
            await symlink("openclaw.json", openclawConfig);
            const symlinkLoop = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(symlinkLoop.status, 404);
            assert.equal(symlinkLoop.body.error, "File not found");
        } finally {
            await rm(openclawConfig, { force: true });
            await writeFile(openclawConfig, originalOpenclawConfig);
        }
    });

    it("detects binary and truncates large allowed config files", async () => {
        await writeFile(
            path.join(openclawRoot, "hooks", "transforms", "agentmail.ts"),
            Buffer.concat([Buffer.from('const value = "ok";\n'), Buffer.from([0])])
        );
        const binary = await requestJson<{ content: string; isBinary: boolean }>(
            server,
            "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts"
        );

        assert.equal(binary.status, 200);
        assert.equal(binary.body.isBinary, true);
        assert.equal(binary.body.content, "[Binary file]");

        await writeFile(
            path.join(openclawRoot, "hooks", "transforms", "agentmail.ts"),
            "x".repeat(1024 * 1024 + 1)
        );
        const large = await requestJson<{
            content: string;
            size: number;
            isBinary: boolean;
            truncated: boolean;
        }>(server, "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts");

        assert.equal(large.status, 200);
        assert.equal(large.body.size, 1024 * 1024 + 1);
        assert.equal(large.body.content.length, 1024 * 1024);
        assert.equal(large.body.isBinary, false);
        assert.equal(large.body.truncated, true);
    });

    it("writes allowed config files and backs up overwritten content", async () => {
        const created = await requestJson<{
            success: boolean;
            path: string;
            relPath: string;
            size: number;
        }>(server, "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts", {
            method: "PUT",
            body: { content: "export default {};\n" },
        });

        assert.equal(created.status, 200);
        assert.equal(created.body.success, true);
        assert.equal(created.body.path, "config:hooks/transforms/agentmail.ts");
        assert.equal(created.body.relPath, "hooks/transforms/agentmail.ts");
        assert.equal(created.body.size, "export default {};\n".length);

        const updated = await requestJson<{ success: boolean }>(
            server,
            "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts",
            { method: "PUT", body: { content: "export const ok = true;\n" } }
        );

        assert.equal(updated.status, 200);
        assert.equal(
            await readFile(
                path.join(openclawRoot, "hooks", "transforms", "agentmail.ts"),
                "utf8"
            ),
            "export const ok = true;\n"
        );
        assert.equal(
            await readFile(
                path.join(openclawRoot, "hooks", "transforms", "agentmail.ts.bak"),
                "utf8"
            ),
            "export default {};\n"
        );

        const missingContent = await requestJson<{ error: string }>(
            server,
            "/api/config-files/openclaw.json",
            { method: "PUT", body: {} }
        );
        assert.equal(missingContent.status, 400);
        assert.equal(missingContent.body.error, "Content required");
    });
});
