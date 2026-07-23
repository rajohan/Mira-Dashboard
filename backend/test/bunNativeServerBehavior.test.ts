import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const state: {
    baseUrl: string;
    child?: ReturnType<typeof Bun.spawn>;
    temporaryRoot: string;
} = {
    baseUrl: "",
    temporaryRoot: "",
};

async function api<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<{ body: T; status: number }> {
    const response = await fetch(`${state.baseUrl}${endpoint}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
    });
    const text = await response.text();
    return {
        body: text ? (JSON.parse(text) as T) : (undefined as T),
        status: response.status,
    };
}

function json(method: string, body: unknown): RequestInit {
    return { body: JSON.stringify(body), method };
}

function canRemoveTemporaryRoot(temporaryRoot: string): boolean {
    return (
        temporaryRoot !== "" &&
        path.isAbsolute(temporaryRoot) &&
        path.basename(temporaryRoot).startsWith("mira-dashboard-bun-test-")
    );
}

async function drainReader(
    reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> },
    decoder: TextDecoder
): Promise<void> {
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            decoder.decode(next.value, { stream: true });
        }
        decoder.decode();
    } catch {
        // Test cleanup should not fail because the child stdout stream closed.
    }
}

describe("Bun-native dashboard backend", () => {
    beforeAll(async () => {
        state.temporaryRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "mira-dashboard-bun-test-")
        );
        const workspaceRoot = path.join(state.temporaryRoot, "workspace");
        const openclawRoot = path.join(state.temporaryRoot, "openclaw");
        const frontendRoot = path.join(state.temporaryRoot, "frontend");
        const dockerRoot = path.join(state.temporaryRoot, "docker");
        const composeWrapper = path.join(state.temporaryRoot, "compose-wrapper.sh");
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
            path.join(frontendRoot, "index-fixture.js"),
            "export const isOk = true;\n"
        );
        const serverScript = path.join(state.temporaryRoot, "native-server.ts");
        const serverModulePath = path.resolve(import.meta.dirname, "../src/server.ts");
        const dockerActionsModulePath = path.resolve(
            import.meta.dirname,
            "../src/services/dockerActions.ts"
        );
        const scheduledJobsModulePath = path.resolve(
            import.meta.dirname,
            "../src/services/scheduledJobs.ts"
        );
        const serverModuleUrl = pathToFileURL(serverModulePath).href;
        const dockerActionsModuleUrl = pathToFileURL(dockerActionsModulePath).href;
        const scheduledJobsModuleUrl = pathToFileURL(scheduledJobsModulePath).href;
        await fs.writeFile(
            serverScript,
            [
                `import { createServer } from ${JSON.stringify(serverModuleUrl)};`,
                `import { registerDockerExecutionActions } from ${JSON.stringify(dockerActionsModuleUrl)};`,
                `import { startScheduledJobExecutor, stopScheduledJobExecutor } from ${JSON.stringify(scheduledJobsModuleUrl)};`,
                "registerDockerExecutionActions();",
                "startScheduledJobExecutor();",
                "const server = createServer(0);",
                "console.log(JSON.stringify({ port: server.port }));",
                "process.on('SIGTERM', () => { Promise.all([server.stop(true), stopScheduledJobExecutor()]).then(() => process.exit(0)).catch(() => process.exit(1)); });",
            ].join("\n")
        );

        const child = Bun.spawn({
            cmd: ["bun", serverScript],
            cwd: path.resolve(import.meta.dirname, ".."),
            env: {
                ...process.env,
                MIRA_DASHBOARD_DB_PATH: path.join(
                    state.temporaryRoot,
                    "dashboard.database"
                ),
                MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH: "1",
                MIRA_DASHBOARD_FRONTEND_PATH: frontendRoot,
                MIRA_DOCKER_COMPOSE_WRAPPER: composeWrapper,
                MIRA_DOCKER_ROOT: dockerRoot,
                OPENCLAW_HOME: openclawRoot,
                MIRA_DASHBOARD_TRUSTED_PROXY_IPS: "",
                WORKSPACE_ROOT: workspaceRoot,
            },
            stderr: "inherit",
            stdin: "ignore",
            stdout: "pipe",
        });
        state.child = child;
        let stdout = "";
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        const startupTimeoutMs = 10_000;
        while (!stdout.includes("\n")) {
            const exited = (async () => {
                const code = await child.exited;
                return { code, done: true as const };
            })();
            let startupTimer: Timer | undefined;
            const startupTimeout = new Promise<never>((_, reject) => {
                startupTimer = setTimeout(
                    () => reject(new Error("Native server startup timed out")),
                    startupTimeoutMs
                );
            });
            let next:
                Awaited<ReturnType<typeof reader.read>> | { code: number; done: true };
            try {
                next = await Promise.race([reader.read(), exited, startupTimeout]);
            } finally {
                if (startupTimer) clearTimeout(startupTimer);
            }
            if ("code" in next) {
                throw new Error(`Native server exited early: ${next.code}`);
            }
            if (next.done) {
                throw new Error("Native server exited before printing port");
            }
            stdout += decoder.decode(next.value, { stream: true });
        }
        const firstLine = stdout.split("\n").find((line) => line.trim());
        if (!firstLine) {
            throw new Error("Native server did not print port");
        }
        void drainReader(reader, decoder);
        const { port } = JSON.parse(firstLine) as { port: number };
        state.baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        state.child?.kill("SIGTERM");
        if (state.child) {
            let shutdownTimer: Timer | undefined;
            let didExitGracefully: boolean;
            try {
                didExitGracefully = await Promise.race([
                    (async () => {
                        await state.child!.exited;
                        return true;
                    })(),
                    new Promise<false>((resolve) => {
                        shutdownTimer = setTimeout(() => resolve(false), 1000);
                    }),
                ]);
            } finally {
                if (shutdownTimer) clearTimeout(shutdownTimer);
            }
            if (!didExitGracefully) {
                state.child.kill("SIGKILL");
                try {
                    await state.child.exited;
                } catch {
                    // Process termination during cleanup should not fail the suite.
                }
            }
        }
        if (canRemoveTemporaryRoot(state.temporaryRoot)) {
            await fs.rm(state.temporaryRoot, { recursive: true, force: true });
        }
    });

    it("reports health and auth bootstrap state", async () => {
        const health = await api<{ status: string; sessionCount: number }>("/api/health");
        expect(health.status).toBe(200);
        expect(health.body.status).toBe("isOk");
        expect(health.body.sessionCount).toBe(0);

        const bootstrap = await api<{
            hasGatewayToken: boolean;
            isBootstrapRequired: boolean;
        }>("/api/auth/bootstrap");
        expect(bootstrap.status).toBe(200);
        expect(bootstrap.body).toEqual({
            hasGatewayToken: false,
            isBootstrapRequired: true,
        });
    });

    it("does not grant loopback API access when forwarded client headers are present", async () => {
        const response = await fetch(`${state.baseUrl}/api/tasks`, {
            headers: { "x-real-ip": "10.0.0.25" },
        });
        expect(response.status).toBe(401);
    });

    it("rate limits auth routes using native Bun policy", async () => {
        let latest = new Response();
        for (let index = 0; index < 21; index += 1) {
            latest = await fetch(`${state.baseUrl}/api/auth/bootstrap`, {
                headers: { "x-forwarded-for": "203.0.113.44" },
            });
        }

        expect(latest.status).toBe(429);
        expect(latest.headers.get("ratelimit-policy")).toBe("20;w=60");
        expect(latest.headers.get("retry-after")).toBeTruthy();
        expect(await latest.json()).toEqual({
            error: "Too many authentication attempts, please try again later",
        });
    });

    it("accepts native dashboard WebSocket connections from loopback", async () => {
        const ws = new WebSocket(state.baseUrl.replace("http://", "ws://") + "/ws");
        const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("Timed out waiting for ws state")),
                1000
            );
            ws.addEventListener("message", (event) => {
                clearTimeout(timer);
                resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
            });
            ws.addEventListener("error", () => {
                clearTimeout(timer);
                reject(new Error("WebSocket failed"));
            });
        });
        ws.close();

        expect(message).toMatchObject({
            gatewayConnected: false,
            sessions: [],
            type: "state",
        });
    });

    it("serves the app shell and hashed static assets", async () => {
        const appRoute = await fetch(`${state.baseUrl}/tasks`);
        expect(appRoute.status).toBe(200);
        expect(appRoute.headers.get("content-type")).toContain("text/html");

        const rootChunk = await fetch(`${state.baseUrl}/index-fixture.js`);
        expect(rootChunk.status).toBe(200);
        expect(rootChunk.headers.get("cache-control")).toBe("no-store");

        const missingChunk = await fetch(
            `${state.baseUrl}/assets/index-missing-after-deploy.js`
        );
        expect(missingChunk.status).toBe(404);
        expect(missingChunk.headers.get("content-type")).not.toContain("text/html");
    });

    it("creates, moves, updates, and deletes tasks through native routes", async () => {
        const created = await api<{
            assignees: Array<{ login: string }>;
            labels: Array<{ name: string }>;
            number: number;
            title: string;
        }>(
            "/api/tasks",
            json("POST", {
                assignee: "rajohan",
                body: "Exercise native Bun routes",
                labels: ["priority-high"],
                title: "Functional Bun backend test",
            })
        );
        expect(created.status).toBe(201);
        expect(created.body.title).toBe("Functional Bun backend test");
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
            json("POST", { author: "rajohan", messageMd: "Verified through Bun" })
        );
        expect(update.status).toBe(201);
        expect(update.body.messageMd).toBe("Verified through Bun");

        const deleted = await api<{ isOk: boolean }>(
            `/api/tasks/${created.body.number}`,
            { method: "DELETE" }
        );
        expect(deleted.status).toBe(200);
        expect(deleted.body.isOk).toBe(true);
    });

    it("uses isolated workspace and config roots", async () => {
        const files = await api<{ files: Array<{ path: string }>; root: string }>(
            "/api/files"
        );
        expect(files.status).toBe(200);
        expect(files.body.root).toBe(path.join(state.temporaryRoot, "workspace"));
        expect(files.body.files.map((file) => file.path)).toContain("README.md");

        const readFile = await api<{ content: string }>("/api/files/README.md");
        expect(readFile.status).toBe(200);
        expect(readFile.body.content).toBe("hello workspace\n");

        const writeFile = await api<{ isSuccess: boolean; path: string }>(
            "/api/files/notes/test.md",
            json("PUT", { content: "created in temp workspace\n" })
        );
        expect(writeFile.status).toBe(200);
        expect(writeFile.body).toMatchObject({ isSuccess: true, path: "notes/test.md" });

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
