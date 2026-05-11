import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalDopplerBin = process.env.DOPPLER_BIN;

async function installFakeDoppler(tempDir: string): Promise<string> {
    const dopplerPath = path.join(tempDir, "doppler");
    await writeFile(
        dopplerPath,
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
const command = args.at(-1) || "";
process.stdout.write("started backup\n" + command + "\n");
process.stderr.write("backup warning\n");
setTimeout(() => process.exit(0), 10);
`,
        "utf8"
    );
    await chmod(dopplerPath, 0o755);
    return dopplerPath;
}

async function startServer(tempDir: string): Promise<TestServer> {
    process.env.DOPPLER_BIN = await installFakeDoppler(tempDir);
    const { default: backupRoutes } = await import(`./backups.js?test=${Date.now()}`);
    const app = express();
    app.use(express.json());
    backupRoutes(app, express);
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
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

async function waitForDone(
    server: TestServer,
    pathName: string
): Promise<{ status: string; code: number; stdout: string; stderr: string }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await requestJson<{
            job: { status: string; code: number; stdout: string; stderr: string } | null;
        }>(server, pathName);
        if (response.body.job?.status === "done") {
            return response.body.job;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Backup job did not finish");
}

describe("backup routes", () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-backup-routes-"));
        server = await startServer(tempDir);
    });

    after(async () => {
        await server.close();
        if (originalDopplerBin === undefined) {
            delete process.env.DOPPLER_BIN;
        } else {
            process.env.DOPPLER_BIN = originalDopplerBin;
        }
        await rm(tempDir, { recursive: true, force: true });
    });

    it("reports no active backup jobs initially", async () => {
        const [kopia, walg] = await Promise.all([
            requestJson<{ job: null }>(server, "/api/backups/kopia"),
            requestJson<{ job: null }>(server, "/api/backups/walg"),
        ]);

        assert.equal(kopia.status, 200);
        assert.deepEqual(kopia.body, { job: null });
        assert.equal(walg.status, 200);
        assert.deepEqual(walg.body, { job: null });
    });

    it("starts and completes Kopia backup jobs through Doppler", async () => {
        const started = await requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string; code: number | null };
        }>(server, "/api/backups/kopia/run", { method: "POST" });

        assert.equal(started.status, 200);
        assert.equal(started.body.ok, true);
        assert.equal(started.body.job.type, "kopia");
        assert.equal(started.body.job.status, "running");
        assert.equal(started.body.job.code, null);

        const done = await waitForDone(server, "/api/backups/kopia");
        assert.equal(done.status, "done");
        assert.equal(done.code, 0);
        assert.match(done.stdout, /backup-kopia-status\.mjs/);
        assert.equal(done.stderr, "backup warning\n");
    });

    it("starts and completes WAL-G backup jobs through Doppler", async () => {
        const started = await requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string; code: number | null };
        }>(server, "/api/backups/walg/run", { method: "POST" });

        assert.equal(started.status, 200);
        assert.equal(started.body.ok, true);
        assert.equal(started.body.job.type, "walg");
        assert.equal(started.body.job.status, "running");
        assert.equal(started.body.job.code, null);

        const done = await waitForDone(server, "/api/backups/walg");
        assert.equal(done.status, "done");
        assert.equal(done.code, 0);
        assert.match(done.stdout, /backup-walg-status\.mjs/);
        assert.equal(done.stderr, "backup warning\n");
    });
});
