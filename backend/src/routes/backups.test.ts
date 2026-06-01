import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import backupRoutes from "./backups.js";
import { __testing as backupTesting } from "./backups.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalDopplerBin = process.env.DOPPLER_BIN;
const originalN8nRoot = process.env.MIRA_N8N_ROOT;

async function installFakeDoppler(tempDir: string): Promise<string> {
    const dopplerPath = path.join(tempDir, "doppler");
    await writeFile(
        dopplerPath,
        String.raw`#!${process.execPath}
const args = process.argv.slice(2);
const command = args.at(-1) || "";
if (process.env.FAKE_BACKUP_SIGNAL === "1") {
    process.kill(process.pid, "SIGTERM");
    setInterval(() => {}, 1000);
} else {
    process.stdout.write("started backup\n" + command + "\n");
    process.stderr.write("backup warning\n");
    setTimeout(() => process.exit(0), 10);
}
`,
        "utf8"
    );
    await chmod(dopplerPath, 0o755);
    return dopplerPath;
}

async function startServer(tempDir: string): Promise<TestServer> {
    const savedDopplerBin = process.env.DOPPLER_BIN;
    const savedN8nRoot = process.env.MIRA_N8N_ROOT;
    process.env.DOPPLER_BIN = await installFakeDoppler(tempDir);
    process.env.MIRA_N8N_ROOT = tempDir;
    try {
        const app = express();
        app.use(express.json());
        backupRoutes(app, express);
        const server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
                new Promise((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve()))
                ),
        };
    } catch (error) {
        if (savedDopplerBin === undefined) {
            delete process.env.DOPPLER_BIN;
        } else {
            process.env.DOPPLER_BIN = savedDopplerBin;
        }
        if (savedN8nRoot === undefined) {
            delete process.env.MIRA_N8N_ROOT;
        } else {
            process.env.MIRA_N8N_ROOT = savedN8nRoot;
        }
        throw error;
    }
}

