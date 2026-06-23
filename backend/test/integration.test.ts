import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testState: {
    baseUrl: string;
    originalLoopbackAuth?: string;
    server?: Server<unknown>;
    temporaryRoot: string;
} = {
    baseUrl: "",
    temporaryRoot: "",
};

async function api<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${testState.baseUrl}${endpoint}`, {
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

async function createTestServer(
    createServer: (port: number) => Server<unknown>
): Promise<Server<unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            return createServer(0);
        } catch (error) {
            lastError = error;
            if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
                throw error;
            }
        }
    }
    throw lastError;
}

describe("Mira Dashboard backend integration", () => {
    beforeAll(async () => {
        testState.temporaryRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "mira-dashboard-test-")
        );
        const workspaceRoot = path.join(testState.temporaryRoot, "workspace");
        const openclawRoot = path.join(testState.temporaryRoot, "openclaw");
        const frontendRoot = path.join(testState.temporaryRoot, "frontend");
        const dockerRoot = path.join(testState.temporaryRoot, "docker");
        const composeWrapper = path.join(testState.temporaryRoot, "compose-wrapper.sh");
        await fs.mkdir(path.join(openclawRoot, "hooks", "transforms"), {
            recursive: true,
        });
        await fs.mkdir(path.join(frontendRoot, "assets"), { recursive: true });
        await fs.mkdir(dockerRoot, { recursive: true });
        await fs.mkdir(workspaceRoot, { recursive: true });
        await fs.mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
        await fs.writeFile(path.join(workspaceRoot, "README.md"), "hello workspace\n");
        await fs.writeFile(path.join(openclawRoot, "openclaw.json"), "{}\n");
        await fs.writeFile(composeWrapper, "#!/bin/sh\nprintf 'compose:%s\\n' \"$*\"\n");
        await fs.chmod(composeWrapper, 0o755);
        await fs.writeFile(
            path.join(frontendRoot, "index.html"),
            '<!doctype html><html><body><div id="root"></div></body></html>'
        );
        await fs.writeFile(
            path.join(frontendRoot, "assets", "index-fixture.js"),
            "export const isOk = true;\n"
        );

        testState.originalLoopbackAuth = process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH;
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(
            testState.temporaryRoot,
            "dashboard.database"
        );
        process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH = "1";
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.WORKSPACE_ROOT = workspaceRoot;
        process.env.OPENCLAW_HOME = openclawRoot;
        process.env.MIRA_DOCKER_ROOT = dockerRoot;
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER = composeWrapper;
        process.env.TRUST_PROXY = "false";

        const serverModule = await import("../src/server.ts");
        testState.server = await createTestServer(serverModule.createServer);
        testState.baseUrl = `http://127.0.0.1:${testState.server.port}`;
    });

    afterAll(async () => {
        const server = testState.server;
        await server?.stop(true);
        if (testState.originalLoopbackAuth === undefined) {
            delete process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH;
        } else {
            process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH =
                testState.originalLoopbackAuth;
        }
        await fs.rm(testState.temporaryRoot, { recursive: true, force: true });
    });

    it("reports health and auth bootstrap state without production data", async () => {
        const health = await api<{ status: string; sessionCount: number }>("/api/health");
        expect(health.status).toBe(200);
        expect(health.body.status).toBe("isOk");
        expect(health.body.sessionCount).toBe(0);

        const bootstrap = await api<{
            isBootstrapRequired: boolean;
            hasGatewayToken: boolean;
        }>("/api/auth/bootstrap");
        expect(bootstrap.status).toBe(200);
        expect(bootstrap.body).toEqual({
            isBootstrapRequired: true,
            hasGatewayToken: false,
        });

        const bootstrapSession = await api<{
            authenticated: boolean;
            isBootstrapRequired: boolean;
            user?: { id: number; username: string };
        }>("/api/auth/session");
        expect(bootstrapSession.status).toBe(200);
        expect(bootstrapSession.body).toEqual({
            authenticated: false,
            isBootstrapRequired: true,
        });

        const { createUser } = await import("../src/auth.ts");
        createUser("session-test-user", "test-password");

        const authenticatedSession = await api<{
            authenticated: boolean;
            isBootstrapRequired: boolean;
            user?: { id: number; username: string };
        }>("/api/auth/session");
        expect(authenticatedSession.status).toBe(200);
        expect(authenticatedSession.body).toEqual({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 0, username: "mira-local" },
        });
    });

    it("serves the app shell only for app routes, not missing assets", async () => {
        const appRoute = await fetch(`${testState.baseUrl}/tasks`);
        expect(appRoute.status).toBe(200);
        expect(appRoute.headers.get("content-type")).toContain("text/html");

        const assetsPath = path.join(testState.temporaryRoot, "frontend", "assets");
        const builtAssets = await fs.readdir(assetsPath);
        const builtChunk = builtAssets.find((file) => /^index-.+\.js$/u.test(file));
        expect(builtChunk).toBeDefined();

        const rootChunk = await fetch(`${testState.baseUrl}/${builtChunk}`);
        expect(rootChunk.status).toBe(200);
        expect(rootChunk.headers.get("cache-control")).toBe("no-store");

        const missingChunk = await fetch(
            `${testState.baseUrl}/assets/index-missing-after-deploy.js`
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

        const deleted = await api<{ isOk: boolean }>(
            `/api/tasks/${created.body.number}`,
            {
                method: "DELETE",
            }
        );
        expect(deleted.status).toBe(200);
        expect(deleted.body.isOk).toBe(true);
    });

    it("uses isolated workspace and config roots for file APIs", async () => {
        const files = await api<{ files: Array<{ path: string }>; root: string }>(
            "/api/files"
        );
        expect(files.status).toBe(200);
        expect(files.body.root).toBe(path.join(testState.temporaryRoot, "workspace"));
        expect(files.body.files.map((file) => file.path)).toContain("README.md");

        const readFile = await api<{ content: string }>("/api/files/README.md");
        expect(readFile.status).toBe(200);
        expect(readFile.body.content).toBe("hello workspace\n");

        const writeFile = await api<{ isSuccess: boolean; path: string }>(
            "/api/files/notes/test.md",
            json("PUT", { content: "created in temp workspace\n" })
        );
        expect(writeFile.status).toBe(200);
        expect(writeFile.body).toMatchObject({
            isSuccess: true,
            path: "notes/test.md",
        });

        const traversal = await api<{ error: string }>("/api/files/..%2Foutside.txt");
        expect(traversal.status).toBe(403);

        const config = await api<{ content: string; relativePath: string }>(
            "/api/config-files/openclaw.json"
        );
        expect(config.status).toBe(200);
        expect(config.body).toMatchObject({
            content: "{}\n",
            relativePath: "openclaw.json",
        });
    });

    it("allows valid dotted Docker Compose service names", async () => {
        const result = await api<{ output: string }>(
            "/api/docker/stack/action",
            json("POST", { action: "restart", service: "api.v1" })
        );

        expect(result.status).toBe(200);
        expect(result.body.output).toBe("compose:restart api.v1");
    });

    it("rejects Docker Compose service names that look like options", async () => {
        const result = await api<{ error: string }>(
            "/api/docker/stack/action",
            json("POST", { action: "restart", service: "--profile" })
        );

        expect(result.status).toBe(400);
        expect(result.body.error).toBe("Invalid service name");
    });
});
