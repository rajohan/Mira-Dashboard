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
const originalN8nRoot = process.env.MIRA_N8N_ROOT;

async function writeExecutable(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf8");
    await chmod(filePath, 0o755);
}

async function installFakeCommands(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });

    await writeExecutable(
        path.join(binDir, "docker"),
        String.raw`#!${process.execPath}
process.stdout.write('{"completedAt":"2026-05-11T01:00:00.000Z","ok":true}\n');
`
    );
    await writeExecutable(
        path.join(binDir, "node"),
        String.raw`#!${process.execPath}
process.stderr.write('dry-run stderr\n');
process.stdout.write(JSON.stringify({ ok: true, mode: 'dry-run', args: process.argv.slice(2) }));
`
    );
    await writeExecutable(
        path.join(binDir, "sudo"),
        String.raw`#!${process.execPath}
process.stderr.write('run stderr\n');
process.stdout.write(JSON.stringify({ ok: true, mode: 'run', args: process.argv.slice(2) }));
`
    );

    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
}

async function startServer(): Promise<TestServer> {
    const { default: opsRoutes } = await import("./ops.js");
    const app = express();
    app.use(express.json());
    opsRoutes(app);
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
    options: { method?: string } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.method === "POST"
                ? { "Content-Type": "application/json" }
                : undefined,
        body: options.method === "POST" ? "{}" : undefined,
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("ops routes", () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-ops-route-"));
        await installFakeCommands(tempDir);
        process.env.MIRA_N8N_ROOT = tempDir;
        server = await startServer();
    });

    after(async () => {
        await server.close();
        process.env.PATH = originalPath;
        if (originalN8nRoot === undefined) {
            delete process.env.MIRA_N8N_ROOT;
        } else {
            process.env.MIRA_N8N_ROOT = originalN8nRoot;
        }
        await rm(tempDir, { recursive: true, force: true });
    });

    it("returns log rotation status from n8n cache state", async () => {
        const response = await requestJson<{
            success: boolean;
            lastRun: { completedAt: string; ok: boolean };
        }>(server, "/api/ops/log-rotation/status");

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, {
            success: true,
            lastRun: { completedAt: "2026-05-11T01:00:00.000Z", ok: true },
        });
    });

    it("runs dry-run log rotation with node", async () => {
        const response = await requestJson<{
            success: boolean;
            result: { ok: boolean; mode: string; args: string[] };
            stderr: string;
        }>(server, "/api/ops/log-rotation/dry-run", { method: "POST" });

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.result.mode, "dry-run");
        assert.equal(response.body.result.args.includes("--dry-run"), true);
        assert.equal(response.body.stderr, "dry-run stderr\n");
    });

    it("runs real log rotation through sudo preserve-env wrapper", async () => {
        const response = await requestJson<{
            success: boolean;
            result: { ok: boolean; mode: string; args: string[] };
            stderr: string;
        }>(server, "/api/ops/log-rotation/run", { method: "POST" });

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.result.mode, "run");
        assert.equal(response.body.result.args[0], "-n");
        assert.equal(
            response.body.result.args.includes(
                "--preserve-env=DB_POSTGRESDB_HOST,DB_POSTGRESDB_PORT,DB_POSTGRESDB_DATABASE,DB_POSTGRESDB_USER,DB_POSTGRESDB_PASSWORD"
            ),
            true
        );
        assert.equal(response.body.result.args.includes("--dry-run"), false);
        assert.equal(response.body.stderr, "run stderr\n");
    });
});
