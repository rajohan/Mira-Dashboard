import assert from "node:assert/strict";
import fs from "node:fs";
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

async function startServer(homeDir?: string): Promise<TestServer> {
    const originalHome = process.env.HOME;
    if (homeDir === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = homeDir;
    }
    const restoreHome = () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
    };

    try {
        const { default: configFilesRoutes } = await import("./configFiles.js");
        const app = express();
        app.use(express.json({ limit: "3mb" }));
        configFilesRoutes(app, express);
        const server = http.createServer(app);

        await new Promise<void>((resolve) => server.listen(0, resolve));
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
                new Promise((resolve) =>
                    server.close(() => {
                        restoreHome();
                        resolve();
                    })
                ),
        };
    } catch (error) {
        restoreHome();
        throw error;
    }
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
        const outsideConfig = path.join(homeDir, "outside-agentmail.ts");
        const symlinkedConfig = path.join(
            openclawRoot,
            "hooks",
            "transforms",
            "agentmail.ts"
        );
        await writeFile(outsideConfig, "export default {};\n");
        await symlink(outsideConfig, symlinkedConfig);
        try {
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
            assert.equal(
                response.body.files.some(
                    (file) => file.relPath === "hooks/transforms/agentmail.ts"
                ),
                false
            );
        } finally {
            await rm(symlinkedConfig, { force: true });
        }

        const responseWithoutOptionalFile = await requestJson<{
            files: ConfigFileItem[];
        }>(server, "/api/config-files");
        assert.equal(
            responseWithoutOptionalFile.body.files.some(
                (file) => file.relPath === "hooks/transforms/agentmail.ts"
            ),
            false
        );
    });

    it("reports missing home configuration per request", async () => {
        const originalHomedir = os.homedir;
        let misconfiguredServer: TestServer | undefined;
        try {
            os.homedir = (() => "/") as typeof os.homedir;
            misconfiguredServer = await startServer();
            const list = await requestJson<{ error: string }>(
                misconfiguredServer,
                "/api/config-files"
            );
            const read = await requestJson<{ error: string }>(
                misconfiguredServer,
                "/api/config-files/openclaw.json"
            );
            const write = await requestJson<{ error: string }>(
                misconfiguredServer,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );

            for (const response of [list, read, write]) {
                assert.equal(response.status, 500);
                assert.equal(
                    response.body.error,
                    "Server misconfigured: HOME is not configured"
                );
            }
        } finally {
            os.homedir = originalHomedir;
            await misconfiguredServer?.close();
        }
    });

    it("returns an empty list when the OpenClaw root does not exist", async () => {
        const emptyHomeDir = await mkdtemp(path.join(os.tmpdir(), "mira-empty-home-"));
        const emptyServer = await startServer(emptyHomeDir);
        try {
            const response = await requestJson<{ files: ConfigFileItem[]; root: string }>(
                emptyServer,
                "/api/config-files"
            );

            assert.equal(response.status, 200);
            assert.equal(response.body.root, path.join(emptyHomeDir, ".openclaw"));
            assert.deepEqual(response.body.files, []);
        } finally {
            await emptyServer.close();
            await rm(emptyHomeDir, { recursive: true, force: true });
        }
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

        const cronJobsPath = path.join(openclawRoot, "cron", "jobs.json");
        const originalCronJobs = await readFile(cronJobsPath, "utf8");
        await rm(cronJobsPath, { force: true });
        await mkdir(cronJobsPath);
        try {
            const directory = await requestJson<{ error: string }>(
                server,
                "/api/config-files/cron%2Fjobs.json"
            );
            assert.equal(directory.status, 400);
            assert.equal(directory.body.error, "Path is a directory, not a file");
        } finally {
            await rm(cronJobsPath, { recursive: true, force: true });
            await writeFile(cronJobsPath, originalCronJobs);
        }

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

        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-config-outside-"));
        await writeFile(path.join(outsideDir, "openclaw.json"), "{}\n");
        await rm(openclawConfig, { force: true });
        try {
            await symlink(path.join(outsideDir, "openclaw.json"), openclawConfig);
            const outsideSymlink = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(outsideSymlink.status, 403);
            assert.equal(
                outsideSymlink.body.error,
                "Access denied: path outside allowed root"
            );
        } finally {
            await rm(openclawConfig, { force: true });
            await writeFile(openclawConfig, originalOpenclawConfig);
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("reports unexpected read errors", async () => {
        const originalOpenSync = fs.openSync;
        try {
            fs.openSync = ((target: fs.PathLike, flags: string | number) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath === path.join(openclawRoot, "openclaw.json")) {
                    const error = new Error("permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalOpenSync(target, flags);
            }) as typeof fs.openSync;

            const response = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(response.status, 500);
            assert.equal(response.body.error, "permission denied");
        } finally {
            fs.openSync = originalOpenSync;
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

        await writeFile(
            path.join(openclawRoot, "hooks", "transforms", "agentmail.ts"),
            Buffer.concat([Buffer.from([0]), Buffer.alloc(1024 * 1024, "x")])
        );
        const largeBinary = await requestJson<{
            content: string;
            isBinary: boolean;
            truncated: boolean;
        }>(server, "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts");

        assert.equal(largeBinary.status, 200);
        assert.equal(largeBinary.body.content, "[Binary file]");
        assert.equal(largeBinary.body.isBinary, true);
        assert.equal(largeBinary.body.truncated, true);
    });

    it("writes allowed config files and backs up overwritten content", async () => {
        await rm(path.join(openclawRoot, "hooks", "transforms", "agentmail.ts"), {
            force: true,
        });
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

        const openclawPath = path.join(openclawRoot, "openclaw.json");
        const openclawBeforeInvalid = await readFile(openclawPath, "utf8");

        const invalidContent = await requestJson<{ error: string }>(
            server,
            "/api/config-files/openclaw.json",
            { method: "PUT", body: { content: { nested: true } } }
        );
        assert.equal(invalidContent.status, 400);
        assert.equal(invalidContent.body.error, "Invalid content");
        assert.equal(await readFile(openclawPath, "utf8"), openclawBeforeInvalid);
        await assert.rejects(
            readFile(path.join(openclawRoot, "openclaw.json.bak"), "utf8")
        );

        const oversizedContent = await requestJson<{ error: string }>(
            server,
            "/api/config-files/openclaw.json",
            { method: "PUT", body: { content: "x".repeat(2 * 1024 * 1024 + 1) } }
        );
        assert.equal(oversizedContent.status, 400);
        assert.equal(oversizedContent.body.error, "Invalid content");

        const denied = await requestJson<{ error: string }>(
            server,
            "/api/config-files/not-allowed.json",
            { method: "PUT", body: { content: "{}\n" } }
        );
        assert.equal(denied.status, 403);
        assert.equal(denied.body.error, "Access denied: file not in allowed list");

        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-config-write-"));
        const openclawConfig = path.join(openclawRoot, "openclaw.json");
        const originalOpenclawConfig = await readFile(openclawConfig, "utf8");
        await rm(openclawConfig, { force: true });
        try {
            await writeFile(path.join(outsideDir, "openclaw.json"), "{}\n");
            await symlink(path.join(outsideDir, "openclaw.json"), openclawConfig);
            const outsideSymlink = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(outsideSymlink.status, 403);
            assert.equal(
                outsideSymlink.body.error,
                "Access denied: path outside allowed root"
            );
        } finally {
            await rm(openclawConfig, { force: true });
            await writeFile(openclawConfig, originalOpenclawConfig);
            await rm(outsideDir, { recursive: true, force: true });
        }

        const originalMkdirSync = fs.mkdirSync;
        try {
            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath === openclawRoot) {
                    const error = new Error(
                        "root creation denied"
                    ) as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            const unsafePreparedTarget = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(unsafePreparedTarget.status, 403);
            assert.equal(
                unsafePreparedTarget.body.error,
                "Access denied: path outside allowed root"
            );
        } finally {
            fs.mkdirSync = originalMkdirSync;
        }

        const transformsDir = path.join(openclawRoot, "hooks", "transforms");
        const outsideParent = await mkdtemp(
            path.join(os.tmpdir(), "mira-config-parent-")
        );
        await rm(transformsDir, { recursive: true, force: true });
        try {
            await symlink(outsideParent, transformsDir);
            const unsafeParent = await requestJson<{ error: string }>(
                server,
                "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts",
                { method: "PUT", body: { content: "export {};\n" } }
            );
            assert.equal(unsafeParent.status, 403);
            assert.equal(
                unsafeParent.body.error,
                "Access denied: path outside allowed root"
            );
        } finally {
            await rm(transformsDir, { force: true });
            await mkdir(transformsDir, { recursive: true });
            await rm(outsideParent, { recursive: true, force: true });
        }
    });

    it("reports backup-copy failures when overwriting config files", async () => {
        const target = path.join(openclawRoot, "hooks", "transforms", "agentmail.ts");
        const backup = `${target}.bak`;
        await writeFile(target, "export const previous = true;\n");
        await rm(backup, { recursive: true, force: true });
        await mkdir(backup);
        try {
            const response = await requestJson<{ error: string }>(
                server,
                "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts",
                { method: "PUT", body: { content: "export const next = true;\n" } }
            );
            assert.equal(response.status, 500);
            assert.match(response.body.error, /EISDIR|directory/i);
            assert.equal(
                await readFile(target, "utf8"),
                "export const previous = true;\n"
            );
        } finally {
            await rm(backup, { recursive: true, force: true });
        }
    });
});
