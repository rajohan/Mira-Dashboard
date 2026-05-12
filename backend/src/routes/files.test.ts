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

interface FileItem {
    name: string;
    type: "file" | "directory";
    path: string;
    size?: number;
}

async function startServer(workspaceRoot: string): Promise<TestServer> {
    process.env.WORKSPACE_ROOT = workspaceRoot;
    const { default: filesRoutes } = await import("./files.js");

    const app = express();
    app.use(express.json({ limit: "2mb" }));
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
        server = await startServer(workspaceRoot);
    });

    after(async () => {
        await server.close();
        await rm(workspaceRoot, { recursive: true, force: true });
    });

    it("lists workspace files while hiding private dotfiles", async () => {
        const response = await requestJson<{ files: FileItem[]; root: string }>(
            server,
            "/api/files"
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.root, workspaceRoot);
        assert.deepEqual(
            response.body.files.map((file) => file.name),
            ["src", ".env.example", "tiny.png"]
        );
        assert.equal(response.body.files[0]?.type, "directory");
        assert.equal(
            response.body.files.some((file) => file.name === ".hidden"),
            false
        );
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

        const deniedList = await requestJson<{ error: string }>(
            server,
            "/api/files?path=..%2F.."
        );
        assert.equal(deniedList.status, 403);
    });

    it("writes files, creates parents, and backs up overwritten content", async () => {
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
});