async function startServerWithDoppler(
    tempDir: string,
    dopplerBin: string
): Promise<TestServer> {
    const savedDopplerBin = process.env.DOPPLER_BIN;
    const savedN8nRoot = process.env.MIRA_N8N_ROOT;
    process.env.DOPPLER_BIN = dopplerBin;
    process.env.MIRA_N8N_ROOT = tempDir;
    try {
        const app = express();
        app.use(express.json());
        backupRoutes(app, express);
        const server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
                new Promise((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve()))
                ),
        };
    } catch (error) {
        if (savedDopplerBin === undefined) {
            delete process.env.DOPPLER_BIN;
        } else {
            process.env.DOPPLER_BIN = savedDopplerBin;
        }
        if (savedN8nRoot === undefined) {
            delete process.env.MIRA_N8N_ROOT;
        } else {
            process.env.MIRA_N8N_ROOT = savedN8nRoot;
        }
        throw error;
    }
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
        if (originalN8nRoot === undefined) {
            delete process.env.MIRA_N8N_ROOT;
        } else {
            process.env.MIRA_N8N_ROOT = originalN8nRoot;
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

    it("returns the active job when a Kopia backup is already running", async () => {
        const firstRequest = requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string };
        }>(server, "/api/backups/kopia/run", { method: "POST" });
        const secondRequest = requestJson<{
            ok: boolean;
            job: { id: string; type: string; status: string };
        }>(server, "/api/backups/kopia/run", { method: "POST" });
        const [firstResp, secondResp] = await Promise.all([firstRequest, secondRequest]);

        assert.equal(firstResp.status, 200);
        assert.equal(firstResp.body.ok, true);
        assert.equal(firstResp.body.job.status, "running");
        assert.equal(secondResp.status, 200);
        assert.equal(secondResp.body.ok, true);
        assert.equal(secondResp.body.job.id, firstResp.body.job.id);
        assert.equal(secondResp.body.job.status, "running");

        await waitForDone(server, "/api/backups/kopia");
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

    it("maps signaled backup exits to interrupted status code", async () => {
        process.env.FAKE_BACKUP_SIGNAL = "1";
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { status: string; code: number | null };
            }>(server, "/api/backups/kopia/run", { method: "POST" });

            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);
            assert.equal(started.body.job.status, "running");
            assert.equal(started.body.job.code, null);

            const done = await waitForDone(server, "/api/backups/kopia");
            assert.equal(done.status, "done");
            assert.equal(done.code, 130);
        } finally {
            delete process.env.FAKE_BACKUP_SIGNAL;
        }
    });

    it("marks jobs done when the backup process fails to spawn", async () => {
        const brokenTempDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-backup-broken-")
        );
        const brokenServer = await startServerWithDoppler(
            brokenTempDir,
            path.join(brokenTempDir, "missing-doppler")
        );
        try {
            const started = await requestJson<{
                ok: boolean;
                job: { status: string; code: number | null };
            }>(brokenServer, "/api/backups/walg/run", { method: "POST" });
            assert.equal(started.status, 200);
            assert.equal(started.body.ok, true);
            assert.equal(started.body.job.status, "running");
            assert.equal(started.body.job.code, null);

            const done = await waitForDone(brokenServer, "/api/backups/walg");
            assert.equal(done.status, "done");
            assert.notEqual(done.code, 0);
            assert.match(done.stderr, /ENOENT|missing-doppler/);
        } finally {
            await brokenServer.close();
            process.env.DOPPLER_BIN = await installFakeDoppler(tempDir);
            process.env.MIRA_N8N_ROOT = tempDir;
            await rm(brokenTempDir, { recursive: true, force: true });
        }
    });

    it("covers backup helper edge cases directly", async () => {
        let cleared = false;
        const missing = backupTesting.getCurrentJob("missing-job", () => {
            cleared = true;
        });

        assert.equal(missing, null);
        assert.equal(cleared, true);
        assert.equal(
            backupTesting.getCurrentJob(null, () => {}),
            null
        );
        assert.equal(backupTesting.mapJob(null), null);
        assert.equal(backupTesting.trimOutput("x".repeat(100_001)).length, 100_000);
        assert.equal(backupTesting.createBackupEnv().DB_POSTGRESDB_DATABASE, "n8n");
        const previousDatabaseUser = process.env.DB_POSTGRESDB_USER;
        const previousDatabasePassword = process.env.DB_POSTGRESDB_PASSWORD;
        const previousLegacyDatabaseUser = process.env.DATABASE_USERNAME;
        const previousLegacyDatabasePassword = process.env.DATABASE_PASSWORD;
        try {
            process.env.DB_POSTGRESDB_USER = "native-user";
            process.env.DB_POSTGRESDB_PASSWORD = "native-password";
            const env = backupTesting.createBackupEnv();
            assert.equal(env.DB_POSTGRESDB_USER, "native-user");
            assert.equal(env.DB_POSTGRESDB_PASSWORD, "native-password");

            process.env.DB_POSTGRESDB_USER = "";
            process.env.DB_POSTGRESDB_PASSWORD = "";
            process.env.DATABASE_USERNAME = "legacy-user";
            process.env.DATABASE_PASSWORD = "legacy-password";
            const fallbackEnv = backupTesting.createBackupEnv();
            assert.equal(fallbackEnv.DB_POSTGRESDB_USER, "legacy-user");
            assert.equal(fallbackEnv.DB_POSTGRESDB_PASSWORD, "legacy-password");
        } finally {
            if (previousDatabaseUser === undefined) {
                delete process.env.DB_POSTGRESDB_USER;
            } else {
                process.env.DB_POSTGRESDB_USER = previousDatabaseUser;
            }
            if (previousDatabasePassword === undefined) {
                delete process.env.DB_POSTGRESDB_PASSWORD;
            } else {
                process.env.DB_POSTGRESDB_PASSWORD = previousDatabasePassword;
            }
            if (previousLegacyDatabaseUser === undefined) {
                delete process.env.DATABASE_USERNAME;
            } else {
                process.env.DATABASE_USERNAME = previousLegacyDatabaseUser;
            }
            if (previousLegacyDatabasePassword === undefined) {
                delete process.env.DATABASE_PASSWORD;
            } else {
                process.env.DATABASE_PASSWORD = previousLegacyDatabasePassword;
            }
        }
        assert.equal(backupTesting.getN8nRoot(), tempDir);
        const previousN8nRoot = process.env.MIRA_N8N_ROOT;
        try {
            process.env.MIRA_N8N_ROOT = "";
            assert.equal(backupTesting.getN8nRoot(), "/home/ubuntu/projects/n8n");
        } finally {
            if (previousN8nRoot === undefined) {
                delete process.env.MIRA_N8N_ROOT;
            } else {
                process.env.MIRA_N8N_ROOT = previousN8nRoot;
            }
        }
        const previousDopplerBin = process.env.DOPPLER_BIN;
        try {
            process.env.DOPPLER_BIN = "";
            assert.equal(backupTesting.getDopplerBin(), "/usr/local/bin/doppler");
        } finally {
            if (previousDopplerBin === undefined) {
                delete process.env.DOPPLER_BIN;
            } else {
                process.env.DOPPLER_BIN = previousDopplerBin;
            }
        }
        assert.equal(typeof backupTesting.getDopplerBin(), "string");
        assert.equal(
            backupTesting.shellQuote("/srv/mira dashboard/it's/scripts/status.mjs"),
            String.raw`'/srv/mira dashboard/it'\''s/scripts/status.mjs'`
        );
    });
});
