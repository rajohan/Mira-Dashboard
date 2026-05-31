import assert from "node:assert/strict";
import crypto from "node:crypto";
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

interface FileItem {
    name: string;
    type: "file" | "directory";
    path: string;
    size?: number;
    error?: boolean;
}

async function startServer(workspaceRoot: string): Promise<TestServer> {
    const originalWorkspaceRoot = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = workspaceRoot;
    let server: http.Server | undefined;
    try {
        const { default: filesRoutes } = await import(
            `./files.js?test=${crypto.randomUUID()}`
        );

        const app = express();
        app.use(express.json({ limit: "2mb" }));
        app.use("/api/files/boom", (_req, _res, next) => {
            next(new Error("boom"));
        });
        filesRoutes(app, express);
        server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            const onListening = () => {
                server?.off("error", onError);
                resolve();
            };
            const onError = (error: Error) => {
                server?.off("listening", onListening);
                reject(error);
            };
            server?.once("listening", onListening);
            server?.once("error", onError);
            server?.listen(0);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
                new Promise((resolve) =>
                    server?.close(() => {
                        if (originalWorkspaceRoot === undefined) {
                            delete process.env.WORKSPACE_ROOT;
                        } else {
                            process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
                        }
                        resolve();
                    })
                ),
        };
    } catch (error) {
        if (server?.listening) {
            await new Promise((resolve) => server?.close(resolve));
        }
        if (originalWorkspaceRoot === undefined) {
            delete process.env.WORKSPACE_ROOT;
        } else {
            process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
        }
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

describe("files routes", () => {
    let server: TestServer;
    let workspaceRoot: string;

    before(async () => {
        workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mira-files-route-"));
        await mkdir(path.join(workspaceRoot, "src"));
        await writeFile(
            path.join(workspaceRoot, "src", "app.ts"),
            "export const ok = true;\n"
        );
        await writeFile(path.join(workspaceRoot, ".hidden"), "hidden");
        await writeFile(path.join(workspaceRoot, ".env.example"), "SAFE=true\n");
        await writeFile(
            path.join(workspaceRoot, "tiny.png"),
            Buffer.from("89504e470d0a1a0a", "hex")
        );
        await writeFile(path.join(workspaceRoot, "binary.dat"), Buffer.from([0, 1, 2]));
        await writeFile(
            path.join(workspaceRoot, "large.txt"),
            Buffer.alloc(1024 * 1024 + 4, "a")
        );
        await writeFile(
            path.join(workspaceRoot, "large.png"),
            Buffer.alloc(1024 * 1024 + 4, "p")
        );
        server = await startServer(workspaceRoot);
    });

    after(async () => {
        await server.close();
        await rm(workspaceRoot, { recursive: true, force: true });
    });

    it("lists workspace files while hiding private dotfiles", async () => {
        await symlink("broken-loop", path.join(workspaceRoot, "broken-loop"));
        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-files-outside-"));
        const escapeLink = path.join(workspaceRoot, "escape-dir");
        await symlink(outsideDir, escapeLink);
        try {
            const response = await requestJson<{ files: FileItem[]; root: string }>(
                server,
                "/api/files"
            );

            assert.equal(response.status, 200);
            assert.equal(response.body.root, workspaceRoot);
            assert.deepEqual(
                response.body.files.map((file) => file.name),
                [
                    "src",
                    ".env.example",
                    "binary.dat",
                    "large.png",
                    "large.txt",
                    "tiny.png",
                ]
            );
            assert.equal(response.body.files[0]?.type, "directory");
            assert.equal(
                response.body.files.some((file) => file.name === "broken-loop"),
                false
            );
            assert.equal(
                response.body.files.some((file) => file.name === "escape-dir"),
                false
            );
            assert.equal(
                response.body.files.some((file) => file.name === ".hidden"),
                false
            );
            const escapedDirectory = await requestJson<{ error: string }>(
                server,
                "/api/files?path=escape-dir"
            );
            assert.equal(escapedDirectory.status, 403);
            assert.equal(
                escapedDirectory.body.error,
                "Access denied: path outside workspace"
            );
        } finally {
            await rm(path.join(workspaceRoot, "broken-loop"), { force: true });
            await rm(escapeLink, { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("falls back to the default workspace root when WORKSPACE_ROOT is blank", async () => {
        const originalWorkspaceRoot = process.env.WORKSPACE_ROOT;
        const originalOpenClawHome = process.env.OPENCLAW_HOME;
        const openclawHome = await mkdtemp(path.join(os.tmpdir(), "mira-files-home-"));
        let blankServer: TestServer | undefined;
        try {
            process.env.WORKSPACE_ROOT = "";
            process.env.OPENCLAW_HOME = openclawHome;
            await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
            const { __testing, default: filesRoutes } = await import(
                `./files.js?blank=${crypto.randomUUID()}`
            );
            const app = express();
            app.use(express.json({ limit: "2mb" }));
            filesRoutes(app, express);
            const httpServer = http.createServer(app);
            await new Promise<void>((resolve, reject) => {
                const onListening = () => {
                    httpServer.off("error", onError);
                    resolve();
                };
                const onError = (error: Error) => {
                    httpServer.off("listening", onListening);
                    reject(error);
                };
                httpServer.once("listening", onListening);
                httpServer.once("error", onError);
                httpServer.listen(0);
            });
            const address = httpServer.address();
            assert.ok(address && typeof address === "object");
            blankServer = {
                baseUrl: `http://127.0.0.1:${address.port}`,
                close: () => new Promise((resolve) => httpServer.close(() => resolve())),
            };

            const response = await requestJson<{ root: string; files: FileItem[] }>(
                blankServer,
                "/api/files"
            );
            assert.equal(response.status, 200);
            assert.equal(response.body.root, __testing.getDefaultWorkspaceRoot());
        } finally {
            await blankServer?.close();
            if (originalWorkspaceRoot === undefined) {
                delete process.env.WORKSPACE_ROOT;
            } else {
                process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
            }
            if (originalOpenClawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = originalOpenClawHome;
            }
            await rm(openclawHome, { recursive: true, force: true });
        }
    });

    it("returns not found when the workspace root is missing", async () => {
        const missingRootParent = await mkdtemp(
            path.join(os.tmpdir(), "mira-files-missing-root-")
        );
        const missingServer = await startServer(
            path.join(missingRootParent, "workspace")
        );
        try {
            const response = await requestJson<{ error: string }>(
                missingServer,
                "/api/files"
            );
            assert.equal(response.status, 404);
            assert.equal(response.body.error, "Directory not found");
        } finally {
            await missingServer.close();
            await rm(missingRootParent, { recursive: true, force: true });
        }
    });

    it("covers file helper edge cases", async () => {
        const originalWorkspaceRoot = process.env.WORKSPACE_ROOT;
        const { __testing } = await import("./files.js");
        const originalOpenClawHome = process.env.OPENCLAW_HOME;
        process.env.WORKSPACE_ROOT = workspaceRoot;

        try {
            assert.equal(__testing.isBinaryFile("abc"), false);
            assert.equal(__testing.isBinaryFile("abc\0def"), true);
            assert.equal(__testing.isImageFile("photo.WEBP"), true);
            assert.equal(__testing.isImageFile("archive.txt"), false);
            assert.equal(__testing.getImageMimeType("icon.ico"), "image/x-icon");
            assert.equal(
                __testing.getImageMimeType("unknown.bin"),
                "application/octet-stream"
            );
            assert.equal(__testing.shouldHideFile(".secret"), true);
            assert.equal(__testing.shouldHideFile(".env.example"), false);
            assert.equal(__testing.compareNames("alpha", "beta"), -1);
            assert.equal(__testing.compareNames("beta", "alpha"), 1);
            assert.equal(__testing.compareNames("alpha", "alpha"), 0);
            delete process.env.OPENCLAW_HOME;
            assert.equal(
                __testing.getDefaultWorkspaceRoot(),
                path.join(os.homedir(), ".openclaw", "workspace")
            );
            process.env.OPENCLAW_HOME = "   ";
            assert.equal(
                __testing.getDefaultWorkspaceRoot(),
                path.join(os.homedir(), ".openclaw", "workspace")
            );
            process.env.OPENCLAW_HOME = "/tmp/openclaw-home";
            assert.equal(
                __testing.getDefaultWorkspaceRoot(),
                path.join("/tmp/openclaw-home", "workspace")
            );
            process.env.OPENCLAW_HOME = "relative-home";
            assert.equal(
                __testing.getDefaultWorkspaceRoot(),
                path.join(os.homedir(), ".openclaw", "workspace")
            );
            process.env.OPENCLAW_HOME = path.parse(os.homedir()).root;
            assert.equal(
                __testing.getDefaultWorkspaceRoot(),
                path.join(os.homedir(), ".openclaw", "workspace")
            );
            assert.equal(__testing.listDirectory("../../outside"), null);
            assert.throws(() => __testing.listDirectory("src/app.ts"), {
                code: "ENOTDIR",
            });
            const outsideDir = await mkdtemp(
                path.join(os.tmpdir(), "mira-files-outside-")
            );
            const escapeLink = path.join(workspaceRoot, "helper-escape-dir");
            await symlink(outsideDir, escapeLink);
            try {
                process.env.WORKSPACE_ROOT = workspaceRoot;
                const freshModule = await import(
                    `./files.js?escape=${crypto.randomUUID()}`
                );
                assert.equal(
                    freshModule.__testing.listDirectory("helper-escape-dir"),
                    null
                );
            } finally {
                if (originalWorkspaceRoot === undefined) {
                    delete process.env.WORKSPACE_ROOT;
                } else {
                    process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
                }
                await rm(escapeLink, { force: true });
                await rm(outsideDir, { recursive: true, force: true });
            }
            await mkdir(path.join(workspaceRoot, "sort"));
            await mkdir(path.join(workspaceRoot, "sort", "zeta"));
            await mkdir(path.join(workspaceRoot, "sort", "alpha-dir"));
            await writeFile(path.join(workspaceRoot, "sort", "z-file.txt"), "z");
            await writeFile(path.join(workspaceRoot, "sort", "alpha.txt"), "a");
            assert.deepEqual(
                __testing.listDirectory("sort")?.map((entry) => entry.name),
                ["alpha-dir", "zeta", "alpha.txt", "z-file.txt"]
            );
            const srcEntries = __testing.listDirectory("src");
            assert.equal(srcEntries?.[0]?.path, "src/app.ts");
        } finally {
            if (originalOpenClawHome === undefined) {
                delete process.env.OPENCLAW_HOME;
            } else {
                process.env.OPENCLAW_HOME = originalOpenClawHome;
            }
            if (originalWorkspaceRoot === undefined) {
                delete process.env.WORKSPACE_ROOT;
            } else {
                process.env.WORKSPACE_ROOT = originalWorkspaceRoot;
            }
        }
    });

    it("reads text and image files and rejects invalid paths", async () => {
        const text = await requestJson<{
            path: string;
            content: string;
            isBinary: boolean;
        }>(server, "/api/files/src%2Fapp.ts");

        assert.equal(text.status, 200);
        assert.equal(text.body.path, "src/app.ts");
        assert.equal(text.body.content, "export const ok = true;\n");
        assert.equal(text.body.isBinary, false);

        const malformedRead = await requestJson<{ error: string }>(
            server,
            "/api/files/%E0%A4%A"
        );
        assert.equal(malformedRead.status, 400);
        assert.equal(malformedRead.body.error, "Malformed URL encoding");

        const doubleEncodedMalformedRead = await requestJson<{ error: string }>(
            server,
            "/api/files/%25E0%25A4%25A"
        );
        assert.equal(doubleEncodedMalformedRead.status, 404);
        assert.equal(doubleEncodedMalformedRead.body.error, "File not found");

        const image = await requestJson<{
            isImage: boolean;
            isBinary: boolean;
            mimeType: string;
            content: string;
        }>(server, "/api/files/tiny.png");

        assert.equal(image.status, 200);
        assert.equal(image.body.isImage, true);
        assert.equal(image.body.isBinary, true);
        assert.equal(image.body.mimeType, "image/png");
        assert.equal(
            image.body.content,
            Buffer.from("89504e470d0a1a0a", "hex").toString("base64")
        );

        const binary = await requestJson<{ content: string; isBinary: boolean }>(
            server,
            "/api/files/binary.dat"
        );
        assert.equal(binary.status, 200);
        assert.equal(binary.body.content, "[Binary file]");
        assert.equal(binary.body.isBinary, true);

        const large = await requestJson<{ truncated: boolean; content: string }>(
            server,
            "/api/files/large.txt"
        );
        assert.equal(large.status, 200);
        assert.equal(large.body.truncated, true);
        assert.equal(large.body.content.length, 1024 * 1024);

        await writeFile(
            path.join(workspaceRoot, "large-binary.dat"),
            Buffer.concat([Buffer.from([0]), Buffer.alloc(1024 * 1024 + 4, "b")])
        );
        const largeBinary = await requestJson<{ truncated: boolean; content: string }>(
            server,
            "/api/files/large-binary.dat"
        );
        assert.equal(largeBinary.status, 200);
        assert.equal(largeBinary.body.truncated, true);
        assert.equal(largeBinary.body.content, "[Binary file]");

        const largeImage = await requestJson<{ error: string }>(
            server,
            "/api/files/large.png"
        );
        assert.equal(largeImage.status, 413);
        assert.equal(largeImage.body.error, "Image file is too large to preview");

        const directory = await requestJson<{ error: string }>(server, "/api/files/src");
        assert.equal(directory.status, 400);
        assert.equal(directory.body.error, "Path is a directory, not a file");

        const missing = await requestJson<{ error: string }>(
            server,
            "/api/files/missing.txt"
        );
        assert.equal(missing.status, 404);

        const nestedUnderFile = await requestJson<{ error: string }>(
            server,
            "/api/files/src%2Fapp.ts%2Fextra"
        );
        assert.equal(nestedUnderFile.status, 404);
        assert.equal(nestedUnderFile.body.error, "File not found");

        const readLinkPath = path.join(workspaceRoot, "read-link.ts");
        await symlink("src/app.ts", readLinkPath);
        try {
            const finalSymlink = await requestJson<{ error: string }>(
                server,
                "/api/files/read-link.ts"
            );
            assert.equal(finalSymlink.status, 403);
            assert.equal(
                finalSymlink.body.error,
                "Access denied: symlinks are not readable"
            );
        } finally {
            await rm(readLinkPath, { force: true });
        }

        const invalidNullByte = await requestJson<{ error: string }>(
            server,
            "/api/files/a%00b"
        );
        assert.equal(invalidNullByte.status, 404);
        assert.equal(invalidNullByte.body.error, "File not found");

        await symlink("loop", path.join(workspaceRoot, "loop"));
        try {
            const symlinkLoop = await requestJson<{ error: string }>(
                server,
                "/api/files/loop"
            );
            assert.equal(symlinkLoop.status, 403);
            assert.equal(
                symlinkLoop.body.error,
                "Access denied: symlinks are not readable"
            );
        } finally {
            await rm(path.join(workspaceRoot, "loop"), { force: true });
        }

        const denied = await requestJson<{ error: string }>(
            server,
            "/api/files/..%2Foutside.txt"
        );
        assert.equal(denied.status, 403);

        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-files-outside-"));
        try {
            await writeFile(path.join(outsideDir, "external.txt"), "external");
            await symlink(outsideDir, path.join(workspaceRoot, "read-outside-link"));
            const symlinkDenied = await requestJson<{ error: string }>(
                server,
                "/api/files/read-outside-link%2Fexternal.txt"
            );
            assert.equal(symlinkDenied.status, 403);
            assert.equal(
                symlinkDenied.body.error,
                "Access denied: path outside workspace"
            );
        } finally {
            await rm(path.join(workspaceRoot, "read-outside-link"), { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }

        const deniedList = await requestJson<{ error: string }>(
            server,
            "/api/files?path=..%2F.."
        );
        assert.equal(deniedList.status, 403);

        const fileAsDirectory = await requestJson<{ error: string }>(
            server,
            "/api/files?path=src%2Fapp.ts"
        );
        assert.equal(fileAsDirectory.status, 404);
        assert.equal(fileAsDirectory.body.error, "Directory not found");

        const nonUriError = await fetch(`${server.baseUrl}/api/files/boom`);
        assert.equal(nonUriError.status, 500);
    });

    it("uses stat identity checks for opened files on non-Linux platforms", async () => {
        const originalPlatform = process.platform;
        const originalStatSync = fs.statSync;
        try {
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: "darwin",
            });

            const response = await requestJson<{ content: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(response.status, 200);
            assert.equal(response.body.content, "export const ok = true;\n");

            fs.statSync = ((target: fs.PathLike) => {
                const stat = originalStatSync(target);
                if (target === path.join(workspaceRoot, "src", "app.ts")) {
                    return { ...stat, ino: stat.ino + 1 } as fs.Stats;
                }
                return stat;
            }) as typeof fs.statSync;

            const mismatch = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(mismatch.status, 403);
            assert.equal(mismatch.body.error, "Access denied: path outside workspace");
        } finally {
            fs.statSync = originalStatSync;
            Object.defineProperty(process, "platform", {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it("writes files, creates parents, and backs up overwritten content", async () => {
        const malformedWrite = await requestJson<{ error: string }>(
            server,
            "/api/files/%E0%A4%A",
            { method: "PUT", body: { content: "bad" } }
        );
        assert.equal(malformedWrite.status, 400);
        assert.equal(malformedWrite.body.error, "Malformed URL encoding");

        const doubleEncodedWrite = await requestJson<{ success: boolean; path: string }>(
            server,
            "/api/files/double%252Fencoded.txt",
            { method: "PUT", body: { content: "literal percent path" } }
        );
        assert.equal(doubleEncodedWrite.status, 200);
        assert.equal(doubleEncodedWrite.body.path, "double%2Fencoded.txt");

        const created = await requestJson<{
            success: boolean;
            path: string;
            size: number;
        }>(server, "/api/files/generated%2Fnote.txt", {
            method: "PUT",
            body: { content: "first" },
        });

        assert.equal(created.status, 200);
        assert.equal(created.body.success, true);
        assert.equal(created.body.path, "generated/note.txt");
        assert.equal(created.body.size, 5);
        assert.equal(
            await readFile(path.join(workspaceRoot, "generated", "note.txt"), "utf8"),
            "first"
        );

        const updated = await requestJson<{
            success: boolean;
            path: string;
            size: number;
        }>(server, "/api/files/generated%2Fnote.txt", {
            method: "PUT",
            body: { content: "second" },
        });

        assert.equal(updated.status, 200);
        assert.equal(
            await readFile(path.join(workspaceRoot, "generated", "note.txt"), "utf8"),
            "second"
        );
        assert.equal(
            await readFile(path.join(workspaceRoot, "generated", "note.txt.bak"), "utf8"),
            "first"
        );

        const missingContent = await requestJson<{ error: string }>(
            server,
            "/api/files/generated%2Fempty.txt",
            { method: "PUT", body: {} }
        );
        assert.equal(missingContent.status, 400);
        assert.equal(missingContent.body.error, "Content required");

        const missingBody = await requestJson<{ error: string }>(
            server,
            "/api/files/generated%2Fempty.txt",
            { method: "PUT" }
        );
        assert.equal(missingBody.status, 400);
        assert.equal(missingBody.body.error, "Content required");

        const oversizedContent = await requestJson<{ error: string }>(
            server,
            "/api/files/generated%2Flarge-write.txt",
            { method: "PUT", body: { content: "x".repeat(1024 * 1024 + 1) } }
        );
        assert.equal(oversizedContent.status, 413);
        assert.equal(oversizedContent.body.error, "File is too large to write");

        const deniedWrite = await requestJson<{ error: string }>(
            server,
            "/api/files/..%2Foutside.txt",
            { method: "PUT", body: { content: "nope" } }
        );
        assert.equal(deniedWrite.status, 403);
    });

    it("reports read and write filesystem errors", async () => {
        const missingRoot = path.join(workspaceRoot, "missing-root");
        const missingRootServer = await startServer(missingRoot);
        try {
            const missingRootRead = await requestJson<{ error: string }>(
                missingRootServer,
                "/api/files/anything.txt"
            );
            assert.equal(missingRootRead.status, 404);
            assert.equal(missingRootRead.body.error, "File not found");
        } finally {
            await missingRootServer.close();
            process.env.WORKSPACE_ROOT = workspaceRoot;
        }

        const target = path.join(workspaceRoot, "generated", "note.txt");
        const backup = `${target}.bak`;
        await writeFile(target, "before");
        await rm(backup, { recursive: true, force: true });
        await mkdir(backup);
        try {
            const response = await requestJson<{ error: string }>(
                server,
                "/api/files/generated%2Fnote.txt",
                { method: "PUT", body: { content: "after" } }
            );
            assert.equal(response.status, 500);
            assert.match(response.body.error, /EISDIR|directory/i);
            assert.equal(await readFile(target, "utf8"), "before");
        } finally {
            await rm(backup, { recursive: true, force: true });
        }
    });

    it("maps unexpected canonicalization failures to 500 responses", async () => {
        const originalRealpathSync = fs.realpathSync;
        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-files-outside-"));
        let mode: "root" | "opened" | "escaped-directory" = "root";
        fs.realpathSync = ((target: fs.PathLike) => {
            if (mode === "root" && target === workspaceRoot) {
                const error = new Error("root unavailable") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            if (
                mode === "opened" &&
                typeof target === "string" &&
                target.startsWith("/proc/self/fd/")
            ) {
                const error = new Error(
                    "opened file unavailable"
                ) as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            if (
                mode === "escaped-directory" &&
                target === path.join(workspaceRoot, "src")
            ) {
                return outsideDir;
            }
            return originalRealpathSync(target);
        }) as typeof fs.realpathSync;

        try {
            const listFailure = await requestJson<{ error: string }>(
                server,
                "/api/files"
            );
            assert.equal(listFailure.status, 500);
            assert.equal(listFailure.body.error, "root unavailable");

            const rootFailure = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(rootFailure.status, 500);
            assert.equal(rootFailure.body.error, "root unavailable");

            mode = "opened";
            const openedFailure = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(openedFailure.status, 500);
            assert.equal(openedFailure.body.error, "opened file unavailable");

            mode = "escaped-directory";
            const escapedDirectory = await requestJson<{ error: string }>(
                server,
                "/api/files?path=src"
            );
            assert.equal(escapedDirectory.status, 403);
            assert.equal(
                escapedDirectory.body.error,
                "Access denied: path outside workspace"
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("maps read-open races to not found or symlink responses", async () => {
        const originalOpen = fs.promises.open;
        let mode: "missing" | "symlink" | "denied" = "missing";
        fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
            const rawPath = args[0];
            const pathText = Buffer.isBuffer(rawPath)
                ? rawPath.toString()
                : String(rawPath);
            if (pathText === path.join(workspaceRoot, "src", "app.ts")) {
                const error = new Error(mode) as NodeJS.ErrnoException;
                error.code =
                    mode === "missing"
                        ? "ENOENT"
                        : mode === "symlink"
                          ? "ELOOP"
                          : "EACCES";
                throw error;
            }
            return originalOpen.apply(fs.promises, args);
        }) as typeof fs.promises.open;

        try {
            const missing = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(missing.status, 404);
            assert.equal(missing.body.error, "File not found");

            mode = "symlink";
            const symlinkRead = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(symlinkRead.status, 403);
            assert.equal(
                symlinkRead.body.error,
                "Access denied: symlinks are not readable"
            );

            mode = "denied";
            const deniedRead = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(deniedRead.status, 500);
            assert.equal(deniedRead.body.error, "denied");
        } finally {
            fs.promises.open = originalOpen;
        }
    });

    it("rejects writes through workspace symlinks", async () => {
        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-files-outside-"));
        try {
            await symlink(outsideDir, path.join(workspaceRoot, "outside-link"));
            const denied = await requestJson<{ error: string }>(
                server,
                "/api/files/outside-link%2Fnew.txt",
                { method: "PUT", body: { content: "nope" } }
            );

            assert.equal(denied.status, 403);
        } finally {
            await rm(path.join(workspaceRoot, "outside-link"), { force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("rejects writes when a missing parent resolves through a symlink", async () => {
        const outsideDir = await mkdtemp(path.join(os.tmpdir(), "mira-files-outside-"));
        try {
            await mkdir(path.join(workspaceRoot, "nested-link-parent"));
            await symlink(
                outsideDir,
                path.join(workspaceRoot, "nested-link-parent", "escape")
            );

            const denied = await requestJson<{ error: string }>(
                server,
                "/api/files/nested-link-parent%2Fescape%2Fnote.txt",
                { method: "PUT", body: { content: "nope" } }
            );

            assert.equal(denied.status, 403);
            assert.equal(denied.body.error, "Access denied: path outside workspace");
        } finally {
            await rm(path.join(workspaceRoot, "nested-link-parent"), {
                recursive: true,
                force: true,
            });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("rejects writes when parent canonicalization fails after path validation", async () => {
        const originalRealpathSync = fs.realpathSync;
        const targetParent = path.join(workspaceRoot, "race-parent");
        let parentRealpathCalls = 0;
        fs.realpathSync = ((target: fs.PathLike) => {
            const targetText = Buffer.isBuffer(target)
                ? target.toString("utf8")
                : String(target);
            if (targetText === targetParent) {
                parentRealpathCalls += 1;
                if (parentRealpathCalls > 1) {
                    const error = new Error(
                        "parent unavailable"
                    ) as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
            }
            return originalRealpathSync(target);
        }) as typeof fs.realpathSync;

        try {
            const denied = await requestJson<{ error: string }>(
                server,
                "/api/files/race-parent%2Fnote.txt",
                { method: "PUT", body: { content: "nope" } }
            );

            assert.equal(denied.status, 403);
            assert.equal(denied.body.error, "Access denied: path outside workspace");
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(targetParent, { recursive: true, force: true });
        }
    });
});
