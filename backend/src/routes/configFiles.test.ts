import assert from "node:assert/strict";
import fs from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
    testing: {
        setValidateOpenclawLeafForTest: (
            next?: (openclawRoot: string) => boolean
        ) => void;
    };
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
    const originalOpenclawHome = process.env.OPENCLAW_HOME;
    const originalDashboardOpenclawHome = process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
    if (homeDir === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = homeDir;
    }
    delete process.env.OPENCLAW_HOME;
    delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
    const restoreHome = () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalOpenclawHome === undefined) {
            delete process.env.OPENCLAW_HOME;
        } else {
            process.env.OPENCLAW_HOME = originalOpenclawHome;
        }
        if (originalDashboardOpenclawHome === undefined) {
            delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        } else {
            process.env.MIRA_DASHBOARD_OPENCLAW_HOME = originalDashboardOpenclawHome;
        }
    };

    try {
        const { default: configFilesRoutes, __testing } = await import(
            `./configFiles.js?test=${Date.now()}-${Math.random()}`
        );
        const app = express();
        app.use(express.json({ limit: "3mb" }));
        configFilesRoutes(app, express);
        const server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                server.off("error", onError);
                server.off("listening", onListening);
            };
            const onListening = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                server.close(() => reject(error));
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(0);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            testing: __testing,
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

        await mkdir(symlinkedConfig);
        try {
            const responseWithDirectory = await requestJson<{
                files: ConfigFileItem[];
            }>(server, "/api/config-files");
            assert.equal(
                responseWithDirectory.body.files.some(
                    (file) => file.relPath === "hooks/transforms/agentmail.ts"
                ),
                false
            );
        } finally {
            await rm(symlinkedConfig, { recursive: true, force: true });
        }

        const originalLstatSync = fs.lstatSync;
        const originalRealpathSync = fs.realpathSync;
        try {
            fs.lstatSync = ((target: fs.PathLike) => {
                if (String(target) === symlinkedConfig) {
                    return {
                        isSymbolicLink: () => false,
                    } as fs.Stats;
                }
                return originalLstatSync(target);
            }) as typeof fs.lstatSync;
            fs.realpathSync = ((target: fs.PathLike, options?: BufferEncoding) => {
                if (String(target) === symlinkedConfig) {
                    return path.join(homeDir, "outside-agentmail.ts");
                }
                return originalRealpathSync(target, options as never);
            }) as typeof fs.realpathSync;
            const escapedRealpathList = await requestJson<{
                files: ConfigFileItem[];
            }>(server, "/api/config-files");
            assert.equal(
                escapedRealpathList.body.files.some(
                    (file) => file.relPath === "hooks/transforms/agentmail.ts"
                ),
                false
            );
        } finally {
            fs.lstatSync = originalLstatSync;
            fs.realpathSync = originalRealpathSync;
        }
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
        const { __testing } = await import("./configFiles.js");
        const originalHome = process.env.HOME;
        const originalOpenclawHome = process.env.OPENCLAW_HOME;
        const originalDashboardOpenclawHome = process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const originalHomedir = os.homedir;
        try {
            delete process.env.OPENCLAW_HOME;
            delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;

            process.env.HOME = "relative-home";
            assert.equal(__testing.resolveOpenclawRoot(), null);
            delete process.env.HOME;
            os.homedir = (() => "relative-home") as typeof os.homedir;
            assert.equal(__testing.resolveOpenclawRoot(), null);
            os.homedir = originalHomedir;

            const linkedHomeDir = await mkdtemp(
                path.join(os.tmpdir(), "mira-linked-home-")
            );
            const linkedTarget = await mkdtemp(
                path.join(os.tmpdir(), "mira-linked-openclaw-")
            );
            process.env.HOME = linkedHomeDir;
            os.homedir = (() => linkedHomeDir) as typeof os.homedir;
            try {
                await symlink(linkedTarget, path.join(linkedHomeDir, ".openclaw"));
                assert.equal(__testing.resolveOpenclawRoot(), linkedTarget);
            } finally {
                await rm(linkedHomeDir, { recursive: true, force: true });
                await rm(linkedTarget, { recursive: true, force: true });
            }

            const unreadableHomeDir = await mkdtemp(
                path.join(os.tmpdir(), "mira-unreadable-home-")
            );
            const originalLstatSync = fs.lstatSync;
            process.env.HOME = unreadableHomeDir;
            os.homedir = (() => unreadableHomeDir) as typeof os.homedir;
            try {
                fs.lstatSync = ((target: fs.PathLike) => {
                    if (target === path.join(unreadableHomeDir, ".openclaw")) {
                        const error = new Error(
                            "root unavailable"
                        ) as NodeJS.ErrnoException;
                        error.code = "EACCES";
                        throw error;
                    }
                    return originalLstatSync(target);
                }) as typeof fs.lstatSync;
                assert.equal(
                    __testing.resolveOpenclawRoot(),
                    path.join(unreadableHomeDir, ".openclaw")
                );
            } finally {
                fs.lstatSync = originalLstatSync;
                await rm(unreadableHomeDir, { recursive: true, force: true });
            }
        } finally {
            os.homedir = originalHomedir;
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalOpenclawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = originalOpenclawHome;
            }
            if (originalDashboardOpenclawHome === undefined) {
                delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
            } else {
                process.env.MIRA_DASHBOARD_OPENCLAW_HOME = originalDashboardOpenclawHome;
            }
        }

        const emptyHomeDir = await mkdtemp(path.join(os.tmpdir(), "mira-empty-home-"));
        const emptyServer = await startServer(emptyHomeDir);
        try {
            const existingRoot = await requestJson<{
                files: ConfigFileItem[];
                root: string;
            }>(emptyServer, "/api/config-files");
            assert.equal(existingRoot.status, 200);
            assert.equal(existingRoot.body.root, path.join(emptyHomeDir, ".openclaw"));
            assert.deepEqual(existingRoot.body.files, []);

            const created = await requestJson<{ success: boolean; relPath: string }>(
                emptyServer,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(created.status, 200);
            assert.equal(created.body.success, true);
            assert.equal(created.body.relPath, "openclaw.json");
            assert.equal(
                await readFile(
                    path.join(emptyHomeDir, ".openclaw", "openclaw.json"),
                    "utf8"
                ),
                "{}\n"
            );
        } finally {
            await emptyServer.close();
            await rm(emptyHomeDir, { recursive: true, force: true });
        }
    });

    it("resolves OpenClaw root from environment overrides", async () => {
        const { __testing } = await import("./configFiles.js");
        const originalHome = process.env.HOME;
        const originalOpenclawHome = process.env.OPENCLAW_HOME;
        const originalDashboardOpenclawHome = process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const openclawHome = await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-"));
        const dashboardOpenclawHome = await mkdtemp(
            path.join(os.tmpdir(), "mira-dashboard-openclaw-")
        );
        const linkedOpenclawHome = path.join(os.tmpdir(), `mira-linked-${Date.now()}`);
        const originalRealpathSync = fs.realpathSync;

        try {
            process.env.HOME = "/";
            process.env.OPENCLAW_HOME = openclawHome;
            delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
            assert.equal(__testing.resolveOpenclawRoot(), openclawHome);

            process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardOpenclawHome;
            assert.equal(__testing.resolveOpenclawRoot(), openclawHome);

            delete process.env.OPENCLAW_HOME;
            assert.equal(__testing.resolveOpenclawRoot(), dashboardOpenclawHome);

            process.env.MIRA_DASHBOARD_OPENCLAW_HOME = "/";
            assert.equal(__testing.resolveOpenclawRoot(), null);

            await symlink(dashboardOpenclawHome, linkedOpenclawHome);
            process.env.MIRA_DASHBOARD_OPENCLAW_HOME = linkedOpenclawHome;
            assert.equal(__testing.resolveOpenclawRoot(), dashboardOpenclawHome);

            process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardOpenclawHome;
            fs.realpathSync = ((target: fs.PathLike) => {
                if (target === dashboardOpenclawHome) {
                    const error = new Error("root unavailable") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;
            assert.equal(__testing.resolveOpenclawRoot(), dashboardOpenclawHome);

            fs.realpathSync = ((target: fs.PathLike) => {
                if (target === dashboardOpenclawHome) {
                    throw Object.assign(new Error("root disappeared"), {
                        code: "ENOENT",
                    });
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;
            assert.deepEqual(__testing.listConfigFiles(dashboardOpenclawHome), []);
        } finally {
            fs.realpathSync = originalRealpathSync;
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalOpenclawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = originalOpenclawHome;
            }
            if (originalDashboardOpenclawHome === undefined) {
                delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
            } else {
                process.env.MIRA_DASHBOARD_OPENCLAW_HOME = originalDashboardOpenclawHome;
            }
            await rm(openclawHome, { recursive: true, force: true });
            await rm(dashboardOpenclawHome, { recursive: true, force: true });
            await rm(linkedOpenclawHome, { force: true });
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

        const originalLstatForSymlink = fs.lstatSync;
        try {
            fs.lstatSync = ((target: fs.PathLike) => {
                if (String(target) === openclawConfig) {
                    return {
                        isSymbolicLink: () => true,
                    } as fs.Stats;
                }
                return originalLstatForSymlink(target);
            }) as typeof fs.lstatSync;
            const lexicalSymlink = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(lexicalSymlink.status, 404);
            assert.equal(lexicalSymlink.body.error, "File not found");
        } finally {
            fs.lstatSync = originalLstatForSymlink;
        }

        const originalOpenForMissing = fs.promises.open;
        try {
            fs.promises.open = (async (target, flags, mode) => {
                if (String(target) === openclawConfig) {
                    const error = new Error("open raced") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
                return originalOpenForMissing(target, flags, mode);
            }) as typeof fs.promises.open;
            const openRace = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(openRace.status, 404);
            assert.equal(openRace.body.error, "File not found");
        } finally {
            fs.promises.open = originalOpenForMissing;
        }

        const originalLstatSync = fs.lstatSync;
        try {
            fs.lstatSync = ((target: fs.PathLike) => {
                if (String(target) === openclawConfig) {
                    const error = new Error("lstat unavailable") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalLstatSync(target);
            }) as typeof fs.lstatSync;
            const lstatFailure = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(lstatFailure.status, 500);
            assert.equal(lstatFailure.body.error, "lstat unavailable");
        } finally {
            fs.lstatSync = originalLstatSync;
        }

        const originalOpenForFailure = fs.promises.open;
        try {
            fs.promises.open = (async (target, flags, mode) => {
                if (String(target) === openclawConfig) {
                    const error = new Error("open unavailable") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalOpenForFailure(target, flags, mode);
            }) as typeof fs.promises.open;
            const openFailure = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(openFailure.status, 500);
            assert.equal(openFailure.body.error, "open unavailable");
        } finally {
            fs.promises.open = originalOpenForFailure;
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

        const hardLinkPath = path.join(openclawRoot, "openclaw-hardlink.json");
        await link(openclawConfig, hardLinkPath);
        try {
            const hardLinkedRead = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(hardLinkedRead.status, 403);
            assert.equal(hardLinkedRead.body.error, "Hard-linked files are not allowed");

            const hardLinkedWrite = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(hardLinkedWrite.status, 403);
            assert.equal(hardLinkedWrite.body.error, "Hard-linked files are not allowed");
        } finally {
            await rm(hardLinkPath, { force: true });
        }

        const originalOpen = fs.promises.open;
        fs.promises.open = (async (
            target: fs.PathLike,
            flags: string | number,
            mode?: fs.Mode
        ) => {
            if (
                String(target).endsWith(`${path.sep}openclaw.json`) &&
                typeof flags === "number" &&
                (flags & fs.constants.O_WRONLY) !== 0
            ) {
                return {
                    stat: async () => ({ isFile: () => true, nlink: 2 }),
                    close: async () => {},
                } as fs.promises.FileHandle;
            }
            return originalOpen.call(fs.promises, target, flags, mode);
        }) as typeof fs.promises.open;
        try {
            const racedHardLink = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(racedHardLink.status, 403);
            assert.equal(racedHardLink.body.error, "Hard-linked files are not allowed");
        } finally {
            fs.promises.open = originalOpen;
            await rm(path.join(openclawRoot, "openclaw.json.bak"), { force: true });
        }

        fs.promises.open = (async (
            target: fs.PathLike,
            flags: string | number,
            mode?: fs.Mode
        ) => {
            if (
                String(target).endsWith(`${path.sep}openclaw.json`) &&
                typeof flags === "number" &&
                (flags & fs.constants.O_WRONLY) !== 0
            ) {
                const error = new Error("write open failed") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            return originalOpen.call(fs.promises, target, flags, mode);
        }) as typeof fs.promises.open;
        try {
            const failedWriteOpen = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(failedWriteOpen.status, 403);
            assert.equal(failedWriteOpen.body.error, "Access denied");
        } finally {
            fs.promises.open = originalOpen;
            await rm(path.join(openclawRoot, "openclaw.json.bak"), { force: true });
        }

        fs.promises.open = (async (
            target: fs.PathLike,
            flags: string | number,
            mode?: fs.Mode
        ) => {
            if (
                String(target).endsWith(`${path.sep}openclaw.json`) &&
                typeof flags === "number" &&
                (flags & fs.constants.O_WRONLY) !== 0
            ) {
                const error = new Error("write open crashed") as NodeJS.ErrnoException;
                error.code = "EIO";
                throw error;
            }
            return originalOpen.call(fs.promises, target, flags, mode);
        }) as typeof fs.promises.open;
        try {
            const failedWriteOpen = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(failedWriteOpen.status, 500);
            assert.equal(failedWriteOpen.body.error, "write open crashed");
        } finally {
            fs.promises.open = originalOpen;
            await rm(path.join(openclawRoot, "openclaw.json.bak"), { force: true });
        }
    });

    it("uses stat identity checks for opened config files on non-Linux platforms", async () => {
        const originalPlatform = process.platform;
        const originalStatSync = fs.statSync;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });

            const response = await requestJson<{ content: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(response.status, 200);
            assert.equal(response.body.content, '{"model":"codex"}\n');

            fs.statSync = ((target: fs.PathLike) => {
                const stat = originalStatSync(target);
                if (target === path.join(openclawRoot, "openclaw.json")) {
                    return { ...stat, ino: stat.ino + 1 } as fs.Stats;
                }
                return stat;
            }) as typeof fs.statSync;

            const mismatch = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(mismatch.status, 403);
            assert.equal(mismatch.body.error, "Access denied: path outside allowed root");
        } finally {
            fs.statSync = originalStatSync;
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it("returns 400 for malformed encoded config paths", async () => {
        const read = await requestJson<{ error: string }>(
            server,
            "/api/config-files/%E0"
        );
        const write = await requestJson<{ error: string }>(
            server,
            "/api/config-files/%E0",
            { method: "PUT", body: { content: "{}\n" } }
        );

        for (const response of [read, write]) {
            assert.equal(response.status, 400);
            assert.equal(response.body.error, "Malformed config file path");
        }
    });

    it("reports unexpected read errors", async () => {
        const originalOpen = fs.promises.open;
        try {
            fs.promises.open = (async (target, flags, mode) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath === path.join(openclawRoot, "openclaw.json")) {
                    const error = new Error("permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalOpen(target, flags, mode);
            }) as typeof fs.promises.open;

            const response = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(response.status, 500);
            assert.equal(response.body.error, "permission denied");
        } finally {
            fs.promises.open = originalOpen;
        }
    });

    it("rejects files when the opened descriptor resolves outside the root", async () => {
        const originalRealpathSync = fs.realpathSync;
        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                if (typeof target === "string" && target.startsWith("/proc/self/fd/")) {
                    return path.join(os.tmpdir(), "outside-openclaw.json");
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;

            const response = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json"
            );
            assert.equal(response.status, 403);
            assert.equal(response.body.error, "Access denied: path outside allowed root");
        } finally {
            fs.realpathSync = originalRealpathSync;
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
        await rm(path.join(openclawRoot, "hooks"), {
            recursive: true,
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

        const missingBody = await requestJson<{ error: string }>(
            server,
            "/api/config-files/openclaw.json",
            { method: "PUT" }
        );
        assert.equal(missingBody.status, 400);
        assert.equal(missingBody.body.error, "Content required");

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

        const originalLstatSync = fs.lstatSync;
        try {
            fs.lstatSync = ((target: fs.PathLike) => {
                if (String(target) === openclawRoot) {
                    const error = new Error("root unavailable") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalLstatSync(target);
            }) as typeof fs.lstatSync;

            const { __testing } = await import("./configFiles.js");
            assert.equal(__testing.validateOpenclawLeaf(openclawRoot), false);
        } finally {
            fs.lstatSync = originalLstatSync;
        }

        try {
            server.testing.setValidateOpenclawLeafForTest(() => false);

            const unsafeRootLeaf = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(unsafeRootLeaf.status, 403);
            assert.equal(
                unsafeRootLeaf.body.error,
                "Access denied: path outside allowed root"
            );
        } finally {
            server.testing.setValidateOpenclawLeafForTest();
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

        try {
            fs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                const targetPath = Buffer.isBuffer(target)
                    ? target.toString("utf8")
                    : String(target);
                if (targetPath === openclawRoot) {
                    const error = new Error(
                        "root creation crashed"
                    ) as NodeJS.ErrnoException;
                    error.code = "EIO";
                    throw error;
                }
                return originalMkdirSync(target, options);
            }) as typeof fs.mkdirSync;

            const failedPreparedTarget = await requestJson<{ error: string }>(
                server,
                "/api/config-files/openclaw.json",
                { method: "PUT", body: { content: "{}\n" } }
            );
            assert.equal(failedPreparedTarget.status, 500);
            assert.equal(failedPreparedTarget.body.error, "root creation crashed");
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

        const { __testing } = await import("./configFiles.js");
        const originalRootMkdirSync = fs.mkdirSync;
        try {
            fs.mkdirSync = ((target: fs.PathLike) => {
                if (String(target) === openclawRoot) {
                    const error = new Error("already exists") as NodeJS.ErrnoException;
                    error.code = "EEXIST";
                    throw error;
                }
                return originalRootMkdirSync(target);
            }) as typeof fs.mkdirSync;
            await __testing.ensureParentDirsForWrite(openclawConfig, openclawRoot);

            fs.mkdirSync = ((target: fs.PathLike) => {
                if (String(target) === openclawRoot) {
                    const error = new Error("permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRootMkdirSync(target);
            }) as typeof fs.mkdirSync;
            await assert.rejects(
                () => __testing.ensureParentDirsForWrite(openclawConfig, openclawRoot),
                (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES"
            );
        } finally {
            fs.mkdirSync = originalRootMkdirSync;
        }

        const originalPlatform = process.platform;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });
            await assert.rejects(
                () =>
                    __testing.withRootedParentPath(
                        openclawConfig,
                        openclawRoot,
                        (rootedPath) => rootedPath
                    ),
                (error: unknown) =>
                    (error as NodeJS.ErrnoException).code === "EACCES" &&
                    (error as Error).message === "Parent path validation failed"
            );
        } finally {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
        }

        const rejectedParent = await mkdtemp(
            path.join(os.tmpdir(), "mira-config-parent-")
        );
        await rm(transformsDir, { recursive: true, force: true });
        try {
            await symlink(rejectedParent, transformsDir);
            await assert.rejects(
                () =>
                    __testing.ensureParentDirsForWrite(
                        path.join(transformsDir, "agentmail.ts"),
                        openclawRoot
                    ),
                (error: unknown) =>
                    (error as NodeJS.ErrnoException).code === "EACCES" &&
                    (error as Error).message === "Parent directory validation failed"
            );
        } finally {
            await rm(transformsDir, { force: true });
            await mkdir(transformsDir, { recursive: true });
            await rm(rejectedParent, { recursive: true, force: true });
        }

        await assert.rejects(
            () =>
                __testing.ensureParentDirsForWrite(
                    path.join(openclawRoot, "..", "outside", "openclaw.json"),
                    openclawRoot
                ),
            (error: unknown) =>
                (error as NodeJS.ErrnoException).code === "EACCES" &&
                (error as Error).message === "Parent directory validation failed"
        );
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
            assert.match(response.body.error, /EISDIR|directory|regular file/i);
            assert.equal(
                await readFile(target, "utf8"),
                "export const previous = true;\n"
            );
        } finally {
            await rm(backup, { recursive: true, force: true });
        }

        await writeFile(target, "export const previous = true;\n");
        await symlink(path.join(os.tmpdir(), "mira-unsafe-backup.ts"), backup);
        try {
            const unsafeBackup = await requestJson<{ error: string }>(
                server,
                "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts",
                { method: "PUT", body: { content: "export const next = true;\n" } }
            );
            assert.equal(unsafeBackup.status, 403);
            assert.equal(unsafeBackup.body.error, "Access denied");
            assert.equal(
                await readFile(target, "utf8"),
                "export const previous = true;\n"
            );
        } finally {
            await rm(backup, { force: true });
        }

        await writeFile(target, Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
        try {
            const oversizedBackup = await requestJson<{ error: string }>(
                server,
                "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts",
                { method: "PUT", body: { content: "export const next = true;\n" } }
            );
            assert.equal(oversizedBackup.status, 413);
            assert.equal(oversizedBackup.body.error, "Config file too large to back up");
            const targetContent = await readFile(target, "utf8");
            assert.equal(targetContent.startsWith("a"), true);
        } finally {
            await writeFile(target, "export const previous = true;\n");
            await rm(backup, { force: true });
        }

        const originalRealpathSync = fs.realpathSync;
        try {
            fs.realpathSync = ((targetPath: fs.PathLike) => {
                const value = targetPath.toString();
                if (value.startsWith("/proc/self/fd/")) {
                    return path.join(os.tmpdir(), "mira-config-outside-parent");
                }
                return originalRealpathSync(targetPath);
            }) as typeof fs.realpathSync;
            const escapedParent = await requestJson<{ error: string }>(
                server,
                "/api/config-files/hooks%2Ftransforms%2Fagentmail.ts",
                { method: "PUT", body: { content: "export const next = true;\n" } }
            );
            assert.equal(escapedParent.status, 403);
            assert.equal(
                escapedParent.body.error,
                "Access denied: path outside allowed root"
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
        }
    });
});
