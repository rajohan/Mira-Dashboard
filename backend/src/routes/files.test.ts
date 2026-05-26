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

interface FileItem {
    name: string;
    type: "file" | "directory";
    path: string;
    size?: number;
    error?: boolean;
}

async function startServer(workspaceRoot: string): Promise<TestServer> {
    process.env.WORKSPACE_ROOT = workspaceRoot;
    const { default: filesRoutes } = await import(`./files.js?test=${Date.now()}`);

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/files/boom", (_req, _res, next) => {
        next(new Error("boom"));
    });
    filesRoutes(app, express);
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
                    "broken-loop",
                    "large.png",
                    "large.txt",
                    "tiny.png",
                ]
            );
            assert.equal(response.body.files[0]?.type, "directory");
            assert.equal(
                response.body.files.find((file) => file.name === "broken-loop")?.error,
                true
            );
            assert.equal(
                response.body.files.some((file) => file.name === ".hidden"),
                false
            );
        } finally {
            await rm(path.join(workspaceRoot, "broken-loop"), { force: true });
        }
    });

    it("covers file helper edge cases", async () => {
        const { __testing } = await import("./files.js");

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
        assert.equal(__testing.listDirectory("../../outside"), null);
        assert.deepEqual(__testing.listDirectory("src/app.ts"), []);
        const srcEntries = __testing.listDirectory("src");
        assert.equal(srcEntries?.[0]?.path, "src/app.ts");
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
        assert.equal(doubleEncodedMalformedRead.status, 400);
        assert.equal(doubleEncodedMalformedRead.body.error, "Malformed URL encoding");

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
        const originalRealpathSync = fs.realpathSync;
        fs.realpathSync = ((target: fs.PathLike) =>
            target === readLinkPath
                ? readLinkPath
                : originalRealpathSync(target)) as typeof fs.realpathSync;
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
            fs.realpathSync = originalRealpathSync;
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
            assert.equal(symlinkLoop.status, 404);
            assert.equal(symlinkLoop.body.error, "File not found");
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

        const nonUriError = await fetch(`${server.baseUrl}/api/files/boom`);
        assert.equal(nonUriError.status, 500);
    });

    it("writes files, creates parents, and backs up overwritten content", async () => {
        const malformedWrite = await requestJson<{ error: string }>(
            server,
            "/api/files/%E0%A4%A",
            { method: "PUT", body: { content: "bad" } }
        );
        assert.equal(malformedWrite.status, 400);
        assert.equal(malformedWrite.body.error, "Malformed URL encoding");

        const doubleEncodedMalformedWrite = await requestJson<{ error: string }>(
            server,
            "/api/files/%25E0%25A4%25A",
            { method: "PUT", body: { content: "bad" } }
        );
        assert.equal(doubleEncodedMalformedWrite.status, 400);
        assert.equal(doubleEncodedMalformedWrite.body.error, "Malformed URL encoding");

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
        let mode: "root" | "candidate" = "root";
        fs.realpathSync = ((target: fs.PathLike) => {
            if (mode === "root" && target === workspaceRoot) {
                const error = new Error("root unavailable") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            if (
                mode === "candidate" &&
                target === path.join(workspaceRoot, "src", "app.ts")
            ) {
                const error = new Error("candidate unavailable") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            return originalRealpathSync(target);
        }) as typeof fs.realpathSync;

        try {
            const rootFailure = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(rootFailure.status, 500);
            assert.equal(rootFailure.body.error, "root unavailable");

            mode = "candidate";
            const candidateFailure = await requestJson<{ error: string }>(
                server,
                "/api/files/src%2Fapp.ts"
            );
            assert.equal(candidateFailure.status, 500);
            assert.equal(candidateFailure.body.error, "candidate unavailable");
        } finally {
            fs.realpathSync = originalRealpathSync;
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
