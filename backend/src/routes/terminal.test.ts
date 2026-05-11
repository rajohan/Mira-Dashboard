import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import terminalRoutes from "./terminal.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    terminalRoutes(app);
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
    body: unknown
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("terminal routes", () => {
    let server: TestServer;
    let tempDir: string;

    before(async () => {
        server = await startServer();
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-terminal-test-"));
        await writeFile(path.join(tempDir, "alpha.txt"), "alpha");
        await writeFile(path.join(tempDir, ".hidden"), "hidden");
        await writeFile(path.join(tempDir, "run-me"), "#!/bin/sh\n");
        await chmod(path.join(tempDir, "run-me"), 0o755);
        await mkdtemp(path.join(tempDir, "app-"));
        await mkdir(path.join(tempDir, "nested"));
        await writeFile(path.join(tempDir, "nested", "inside.txt"), "inside");
        await writeFile(path.join(tempDir, "nested", "install.sh"), "#!/bin/sh\n");
        await chmod(path.join(tempDir, "nested", "install.sh"), 0o755);
    });

    after(async () => {
        await server.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    it("completes visible files, directories, and executables", async () => {
        const { status, body } = await requestJson<{
            completions: Array<{ completion: string; display: string; type: string }>;
            commonPrefix: string;
        }>(server, "/api/terminal/complete", { partial: "", cwd: tempDir });

        assert.equal(status, 400);
        assert.equal("error" in body, true);

        const completionResponse = await requestJson<{
            completions: Array<{ completion: string; display: string; type: string }>;
            commonPrefix: string;
        }>(server, "/api/terminal/complete", { partial: "a", cwd: tempDir });

        assert.equal(completionResponse.status, 200);
        assert.deepEqual(
            completionResponse.body.completions.map((item) => item.display),
            [completionResponse.body.completions[0]!.display, "alpha.txt"]
        );
        assert.equal(completionResponse.body.completions[0]?.type, "directory");
        assert.equal(completionResponse.body.commonPrefix, "");

        const executableResponse = await requestJson<{
            completions: Array<{ completion: string; display: string; type: string }>;
        }>(server, "/api/terminal/complete", { partial: "r", cwd: tempDir });

        assert.equal(executableResponse.status, 200);
        assert.equal(
            executableResponse.body.completions.some(
                (item) => item.display === ".hidden"
            ),
            false
        );
        assert.equal(executableResponse.body.completions[0]?.display, "run-me");
        assert.equal(executableResponse.body.completions[0]?.type, "executable");
    });

    it("completes nested and absolute paths with command prefixes", async () => {
        const commandCompletion = await requestJson<{
            completions: Array<{ completion: string; display: string; type: string }>;
            commonPrefix: string;
        }>(server, "/api/terminal/complete", {
            partial: "cat nested/in",
            cwd: tempDir,
        });

        assert.equal(commandCompletion.status, 200);
        assert.deepEqual(commandCompletion.body.completions, [
            {
                completion: "cat nested/install.sh",
                display: "install.sh",
                type: "executable",
            },
            {
                completion: "cat nested/inside.txt",
                display: "inside.txt",
                type: "file",
            },
        ]);
        assert.equal(commandCompletion.body.commonPrefix, "cat nested/ins");

        const absoluteCompletion = await requestJson<{
            completions: Array<{ completion: string; display: string; type: string }>;
        }>(server, "/api/terminal/complete", {
            partial: `${tempDir}/nested/i`,
            cwd: "/tmp",
        });

        assert.equal(absoluteCompletion.status, 200);
        assert.deepEqual(
            absoluteCompletion.body.completions.map((item) => item.completion),
            [`${tempDir}/nested/install.sh`, `${tempDir}/nested/inside.txt`]
        );

        const missingDir = await requestJson<{
            completions: unknown[];
            commonPrefix: string;
        }>(server, "/api/terminal/complete", {
            partial: "missing/path",
            cwd: tempDir,
        });

        assert.equal(missingDir.status, 200);
        assert.deepEqual(missingDir.body, { completions: [], commonPrefix: "" });
    });

    it("changes directories and reports invalid targets", async () => {
        const nestedDir = await mkdtemp(path.join(tempDir, "nested-"));
        await writeFile(path.join(tempDir, "not-a-dir.txt"), "file");

        const success = await requestJson<{ success: boolean; newCwd: string }>(
            server,
            "/api/terminal/cd",
            { path: path.basename(nestedDir), cwd: tempDir }
        );

        assert.equal(success.status, 200);
        assert.deepEqual(success.body, { success: true, newCwd: nestedDir });

        const parent = await requestJson<{ success: boolean; newCwd: string }>(
            server,
            "/api/terminal/cd",
            { path: "..", cwd: nestedDir }
        );

        assert.equal(parent.status, 200);
        assert.equal(parent.body.newCwd, tempDir);

        const invalid = await requestJson<{
            success: boolean;
            newCwd: string;
            error: string;
        }>(server, "/api/terminal/cd", { path: "not-a-dir.txt", cwd: tempDir });

        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.success, false);
        assert.equal(invalid.body.newCwd, tempDir);
        assert.match(invalid.body.error, /Not a directory/);

        const missingPath = await requestJson<{
            success: boolean;
            newCwd: string;
            error: string;
        }>(server, "/api/terminal/cd", { path: "missing", cwd: tempDir });
        assert.equal(missingPath.status, 400);
        assert.equal(missingPath.body.success, false);
        assert.match(missingPath.body.error, /No such file or directory/);

        const missingInput = await requestJson<{
            success: boolean;
            newCwd: string;
            error: string;
        }>(server, "/api/terminal/cd", { path: "", cwd: tempDir });
        assert.equal(missingInput.status, 400);
        assert.deepEqual(missingInput.body, {
            success: false,
            newCwd: tempDir,
            error: "Missing or invalid path",
        });

        const home = await requestJson<{ success: boolean; newCwd: string }>(
            server,
            "/api/terminal/cd",
            { path: "~", cwd: tempDir }
        );
        assert.equal(home.status, 200);
        assert.equal(home.body.newCwd, os.homedir());

        const absolute = await requestJson<{ success: boolean; newCwd: string }>(
            server,
            "/api/terminal/cd",
            { path: nestedDir, cwd: "/tmp" }
        );
        assert.equal(absolute.status, 200);
        assert.equal(absolute.body.newCwd, nestedDir);
    });
});
