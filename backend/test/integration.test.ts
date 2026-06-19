import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

let baseUrl = "";
let server: http.Server;
let tempRoot = "";

async function api<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...options.headers,
        },
    });
    const text = await response.text();
    return {
        status: response.status,
        body: text ? (JSON.parse(text) as T) : (undefined as T),
    };
}

function json(method: string, body: unknown): RequestInit {
    return {
        method,
        body: JSON.stringify(body),
    };
}

describe("Mira Dashboard backend integration", () => {
    beforeAll(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mira-dashboard-test-"));
        const workspaceRoot = path.join(tempRoot, "workspace");
        const openclawRoot = path.join(tempRoot, "openclaw");
        const frontendRoot = path.join(tempRoot, "frontend");
        await fs.mkdir(path.join(openclawRoot, "hooks", "transforms"), {
            recursive: true,
        });
        await fs.mkdir(path.join(frontendRoot, "assets"), { recursive: true });
        await fs.mkdir(workspaceRoot, { recursive: true });
        await fs.writeFile(path.join(workspaceRoot, "README.md"), "hello workspace\n");
        await fs.writeFile(path.join(openclawRoot, "openclaw.json"), "{}\n");
        await fs.writeFile(
            path.join(frontendRoot, "index.html"),
            '<!doctype html><html><body><div id="root"></div></body></html>'
        );
        await fs.writeFile(
            path.join(frontendRoot, "assets", "index-fixture.js"),
            "export const ok = true;\n"
        );

        process.env.MIRA_DASHBOARD_DB_PATH = path.join(tempRoot, "dashboard.db");
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.WORKSPACE_ROOT = workspaceRoot;
        process.env.OPENCLAW_HOME = openclawRoot;
        process.env.TRUST_PROXY = "false";

        const serverModule = await import("../src/server.js");
        server = serverModule.server;
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Test server did not bind to a TCP port");
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it("reports health and auth bootstrap state without production data", async () => {
        const health = await api<{ status: string; sessionCount: number }>("/api/health");
        expect(health.status).toBe(200);
        expect(health.body.status).toBe("ok");
        expect(health.body.sessionCount).toBe(0);

        const bootstrap = await api<{
            bootstrapRequired: boolean;
            hasGatewayToken: boolean;
        }>("/api/auth/bootstrap");
        expect(bootstrap.status).toBe(200);
        expect(bootstrap.body).toEqual({
            bootstrapRequired: true,
            hasGatewayToken: false,
        });
    });

    it("serves the app shell only for app routes, not missing assets", async () => {
        const appRoute = await fetch(`${baseUrl}/tasks`);
        expect(appRoute.status).toBe(200);
        expect(appRoute.headers.get("content-type")).toContain("text/html");

        const assetsPath = path.join(tempRoot, "frontend", "assets");
        const builtAssets = await fs.readdir(assetsPath);
        const builtChunk = builtAssets.find((file) => /^index-.+\.js$/u.test(file));
        expect(builtChunk).toBeDefined();

        const rootChunk = await fetch(`${baseUrl}/${builtChunk}`);
        expect(rootChunk.status).toBe(200);
        expect(rootChunk.headers.get("content-type")).toContain("javascript");

        const missingChunk = await fetch(
            `${baseUrl}/assets/index-missing-after-deploy.js`
        );
        expect(missingChunk.status).toBe(404);
        expect(missingChunk.headers.get("content-type")).not.toContain("text/html");
    });

    it("creates, moves, updates, and deletes tasks through the API", async () => {
        const created = await api<{
            number: number;
            title: string;
            labels: Array<{ name: string }>;
            assignees: Array<{ login: string }>;
        }>(
            "/api/tasks",
            json("POST", {
                title: "Functional backend test",
                body: "Exercise the API, not private helpers",
                labels: ["priority-high"],
                assignee: "rajohan",
            })
        );
        expect(created.status).toBe(201);
        expect(created.body.title).toBe("Functional backend test");
        expect(created.body.labels.map((label) => label.name)).toContain("todo");
        expect(created.body.assignees[0]?.login).toBe("rajohan");

        const moved = await api<{ labels: Array<{ name: string }>; state: string }>(
            `/api/tasks/${created.body.number}/move`,
            json("POST", { columnLabel: "done" })
        );
        expect(moved.status).toBe(200);
        expect(moved.body.state).toBe("CLOSED");
        expect(moved.body.labels.map((label) => label.name)).toContain("done");

        const update = await api<{ messageMd: string }>(
            `/api/tasks/${created.body.number}/updates`,
            json("POST", {
                author: "rajohan",
                messageMd: "Verified through HTTP",
            })
        );
        expect(update.status).toBe(201);
        expect(update.body.messageMd).toBe("Verified through HTTP");

        const list = await api<Array<{ number: number; title: string }>>("/api/tasks");
        expect(list.status).toBe(200);
        expect(list.body.some((task) => task.number === created.body.number)).toBe(true);

        const deleted = await api<{ ok: boolean }>(`/api/tasks/${created.body.number}`, {
            method: "DELETE",
        });
        expect(deleted.status).toBe(200);
        expect(deleted.body.ok).toBe(true);
    });

    it("uses isolated workspace and config roots for file APIs", async () => {
        const files = await api<{ files: Array<{ path: string }>; root: string }>(
            "/api/files"
        );
        expect(files.status).toBe(200);
        expect(files.body.root).toBe(path.join(tempRoot, "workspace"));
        expect(files.body.files.map((file) => file.path)).toContain("README.md");

        const readFile = await api<{ content: string }>("/api/files/README.md");
        expect(readFile.status).toBe(200);
        expect(readFile.body.content).toBe("hello workspace\n");

        const writeFile = await api<{ success: boolean; path: string }>(
            "/api/files/notes/test.md",
            json("PUT", { content: "created in temp workspace\n" })
        );
        expect(writeFile.status).toBe(200);
        expect(writeFile.body).toMatchObject({
            success: true,
            path: "notes/test.md",
        });

        const traversal = await api<{ error: string }>("/api/files/..%2Foutside.txt");
        expect(traversal.status).toBe(403);

        const config = await api<{ content: string; relPath: string }>(
            "/api/config-files/openclaw.json"
        );
        expect(config.status).toBe(200);
        expect(config.body).toMatchObject({
            content: "{}\n",
            relPath: "openclaw.json",
        });
    });
});
