import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testState: {
    baseUrl: string;
    openclawRoot: string;
    originalEnv: Record<string, string | undefined>;
    server?: Server<unknown>;
    temporaryRoot: string;
} = {
    baseUrl: "",
    openclawRoot: "",
    originalEnv: {},
    temporaryRoot: "",
};

const TEST_ENV_KEYS = [
    "HOME",
    "MIRA_DASHBOARD_DB_PATH",
    "MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH",
    "MIRA_DASHBOARD_FRONTEND_PATH",
    "MIRA_DASHBOARD_LOGS_ROOT",
    "MIRA_DOCKER_COMPOSE_WRAPPER",
    "MIRA_DOCKER_ROOT",
    "OPENCLAW_HOME",
    "TRUST_PROXY",
    "WORKSPACE_ROOT",
] as const;

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

function table(headers: string[], rows: string[][]): string {
    return [headers.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n");
}

async function writeFakeDocker(binaryPath: string): Promise<void> {
    const outputs: Record<string, string> = {
        activity: table(
            ["state", "count"],
            [
                ["active", "1"],
                ["idle", "2"],
            ]
        ),
        bitmagnet: table(["count"], [["11"]]),
        comet: table(["count"], [["7"]]),
        databases: table(["datname"], [["mira"]]),
        deadTuples: table(
            [
                "schemaname",
                "relname",
                "n_live_tup",
                "n_dead_tup",
                "dead_pct",
                "last_autovacuum",
                "last_autoanalyze",
            ],
            [["public", "tasks", "20", "2", "10", "2026-06-23", ""]]
        ),
        extensions: table(["extname"], [["pg_stat_statements"]]),
        pgbouncerPools: table(
            [
                "database",
                "user",
                "cl_active",
                "cl_waiting",
                "sv_active",
                "sv_idle",
                "sv_used",
                "maxwait",
                "pool_mode",
            ],
            [["mira", "postgres", "1", "0", "1", "1", "1", "0", "transaction"]]
        ),
        pgbouncerStats: table(
            [
                "database",
                "total_xact_count",
                "total_query_count",
                "total_xact_time",
                "total_query_time",
                "avg_xact_time",
                "avg_query_time",
                "total_received",
                "total_sent",
            ],
            [["mira", "5", "6", "50", "60", "10", "10", "512", "1024"]]
        ),
        stats: table(
            [
                "datname",
                "size_pretty",
                "size_bytes",
                "numbackends",
                "xact_commit",
                "xact_rollback",
                "blks_hit",
                "blks_read",
                "cache_hit_ratio",
            ],
            [["mira", "2 MB", "2097152", "3", "50", "1", "80", "20", "80"]]
        ),
        topQueries: table(
            [
                "query",
                "calls",
                "total_exec_time",
                "mean_exec_time",
                "rows",
                "shared_blks_hit",
                "shared_blks_read",
            ],
            [["SELECT now()", "2", "6", "3", "2", "5", "0"]]
        ),
    };
    const script = `#!/usr/bin/env bun
const arguments_ = process.argv.slice(2);
const sql = arguments_.at(-1) ?? "";
const command = arguments_.join(" ");
const outputs = ${JSON.stringify(outputs)};
let key = "";
if (sql.includes("FROM torrents")) {
  key = command.includes("/comet") ? "comet" : "bitmagnet";
} else if (sql.includes("FROM pg_stat_database")) {
  key = "stats";
} else if (sql.includes("FROM pg_stat_activity")) {
  key = "activity";
} else if (sql.includes("FROM pg_database")) {
  key = "databases";
} else if (sql.includes("FROM pg_stat_user_tables")) {
  key = "deadTuples";
} else if (sql.includes("FROM pg_extension")) {
  key = "extensions";
} else if (sql.includes("FROM pg_stat_statements")) {
  key = "topQueries";
} else if (sql === "SHOW POOLS;") {
  key = "pgbouncerPools";
} else if (sql === "SHOW STATS;") {
  key = "pgbouncerStats";
}
process.stdout.write(outputs[key] ?? "");
`;
    await fs.writeFile(binaryPath, script);
    await fs.chmod(binaryPath, 0o755);
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
        testState.originalEnv = Object.fromEntries(
            TEST_ENV_KEYS.map((key) => [key, process.env[key]])
        );
        testState.temporaryRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "mira-dashboard-test-")
        );
        const workspaceRoot = path.join(testState.temporaryRoot, "workspace");
        const openclawRoot = path.join(testState.temporaryRoot, "openclaw");
        testState.openclawRoot = openclawRoot;
        const homeRoot = path.join(testState.temporaryRoot, "home");
        const frontendRoot = path.join(testState.temporaryRoot, "frontend");
        const dockerRoot = path.join(testState.temporaryRoot, "docker");
        const composeWrapper = path.join(testState.temporaryRoot, "compose-wrapper.sh");
        await fs.mkdir(path.join(openclawRoot, "hooks", "transforms"), {
            recursive: true,
        });
        await fs.mkdir(path.join(openclawRoot, "media", "images"), {
            recursive: true,
        });
        await fs.mkdir(path.join(frontendRoot, "assets"), { recursive: true });
        await fs.mkdir(dockerRoot, { recursive: true });
        await fs.mkdir(homeRoot, { recursive: true });
        await fs.mkdir(workspaceRoot, { recursive: true });
        await fs.mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
        await fs.writeFile(path.join(workspaceRoot, "README.md"), "hello workspace\n");
        await fs.writeFile(path.join(openclawRoot, "openclaw.json"), "{}\n");
        await fs.writeFile(
            path.join(openclawRoot, "media", "images", "dashboard-test.txt"),
            "media fixture\n"
        );
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

        process.env.MIRA_DASHBOARD_DB_PATH = path.join(
            testState.temporaryRoot,
            "dashboard.database"
        );
        process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH = "1";
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.HOME = homeRoot;
        process.env.WORKSPACE_ROOT = workspaceRoot;
        process.env.OPENCLAW_HOME = openclawRoot;
        process.env.MIRA_DASHBOARD_LOGS_ROOT = openclawRoot;
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
        const { closeDatabaseForTests } = await import("../src/database.ts");
        closeDatabaseForTests();
        for (const key of TEST_ENV_KEYS) {
            const originalValue = testState.originalEnv[key];
            if (originalValue === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = originalValue;
            }
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

        const preBootstrapLogin = await api<{ error: string }>(
            "/api/auth/login",
            json("POST", { username: "session-test-user", password: "test-password" })
        );
        expect(preBootstrapLogin.status).toBe(409);
        expect(preBootstrapLogin.body.error).toBe(
            "Create the first user before logging in"
        );

        const invalidBootstrap = await api<{ error: string }>(
            "/api/auth/register-first-user",
            json("POST", {
                username: "x",
                password: "valid-password",
                gatewayToken: "",
            })
        );
        expect(invalidBootstrap.status).toBe(400);
        expect(invalidBootstrap.body.error).toBe(
            "Username must be 3-32 chars: letters, numbers, dot, dash, underscore"
        );

        const malformedBootstrapBody = await api<{ error: string }>(
            "/api/auth/register-first-user",
            {
                body: "{",
                headers: { "content-type": "application/json" },
                method: "POST",
            }
        );
        expect(malformedBootstrapBody.status).toBe(400);
        expect(malformedBootstrapBody.body.error).toBe("Invalid JSON");

        const invalidBootstrapBody = await api<{ error: string }>(
            "/api/auth/register-first-user",
            json("POST", ["not", "an", "object"])
        );
        expect(invalidBootstrapBody.status).toBe(400);
        expect(invalidBootstrapBody.body.error).toBe("Invalid request body");

        const invalidLoginBody = await api<{ error: string }>(
            "/api/auth/login",
            json("POST", "not an object")
        );
        expect(invalidLoginBody.status).toBe(409);
        expect(invalidLoginBody.body.error).toBe(
            "Create the first user before logging in"
        );
    });

    it("serves the app shell only for app routes, not missing assets", async () => {
        const appRoute = await fetch(`${testState.baseUrl}/tasks`);
        expect(appRoute.status).toBe(200);
        expect(appRoute.headers.get("content-type")).toContain("text/html");

        const assetsPath = path.join(testState.temporaryRoot, "frontend", "assets");
        const builtAssets = await fs.readdir(assetsPath);
        const builtChunk = builtAssets.find((file) => /^index-.+\.js$/u.test(file));
        expect(builtChunk).toBeDefined();

        const rootChunk = await fetch(`${testState.baseUrl}/assets/${builtChunk}`);
        expect(rootChunk.status).toBe(200);
        expect(rootChunk.headers.get("cache-control")).toBe("no-store");

        const missingChunk = await fetch(
            `${testState.baseUrl}/assets/index-missing-after-deploy.js`
        );
        expect(missingChunk.status).toBe(404);
        expect(missingChunk.headers.get("content-type")).not.toContain("text/html");
    });

    it("applies static and websocket guard branches without leaving the test root", async () => {
        const apiMiss = await fetch(`${testState.baseUrl}/api/not-a-route`);
        expect(apiMiss.status).toBe(404);
        expect(await apiMiss.json()).toEqual({ error: "Not found" });

        const badEncoding = await fetch(`${testState.baseUrl}/%E0%A4%A`);
        expect(badEncoding.status).toBe(400);

        await fs.writeFile(
            path.join(testState.temporaryRoot, "frontend", ".hidden.js"),
            "export const hidden = true;\n"
        );
        const hiddenAsset = await fetch(`${testState.baseUrl}/.hidden.js`);
        expect(hiddenAsset.status).toBe(404);

        const forbiddenSocket = await fetch(`${testState.baseUrl}/ws`, {
            headers: { origin: "https://evil.example" },
        });
        expect(forbiddenSocket.status).toBe(403);

        const unauthenticatedSocket = await fetch(`${testState.baseUrl}/ws`, {
            headers: { "x-real-ip": "10.0.0.25" },
        });
        expect(unauthenticatedSocket.status).toBe(401);

        const originalFrontendPath = process.env.MIRA_DASHBOARD_FRONTEND_PATH;
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = path.join(
            testState.temporaryRoot,
            "missing-frontend"
        );
        try {
            const missingBuild = await fetch(`${testState.baseUrl}/`);
            expect(missingBuild.status).toBe(503);
            expect(await missingBuild.text()).toContain("Frontend Not Built");
        } finally {
            if (originalFrontendPath === undefined) {
                delete process.env.MIRA_DASHBOARD_FRONTEND_PATH;
            } else {
                process.env.MIRA_DASHBOARD_FRONTEND_PATH = originalFrontendPath;
            }
        }
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

    it("creates notifications with null optional fields", async () => {
        const omittedValue = JSON.parse("null") as null;
        const created = await api<{ id: number; isOk: boolean }>(
            "/api/notifications",
            json("POST", {
                title: "Null optional fields",
                description: omittedValue,
                source: omittedValue,
                dedupeKey: omittedValue,
                type: omittedValue,
            })
        );

        expect(created.status).toBe(200);
        expect(created.body.isOk).toBe(true);
    });

    it("lists, marks, filters, clears, and deletes notifications through the API", async () => {
        const omittedValue = JSON.parse("null") as null;
        const first = await api<{ id: number; isOk: boolean }>(
            "/api/notifications",
            json("POST", {
                title: "Cache refresh failed",
                description: "Refresh failed twice",
                source: "cache",
                dedupeKey: "cache-refresh",
                type: "warning",
                metadata: { key: "moltbook.home" },
                occurredAt: "2026-06-23T10:00:00.000Z",
            })
        );
        const second = await api<{ id: number; isOk: boolean }>(
            "/api/notifications",
            json("POST", {
                title: "Backup healthy",
                source: "backup",
                type: "success",
                occurredAt: "2026-06-23T11:00:00.000Z",
            })
        );
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        const listed = await api<{
            items: Array<{
                id: number;
                isRead: boolean;
                metadata: Record<string, unknown>;
                source?: string;
                title: string;
                type: string;
            }>;
            unreadCount: number;
        }>("/api/notifications?limit=10");
        expect(listed.status).toBe(200);
        expect(listed.body.unreadCount).toBeGreaterThanOrEqual(2);
        expect(
            listed.body.items.find((item) => item.id === second.body.id)
        ).toMatchObject({
            source: "backup",
            title: "Backup healthy",
            type: "success",
        });
        expect(listed.body.items.find((item) => item.id === first.body.id)).toMatchObject(
            {
                metadata: { key: "moltbook.home" },
                source: "cache",
                title: "Cache refresh failed",
            }
        );

        const read = await api<{ isOk: boolean }>(
            `/api/notifications/${first.body.id}/read`,
            { method: "POST" }
        );
        expect(read.status).toBe(200);
        expect(read.body.isOk).toBe(true);

        const clearOtherSource = await api<{ deleted: number; isOk: boolean }>(
            "/api/notifications/clear-read",
            json("POST", { source: "backup" })
        );
        expect(clearOtherSource.status).toBe(200);
        expect(clearOtherSource.body.deleted).toBe(0);

        const rejectNullSource = await api<{ error: string }>(
            "/api/notifications/clear-read",
            json("POST", { source: omittedValue })
        );
        expect(rejectNullSource.status).toBe(400);
        expect(rejectNullSource.body.error).toBe("source must be a string");

        const clearCache = await api<{ deleted: number; isOk: boolean }>(
            "/api/notifications/clear-read",
            json("POST", { source: "cache" })
        );
        expect(clearCache.status).toBe(200);
        expect(clearCache.body).toEqual({ deleted: 1, isOk: true });

        const deleteUnread = await api<{ deleted: number; isOk: boolean }>(
            `/api/notifications/${second.body.id}`,
            { method: "DELETE" }
        );
        expect(deleteUnread.status).toBe(200);
        expect(deleteUnread.body).toEqual({ deleted: 1, isOk: true });
    });

    it("creates and lists delivery reports without spamming heartbeat ok notifications", async () => {
        const brief = await api<{
            isOk: boolean;
            report: {
                id: number;
                metadata: Record<string, unknown>;
                occurredAt: string;
                title: string;
            };
        }>(
            "/api/reports",
            json("POST", {
                type: "daily_brief",
                status: "ok",
                title: "Daily brief",
                bodyMd: "    command\n\n- One thing\n",
                summary: "One thing",
                source: "openclaw",
                sourceJobId: "daily-brief",
                dedupeKey: "brief:2026-06-23",
                metadata: { channel: "dashboard" },
                occurredAt: "2026-06-23 06:00:00 +0200",
            })
        );
        expect(brief.status).toBe(201);
        expect(brief.body.report).toMatchObject({
            metadata: { channel: "dashboard" },
            occurredAt: "2026-06-23T04:00:00.000Z",
            title: "Daily brief",
        });

        const heartbeatOk = await api<{ isOk: boolean; report: { id: number } }>(
            "/api/reports",
            json("POST", {
                type: "heartbeat",
                status: "ok",
                title: "HEARTBEAT_OK",
                bodyMd: "All checks passed.",
                summary: "All checks passed.",
                dedupeKey: "heartbeat:ok:2026-06-23T06:30",
                occurredAt: "2026-06-23T06:30:00.000Z",
            })
        );
        expect(heartbeatOk.status).toBe(201);

        const heartbeatWarning = await api<{ isOk: boolean; report: { id: number } }>(
            "/api/reports",
            json("POST", {
                type: "heartbeat",
                status: "warning",
                title: "Heartbeat warning",
                bodyMd: "Git check needs attention.",
                summary: "Git check needs attention.",
                dedupeKey: "heartbeat:warning:git",
                occurredAt: "2026-06-23T07:00:00.000Z",
            })
        );
        expect(heartbeatWarning.status).toBe(201);

        const secondHeartbeatWarning = await api<{
            isOk: boolean;
            report: { id: number };
        }>(
            "/api/reports",
            json("POST", {
                type: "heartbeat",
                status: "warning",
                title: "Heartbeat warning",
                bodyMd: "Cache check needs attention.",
                summary: "Cache check needs attention.",
                dedupeKey: "heartbeat:warning:cache",
                occurredAt: "2026-06-23T07:05:00.000Z",
            })
        );
        expect(secondHeartbeatWarning.status).toBe(201);

        const custom = await api<{ isOk: boolean; report: { id: number } }>(
            "/api/reports",
            json("POST", {
                type: "custom",
                status: "ok",
                title: "Custom report",
                bodyMd: "Custom delivery.",
                summary: "Custom delivery.",
                dedupeKey: " ".repeat(3),
                occurredAt: "2026-06-23T08:00:00.000Z",
            })
        );
        const customWithoutDedupe = await api<{
            isOk: boolean;
            report: { id: number };
        }>(
            "/api/reports",
            json("POST", {
                type: "custom",
                status: "ok",
                title: "Second custom report",
                bodyMd: "Second custom delivery.",
                summary: "Second custom delivery.",
                dedupeKey: " ".repeat(3),
                occurredAt: "2026-06-23T08:30:00.000Z",
            })
        );
        expect(custom.status).toBe(201);
        expect(customWithoutDedupe.status).toBe(201);
        expect(customWithoutDedupe.body.report.id).not.toBe(custom.body.report.id);

        const listed = await api<{
            items: Array<{
                bodyMd: string;
                id: number;
                status: string;
                title: string;
                type: string;
            }>;
        }>("/api/reports?type=heartbeat&limit=10");
        expect(listed.status).toBe(200);
        expect(listed.body.items.map((item) => item.title)).toContain("HEARTBEAT_OK");
        expect(listed.body.items.every((item) => item.type === "heartbeat")).toBe(true);
        expect(listed.body.items.every((item) => item.bodyMd === "")).toBe(true);

        const detail = await api<{
            report: { bodyMd: string; id: number; sourceJobId?: string };
        }>(`/api/reports/${brief.body.report.id}`);
        expect(detail.status).toBe(200);
        expect(detail.body.report).toMatchObject({
            bodyMd: "    command\n\n- One thing\n",
            sourceJobId: "daily-brief",
        });

        const notifications = await api<{
            items: Array<{
                metadata: Record<string, unknown>;
                title: string;
                type: string;
            }>;
        }>("/api/notifications?limit=50");
        const reportNotifications = notifications.body.items.filter(
            (item) => item.metadata.reportId
        );
        expect(reportNotifications).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    title: "Daily brief ready",
                    type: "info",
                }),
                expect.objectContaining({
                    title: "Heartbeat warning",
                    type: "warning",
                }),
                expect.objectContaining({
                    title: "Custom report",
                    type: "info",
                }),
            ])
        );
        expect(
            reportNotifications.some(
                (item) => item.metadata.reportId === heartbeatOk.body.report.id
            )
        ).toBe(false);
        expect(
            reportNotifications.some(
                (item) => item.metadata.reportId === heartbeatWarning.body.report.id
            )
        ).toBe(true);
        expect(
            reportNotifications.some(
                (item) => item.metadata.reportId === secondHeartbeatWarning.body.report.id
            )
        ).toBe(true);

        const deletedBrief = await api<{ deleted: number; isOk: boolean }>(
            `/api/reports/${brief.body.report.id}`,
            { method: "DELETE" }
        );
        expect(deletedBrief.body).toEqual({ deleted: 1, isOk: true });
        const notificationsAfterDelete = await api<{
            items: Array<{ metadata: Record<string, unknown> }>;
        }>("/api/notifications?limit=50");
        expect(
            notificationsAfterDelete.body.items.some(
                (item) => item.metadata.reportId === brief.body.report.id
            )
        ).toBe(false);
    });

    it("loads, validates, clamps, and persists dashboard settings", async () => {
        const defaults = await api<{
            defaultModel: string;
            gateway: { gateway: string; sessions: number };
            refreshInterval: number;
            sidebarCollapsed: boolean;
            theme: string;
        }>("/api/settings");
        expect(defaults.status).toBe(200);
        expect(defaults.body).toMatchObject({
            defaultModel: "ollama/glm-5",
            refreshInterval: 5000,
            sidebarCollapsed: false,
            theme: "dark",
        });
        expect(defaults.body.gateway).toEqual({
            gateway: "disconnected",
            sessions: 0,
        });

        const updated = await api<{
            defaultModel: string;
            refreshInterval: number;
            sidebarCollapsed: boolean;
            theme: string;
        }>(
            "/api/settings",
            json("PUT", {
                defaultModel: "  openai/gpt-5.5  ",
                refreshInterval: 61_999,
                sidebarCollapsed: true,
                theme: "system",
            })
        );
        expect(updated.status).toBe(200);
        expect(updated.body).toMatchObject({
            defaultModel: "openai/gpt-5.5",
            refreshInterval: 60_000,
            sidebarCollapsed: true,
            theme: "system",
        });

        const persisted = await api<{
            defaultModel: string;
            refreshInterval: number;
            sidebarCollapsed: boolean;
            theme: string;
        }>("/api/settings");
        expect(persisted.status).toBe(200);
        expect(persisted.body).toMatchObject(updated.body);

        const invalid = await api<{ error: string }>(
            "/api/settings",
            json("PUT", { theme: "blue" })
        );
        expect(invalid.status).toBe(400);
        expect(invalid.body.error).toBe("Invalid theme");
    });

    it("reports cache heartbeat entries and individual cache state", async () => {
        const { database } = await import("../src/database.ts");
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");
        const { writeCacheFailure } = await import("../src/services/cacheRefresh.ts");
        const missingValue = JSON.parse("null") as null;
        database
            .prepare(
                `INSERT INTO cache_entries (
                    key, data_json, source, updated_at, last_attempt_at, expires_at,
                    status, error_code, error_message, consecutive_failures, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                "moltbook.home",
                JSON.stringify({ posts: [{ id: "post-1" }] }),
                "moltbook",
                "2026-06-23T09:00:00.000Z",
                "2026-06-23T09:00:00.000Z",
                "2099-01-01T00:00:00.000Z",
                "fresh",
                missingValue,
                missingValue,
                0,
                JSON.stringify({ provider: "moltbook" })
            );
        database
            .prepare(
                `INSERT INTO cache_entries (
                    key, data_json, source, updated_at, last_attempt_at, expires_at,
                    status, error_code, error_message, consecutive_failures, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                "quota.openai",
                missingValue,
                "quota",
                missingValue,
                "2026-06-23T09:05:00.000Z",
                "2026-06-23T10:05:00.000Z",
                "error",
                "rate_limited",
                "Quota API failed",
                2,
                "{}"
            );
        database
            .prepare(
                `INSERT INTO cache_entries (
                    key, data_json, source, updated_at, last_attempt_at, expires_at,
                    status, error_code, error_message, consecutive_failures, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                "weather.expired",
                JSON.stringify({ location: "Expired" }),
                "weather",
                "2026-06-23T08:00:00.000Z",
                "2026-06-23T08:00:00.000Z",
                "2000-01-01T00:00:00.000Z",
                "fresh",
                missingValue,
                missingValue,
                0,
                "{}"
            );
        writeCacheSuccess({
            key: "git.status",
            data: { branch: "main" },
            source: "git",
            ttl: 5,
            ttlUnit: "minutes",
            metadata: { producer: "test" },
        });
        writeCacheSuccess({
            key: "git.status",
            data: { branch: "ignored" },
            source: "git",
            ttl: 5,
            ttlUnit: "minutes",
            metadata: { producer: "preserve" },
            preserveExistingData: true,
        });
        writeCacheFailure({
            key: "weather.failure",
            source: "weather",
            ttl: 5,
            ttlUnit: "minutes",
            error: new Error("Weather offline"),
            metadata: { producer: "test" },
        });
        writeCacheSuccess({
            key: "weather.success-then-failure",
            data: { lastGood: true },
            source: "weather",
            ttl: 5,
            ttlUnit: "minutes",
            metadata: { producer: "success" },
        });
        writeCacheFailure({
            key: "weather.success-then-failure",
            source: "weather",
            ttl: 5,
            ttlUnit: "minutes",
            error: new Error("Weather refresh failed"),
            metadata: { producer: "failure" },
        });

        const heartbeat = await api<{
            count: number;
            entries: Array<{
                consecutiveFailures: number;
                data: unknown;
                errorCode: string | null;
                errorMessage: string | null;
                key: string;
                meta: Record<string, unknown>;
                status: string;
                updatedAt: string | null;
            }>;
        }>("/api/cache/heartbeat");
        expect(heartbeat.status).toBe(200);
        expect(heartbeat.body.count).toBeGreaterThanOrEqual(2);
        expect(
            heartbeat.body.entries.find((entry) => entry.key === "moltbook.home")
        ).toMatchObject({
            data: { posts: [{ id: "post-1" }] },
            errorCode: "",
            errorMessage: "",
            meta: { provider: "moltbook" },
            status: "fresh",
            updatedAt: "2026-06-23T09:00:00.000Z",
        });
        expect(
            heartbeat.body.entries.find((entry) => entry.key === "quota.openai")
        ).toMatchObject({
            consecutiveFailures: 2,
            data: "",
            errorCode: "rate_limited",
            errorMessage: "Quota API failed",
            status: "error",
            updatedAt: missingValue,
        });
        expect(
            heartbeat.body.entries.find((entry) => entry.key === "weather.expired")
        ).toMatchObject({
            data: { location: "Expired" },
            status: "stale",
            updatedAt: "2026-06-23T08:00:00.000Z",
        });
        expect(
            heartbeat.body.entries.find((entry) => entry.key === "git.status")
        ).toMatchObject({
            data: { branch: "main" },
            meta: { producer: "preserve" },
            status: "fresh",
        });
        expect(
            heartbeat.body.entries.find((entry) => entry.key === "weather.failure")
        ).toMatchObject({
            consecutiveFailures: 1,
            data: "",
            errorCode: "check_failed",
            errorMessage: "Weather offline",
            status: "error",
            updatedAt: missingValue,
        });
        expect(
            heartbeat.body.entries.find(
                (entry) => entry.key === "weather.success-then-failure"
            )
        ).toMatchObject({
            consecutiveFailures: 1,
            data: { lastGood: true },
            errorCode: "check_failed",
            errorMessage: "Weather refresh failed",
            status: "error",
        });
        expect(
            heartbeat.body.entries.find(
                (entry) => entry.key === "weather.success-then-failure"
            )?.updatedAt
        ).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

        const entry = await api<{ key: string; status: string }>(
            "/api/cache/moltbook.home"
        );
        expect(entry.status).toBe(200);
        expect(entry.body).toMatchObject({ key: "moltbook.home", status: "fresh" });

        const missing = await api<{ error: string; key: string }>(
            "/api/cache/not-present"
        );
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({
            error: "Cache key not found",
            key: "not-present",
        });
    });

    it("serves Moltbook cached home, feed, profile, and authored content", async () => {
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");
        writeCacheSuccess({
            key: "moltbook.home",
            data: {
                activityOnYourPosts: [{ id: "activity-1" }],
                activityOnYourPostsCount: 1,
                exploreCount: 2,
                fetchedAt: "2026-06-23T12:00:00.000Z",
                latestAnnouncement: {
                    authorName: "Mira",
                    createdAt: "2026-06-23T11:00:00.000Z",
                    postId: "announcement-1",
                    previewText: "Preview",
                    title: "Announcement",
                },
                nextActions: ["reply"],
                pendingRequestCount: 0,
                postsFromAccountsYouFollowCount: 3,
                unreadMessageCount: 1,
            },
            source: "moltbook",
            ttl: 10,
            ttlUnit: "minutes",
            metadata: { route: "home" },
        });
        writeCacheSuccess({
            key: "moltbook.feed.hot",
            data: {
                feedFilter: "all",
                feedType: "hot",
                hasMore: false,
                posts: [{ id: "hot-post" }],
                tip: "tip",
            },
            source: "moltbook",
            ttl: 10,
            ttlUnit: "minutes",
            metadata: {},
        });
        writeCacheSuccess({
            key: "moltbook.feed.new",
            data: {
                feedFilter: "following",
                feedType: "new",
                hasMore: true,
                posts: [{ id: "new-post" }],
                tip: "fresh",
            },
            source: "moltbook",
            ttl: 10,
            ttlUnit: "minutes",
            metadata: {},
        });
        writeCacheSuccess({
            key: "moltbook.profile",
            data: { agent: { id: "mira-2026", displayName: "Mira" } },
            source: "moltbook",
            ttl: 10,
            ttlUnit: "minutes",
            metadata: {},
        });
        writeCacheSuccess({
            key: "moltbook.my-content",
            data: { comments: [{ id: "comment-1" }], posts: [{ id: "post-1" }] },
            source: "moltbook",
            ttl: 10,
            ttlUnit: "minutes",
            metadata: {},
        });

        const home = await api<{
            latestAnnouncement: { title: string };
            nextActions: string[];
        }>("/api/moltbook/home");
        expect(home.status).toBe(200);
        expect(home.body.latestAnnouncement.title).toBe("Announcement");
        expect(home.body.nextActions).toEqual(["reply"]);

        const hotFeed = await api<{ feedType: string; posts: Array<{ id: string }> }>(
            "/api/moltbook/feed"
        );
        expect(hotFeed.status).toBe(200);
        expect(hotFeed.body).toMatchObject({
            feedType: "hot",
            posts: [{ id: "hot-post" }],
        });

        const newFeed = await api<{ feedType: string; hasMore: boolean }>(
            "/api/moltbook/feed?sort=new"
        );
        expect(newFeed.status).toBe(200);
        expect(newFeed.body).toMatchObject({ feedType: "new", hasMore: true });

        const profile = await api<{ agent: { displayName: string; id: string } }>(
            "/api/moltbook/profile"
        );
        expect(profile.status).toBe(200);
        expect(profile.body.agent).toEqual({
            displayName: "Mira",
            id: "mira-2026",
        });

        const myPosts = await api<{
            comments: Array<{ id: string }>;
            posts: Array<{ id: string }>;
        }>("/api/moltbook/my-posts");
        expect(myPosts.status).toBe(200);
        expect(myPosts.body).toEqual({
            comments: [{ id: "comment-1" }],
            posts: [{ id: "post-1" }],
        });
    });

    it("serves database overview through the HTTP route", async () => {
        const originalPath = process.env.PATH;
        const temporaryRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "mira-route-fake-docker-")
        );
        await writeFakeDocker(path.join(temporaryRoot, "docker"));
        try {
            process.env.PATH = `${temporaryRoot}${path.delimiter}${originalPath ?? ""}`;
            const overview = await api<{
                overview: {
                    totalBackends: number;
                    totalDatabaseSizeBytes: number;
                    torrentCounts: { bitmagnet: number; comet: number };
                };
                topQueries: Array<{ query: string }>;
            }>("/api/database/overview");

            expect(overview.status).toBe(200);
            expect(overview.body.overview).toMatchObject({
                totalBackends: 3,
                totalDatabaseSizeBytes: 2_097_152,
                torrentCounts: { bitmagnet: 11, comet: 7 },
            });
            expect(overview.body.topQueries[0]?.query).toBe("SELECT now()");
        } finally {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
            await fs.rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    it("validates exec and session action API contracts", async () => {
        const directExec = await api<{ error: string }>(
            "/api/exec",
            json("POST", { args: ["hello"], command: "printf" })
        );
        expect(directExec.status).toBe(400);
        expect(directExec.body.error).toBe("command executable is not approved");

        const shellExec = await api<{ code: number; stderr: string; stdout: string }>(
            "/api/exec",
            json("POST", {
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            })
        );
        expect(shellExec.status).toBe(200);
        expect(shellExec.body.code).not.toBe(0);
        expect(shellExec.body.stderr).toContain("__mira_dashboard_shell_smoke_test__");

        const stats = await api<{
            activeInLastHour: number;
            byModel: Record<string, number>;
            byType: Record<string, number>;
            total: number;
            totalTokens: number;
        }>("/api/sessions/stats");
        expect(stats.status).toBe(200);
        expect(stats.body).toEqual({
            activeInLastHour: 0,
            byModel: {},
            byType: {},
            total: 0,
            totalTokens: 0,
        });

        const unsupportedAction = await api<{ error: string }>(
            "/api/sessions/session-1/action",
            json("POST", { action: "archive" })
        );
        expect(unsupportedAction.status).toBe(400);
        expect(unsupportedAction.body.error).toBe("Unsupported action: archive");

        const malformedAction = await api<{ error: string }>(
            "/api/sessions/session-1/action",
            json("POST", [])
        );
        expect(malformedAction.status).toBe(400);
        expect(malformedAction.body.error).toBe("Request body must be an object");
    });

    it("lists, updates, runs, and reports scheduled jobs through the API", async () => {
        const { registerScheduledJobAction, upsertScheduledJob } =
            await import("../src/services/scheduledJobs.ts");
        registerScheduledJobAction("test.functional", () => ({
            result: "ran from integration test",
        }));
        const seeded = upsertScheduledJob({
            actionKey: "test.functional",
            description: "Functional test job",
            enabled: false,
            id: "functional.test.job",
            intervalSeconds: 120,
            name: "Functional Test Job",
            scheduleType: "interval",
        });
        expect(seeded.id).toBe("functional.test.job");

        const listed = await api<{
            jobs: Array<{ enabled: boolean; id: string; name: string }>;
        }>("/api/jobs");
        expect(listed.status).toBe(200);
        expect(listed.body.jobs).toContainEqual(
            expect.objectContaining({
                enabled: false,
                id: "functional.test.job",
                name: "Functional Test Job",
            })
        );

        const updated = await api<{
            isOk: boolean;
            job: { enabled: boolean; intervalSeconds: number };
        }>(
            "/api/jobs/functional.test.job",
            json("PATCH", { patch: { enabled: true, intervalSeconds: 300 } })
        );
        expect(updated.status).toBe(200);
        expect(updated.body).toMatchObject({
            isOk: true,
            job: { enabled: true, intervalSeconds: 300 },
        });

        const invalidPatch = await api<{ error: string }>(
            "/api/jobs/functional.test.job",
            json("PATCH", { patch: { unknown: true } })
        );
        expect(invalidPatch.status).toBe(400);
        expect(invalidPatch.body.error).toBe("invalid patch field: unknown");

        const nonObjectPatch = await api<{ error: string }>(
            "/api/jobs/functional.test.job",
            json("PATCH", { patch: [] })
        );
        expect(nonObjectPatch.status).toBe(400);
        expect(nonObjectPatch.body.error).toBe("patch must be an object");

        const invalidEnabledPatch = await api<{ error: string }>(
            "/api/jobs/functional.test.job",
            json("PATCH", { patch: { enabled: "yes" } })
        );
        expect(invalidEnabledPatch.status).toBe(400);
        expect(invalidEnabledPatch.body.error).toBe("invalid patch field: enabled");

        const invalidScheduleTypePatch = await api<{ error: string }>(
            "/api/jobs/functional.test.job",
            json("PATCH", { patch: { scheduleType: "weekly" } })
        );
        expect(invalidScheduleTypePatch.status).toBe(400);
        expect(invalidScheduleTypePatch.body.error).toBe(
            "invalid patch field: scheduleType"
        );

        const malformedPatch = await fetch(
            `${testState.baseUrl}/api/jobs/functional.test.job`,
            {
                body: "{",
                headers: { "Content-Type": "application/json" },
                method: "PATCH",
            }
        );
        expect(malformedPatch.status).toBe(400);
        await expect(malformedPatch.json()).resolves.toEqual({ error: "Invalid JSON" });

        const missingPatchTarget = await api<{ error: string }>(
            "/api/jobs/not-present",
            json("PATCH", { patch: { enabled: true } })
        );
        expect(missingPatchTarget.status).toBe(404);
        expect(missingPatchTarget.body.error).toBe("Scheduled job not found");

        const run = await api<{
            isOk: boolean;
            run: {
                jobId: string;
                output: Record<string, unknown>;
                status: string;
                triggerType: string;
            };
        }>("/api/jobs/functional.test.job/run", { method: "POST" });
        expect(run.status).toBe(200);
        expect(run.body).toMatchObject({
            isOk: true,
            run: {
                jobId: "functional.test.job",
                output: { result: "ran from integration test" },
                status: "success",
                triggerType: "manual",
            },
        });

        const runs = await api<{
            runs: Array<{ jobId: string; status: string; triggerType: string }>;
        }>("/api/jobs/functional.test.job/runs");
        expect(runs.status).toBe(200);
        expect(runs.body.runs).toContainEqual(
            expect.objectContaining({
                jobId: "functional.test.job",
                status: "success",
                triggerType: "manual",
            })
        );

        const missing = await api<{ error: string }>("/api/jobs/not-present");
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe("Scheduled job not found");

        const missingRun = await api<{ error: string }>("/api/jobs/not-present/run", {
            method: "POST",
        });
        expect(missingRun.status).toBe(404);
        expect(missingRun.body.error).toBe("Scheduled job not found");

        const missingRuns = await api<{ error: string }>("/api/jobs/not-present/runs");
        expect(missingRuns.status).toBe(404);
        expect(missingRuns.body.error).toBe("Scheduled job not found");
    });

    it("validates legacy cron route payloads and reports log rotation state", async () => {
        const invalidToggle = await api<{ error: string }>(
            "/api/cron/jobs/example/toggle",
            json("POST", { enabled: "yes" })
        );
        expect(invalidToggle.status).toBe(400);
        expect(invalidToggle.body.error).toBe("enabled must be a boolean");

        const invalidUpdate = await api<{ error: string }>(
            "/api/cron/jobs/example/update",
            json("POST", { patch: [] })
        );
        expect(invalidUpdate.status).toBe(400);
        expect(invalidUpdate.body.error).toBe("patch must be an object");

        const { database, sqlNullable } = await import("../src/database.ts");
        database
            .prepare(
                `
                INSERT INTO cache_entries (
                    key,
                    data_json,
                    source,
                    updated_at,
                    last_attempt_at,
                    expires_at,
                    status,
                    error_code,
                    error_message,
                    consecutive_failures,
                    metadata_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    data_json = excluded.data_json,
                    source = excluded.source,
                    updated_at = excluded.updated_at,
                    last_attempt_at = excluded.last_attempt_at,
                    expires_at = excluded.expires_at,
                    status = excluded.status,
                    error_code = excluded.error_code,
                    error_message = excluded.error_message,
                    consecutive_failures = excluded.consecutive_failures,
                    metadata_json = excluded.metadata_json
                `
            )
            .run(
                "log_rotation.state",
                JSON.stringify({
                    lastRun: {
                        checkedFiles: "2",
                        checkedGroups: "1",
                        compressedFiles: "1",
                        deletedArchives: "0",
                        finishedAt: "2026-06-23T08:00:00.000Z",
                        groups: [{ name: "dashboard" }],
                        isDryRun: true,
                        isOk: false,
                        message: "compression failed",
                        rotatedFiles: "1",
                        skippedFiles: "0",
                        warnings: ["large file"],
                    },
                }),
                "ops",
                "2026-06-23T08:00:00.000Z",
                "2026-06-23T08:00:00.000Z",
                "2026-06-23T09:00:00.000Z",
                "fresh",
                sqlNullable(undefined),
                sqlNullable(undefined),
                0,
                "{}"
            );

        const status = await api<{
            isSuccess: boolean;
            lastRun: {
                checkedFiles: number;
                errors: Array<{ message: string }>;
                groups: Array<{ name: string }>;
                isDryRun: boolean;
                isOk: boolean;
                warnings: string[];
            };
        }>("/api/ops/log-rotation/status");
        expect(status.status).toBe(200);
        expect(status.body).toMatchObject({
            isSuccess: true,
            lastRun: {
                checkedFiles: 2,
                errors: [{ message: "compression failed" }],
                groups: [{ name: "dashboard" }],
                isDryRun: true,
                isOk: false,
                warnings: ["large file"],
            },
        });
    });

    it("serves log metadata/content and media files while rejecting unsafe inputs", async () => {
        const logsRoot = testState.openclawRoot;
        await fs.mkdir(logsRoot, { recursive: true });
        await fs.writeFile(
            path.join(logsRoot, "openclaw-dashboard-functional-test.log"),
            "first line\nsecond line\nthird line\n"
        );

        const logs = await api<{
            logs: Array<{ name: string; size: number }>;
        }>("/api/logs/info");
        expect(logs.status).toBe(200);
        expect(logs.body.logs).toContainEqual(
            expect.objectContaining({
                name: "openclaw-dashboard-functional-test.log",
                size: "first line\nsecond line\nthird line\n".length,
            })
        );

        const content = await api<{ content: string; file: string; lineIds: string[] }>(
            "/api/logs/content?file=openclaw-dashboard-functional-test.log&lines=2"
        );
        expect(content.status).toBe(200);
        expect(content.body).toEqual({
            content: "second line\nthird line\n",
            file: "openclaw-dashboard-functional-test.log",
            lineIds: ["11", "23", "34"],
        });

        const invalidLines = await api<{ error: string }>(
            "/api/logs/content?file=openclaw-dashboard-functional-test.log&lines=abc"
        );
        expect(invalidLines.status).toBe(400);
        expect(invalidLines.body.error).toBe("Invalid lines");

        const traversal = await api<{ error: string }>(
            "/api/logs/content?file=../openclaw-dashboard-functional-test.log"
        );
        expect(traversal.status).toBe(404);
        expect(traversal.body.error).toBe("Log file not found");

        const media = await fetch(
            `${testState.baseUrl}/api/media?path=images/dashboard-test.txt`
        );
        expect(media.status).toBe(200);
        expect(media.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(media.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await media.text()).toBe("media fixture\n");

        const missingMedia = await api<{ error: string }>(
            "/api/media?path=images/not-present.txt"
        );
        expect(missingMedia.status).toBe(404);
        expect(missingMedia.body.error).toBe("Media not found");

        const deniedMedia = await api<{ error: string }>("/api/media");
        expect(deniedMedia.status).toBe(403);
        expect(deniedMedia.body.error).toBe("Access denied");
    });

    it("reports idle backup state and validates pull request action inputs", async () => {
        const kopia = await api<{ job?: unknown }>("/api/backups/kopia");
        expect(kopia.status).toBe(200);
        expect(kopia.body).toEqual({});

        const walg = await api<{ job?: unknown }>("/api/backups/walg");
        expect(walg.status).toBe(200);
        expect(walg.body).toEqual({});

        const clearKopia = await api<{ error: string }>(
            "/api/backups/kopia/clear-needs-attention",
            { method: "POST" }
        );
        expect(clearKopia.status).toBe(404);
        expect(clearKopia.body.error).toBe("KOPIA backup job not found");

        const invalidApprove = await api<{ error: string }>(
            "/api/pull-requests/not-a-number/approve",
            { method: "POST" }
        );
        expect(invalidApprove.status).toBe(400);
        expect(invalidApprove.body.error).toBe("Invalid pull request number");

        const invalidReject = await api<{ error: string }>(
            "/api/pull-requests/0/reject",
            json("POST", { comment: "Nope" })
        );
        expect(invalidReject.status).toBe(400);
        expect(invalidReject.body.error).toBe("Invalid pull request number");
    });

    it("maps deployment rows into recent pull request deployment summaries", async () => {
        const [{ database, sqlNullable }, { readDeploymentJobs }] = await Promise.all([
            import("../src/database.ts"),
            import("../src/services/pullRequests.ts"),
        ]);
        database.prepare("DELETE FROM deployment_jobs").run();
        database
            .prepare(
                `
                INSERT INTO deployment_jobs (
                    id,
                    status,
                    started_at,
                    updated_at,
                    commit_sha,
                    commit_title,
                    note,
                    stdout,
                    stderr
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `
            )
            .run(
                "older",
                "isOk",
                "2026-06-23T10:00:00.000Z",
                "2026-06-23T10:01:00.000Z",
                "abc def",
                "Older deploy",
                sqlNullable(undefined),
                "ok",
                sqlNullable(undefined),
                "newer",
                "failed",
                "2026-06-23T11:00:00.000Z",
                "2026-06-23T11:05:00.000Z",
                sqlNullable(undefined),
                sqlNullable(undefined),
                "failed note",
                sqlNullable(undefined),
                "boom"
            );

        expect(readDeploymentJobs()).toEqual([
            {
                id: "newer",
                status: "failed",
                startedAt: "2026-06-23T11:00:00.000Z",
                updatedAt: "2026-06-23T11:05:00.000Z",
                note: "failed note",
                stderr: "boom",
            },
            {
                id: "older",
                status: "isOk",
                startedAt: "2026-06-23T10:00:00.000Z",
                updatedAt: "2026-06-23T10:01:00.000Z",
                commit: "abc def",
                commitTitle: "Older deploy",
                commitUrl: "https://github.com/rajohan/Mira-Dashboard/commit/abc%20def",
                stdout: "ok",
            },
        ]);
    });

    it("validates terminal, speech, config, metrics, and cache-backed route contracts", async () => {
        const terminalComplete = await api<{
            commonPrefix: string;
            completions: Array<{ display: string; type: string }>;
        }>(
            "/api/terminal/complete",
            json("POST", { cwd: testState.temporaryRoot, partial: "work" })
        );
        expect(terminalComplete.status).toBe(200);
        expect(terminalComplete.body.completions).toContainEqual(
            expect.objectContaining({ display: "workspace/", type: "directory" })
        );

        const terminalCd = await api<{ isSuccess: boolean; newCwd: string }>(
            "/api/terminal/cd",
            json("POST", { cwd: testState.temporaryRoot, path: "workspace" })
        );
        expect(terminalCd.status).toBe(200);
        expect(terminalCd.body).toEqual({
            isSuccess: true,
            newCwd: path.join(testState.temporaryRoot, "workspace"),
        });

        const invalidTerminalCd = await api<{ error: string; isSuccess: boolean }>(
            "/api/terminal/cd",
            json("POST", { cwd: testState.temporaryRoot, path: "\0" })
        );
        expect(invalidTerminalCd.status).toBe(400);
        expect(invalidTerminalCd.body).toMatchObject({
            error: "Missing or invalid path",
            isSuccess: false,
        });

        const previousElevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        delete process.env.ELEVENLABS_API_KEY;
        try {
            const tts = await api<{ error: string }>(
                "/api/tts/speak",
                json("POST", { text: "hello" })
            );
            expect(tts.status).toBe(500);
            expect(tts.body.error).toBe("ELEVENLABS_API_KEY is not configured");
        } finally {
            if (previousElevenLabsApiKey === undefined) {
                delete process.env.ELEVENLABS_API_KEY;
            } else {
                process.env.ELEVENLABS_API_KEY = previousElevenLabsApiKey;
            }
        }

        const stt = await fetch(`${testState.baseUrl}/api/stt/transcribe`, {
            body: "",
            method: "POST",
        });
        expect(stt.status).toBe(400);
        expect(await stt.json()).toEqual({ error: "Missing audio payload" });

        const invalidConfigPut = await api<{ error: string }>(
            "/api/config",
            json("PUT", { theme: "dark" })
        );
        expect(invalidConfigPut.status).toBe(400);
        expect(invalidConfigPut.body.error).toBe("Config hash is required");

        const invalidSkill = await api<{ error: string }>(
            "/api/skills/__proto__",
            json("POST", { __hash: "hash", enabled: true })
        );
        expect(invalidSkill.status).toBe(400);
        expect(invalidSkill.body.error).toBe("Invalid skill name");

        const metrics = await api<{
            cpu: { count: number; loadAvg: number[] };
            memory: { total: number; used: number };
            system: { hostname: string; platform: string };
            tokens: { total: number };
        }>("/api/metrics");
        expect(metrics.status).toBe(200);
        expect(metrics.body.cpu.count).toBeGreaterThan(0);
        expect(metrics.body.cpu.loadAvg).toHaveLength(3);
        expect(metrics.body.memory.total).toBeGreaterThan(0);
        expect(metrics.body.memory.used).toBeGreaterThanOrEqual(0);
        expect(metrics.body.system.hostname.length).toBeGreaterThan(0);
        expect(metrics.body.tokens.total).toBe(0);

        const { database } = await import("../src/database.ts");
        database.prepare("DELETE FROM cache_entries WHERE key = ?").run("moltbook.home");
        const missingMoltbook = await api<{ error: string }>("/api/moltbook/home");
        expect(missingMoltbook.status).toBe(503);
        expect(missingMoltbook.body.error).toBe(
            "Moltbook cache entry not found or not fresh: moltbook.home"
        );
    });

    it("proxies successful TTS and STT provider responses", async () => {
        const previousApiKey = process.env.ELEVENLABS_API_KEY;
        const originalFetch = fetch;
        process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
        const providerCalls: Array<{ body: unknown; url: string }> = [];
        const fetchMock = async (input: Request | URL | string, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith(testState.baseUrl)) {
                return originalFetch(input, init);
            }
            providerCalls.push({ body: init?.body, url });
            if (url.includes("/text-to-speech/")) {
                return new Response(new Uint8Array([1, 2, 3]), {
                    headers: { "Content-Type": "audio/mpeg" },
                    status: 200,
                });
            }
            if (url.includes("/speech-to-text")) {
                return Response.json({ words: [{ text: "hei" }, { text: "mira" }] });
            }
            return Response.json({ error: "unexpected provider URL" }, { status: 500 });
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        try {
            const tts = await fetch(`${testState.baseUrl}/api/tts/speak`, {
                body: JSON.stringify({ text: "Hei Mira" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            expect(tts.status).toBe(200);
            expect(tts.headers.get("content-type")).toBe("audio/mpeg");
            const ttsBytes = new Uint8Array(await tts.arrayBuffer());
            expect([...ttsBytes]).toEqual([1, 2, 3]);

            const stt = await fetch(`${testState.baseUrl}/api/stt/transcribe`, {
                body: new Uint8Array([4, 5, 6]),
                headers: { "Content-Type": "audio/webm" },
                method: "POST",
            });
            expect(stt.status).toBe(200);
            expect(await stt.json()).toEqual({
                provider: "elevenlabs",
                text: "hei mira",
            });
            expect(providerCalls.map((call) => call.url)).toEqual([
                expect.stringContaining("/text-to-speech/"),
                "https://api.elevenlabs.io/v1/speech-to-text",
            ]);
        } finally {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
            if (previousApiKey === undefined) {
                delete process.env.ELEVENLABS_API_KEY;
            } else {
                process.env.ELEVENLABS_API_KEY = previousApiKey;
            }
        }
    });

    it("handles TTS and STT provider validation and failure responses", async () => {
        const previousApiKey = process.env.ELEVENLABS_API_KEY;
        const originalFetch = fetch;
        const originalConsoleError = console.error;
        Object.defineProperty(console, "error", {
            configurable: true,
            value: () => {},
            writable: true,
        });

        delete process.env.ELEVENLABS_API_KEY;
        const missingApiKey = await api<{ error: string }>(
            "/api/tts/speak",
            json("POST", { text: "Hei" })
        );
        expect(missingApiKey.status).toBe(500);
        expect(missingApiKey.body.error).toBe("ELEVENLABS_API_KEY is not configured");

        process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
        const fetchMock = async (input: Request | URL | string, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith(testState.baseUrl)) {
                return originalFetch(input, init);
            }
            if (url.includes("/text-to-speech/")) {
                return Response.json({ error: "voice unavailable" }, { status: 502 });
            }
            if (url.includes("/speech-to-text")) {
                return Response.json({ error: "audio rejected" }, { status: 400 });
            }
            return Response.json({ error: "unexpected provider URL" }, { status: 500 });
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        try {
            const invalidJson = await fetch(`${testState.baseUrl}/api/tts/speak`, {
                body: "{",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            expect(invalidJson.status).toBe(400);
            expect(await invalidJson.json()).toMatchObject({
                error: expect.stringContaining("JSON"),
            });

            const missingText = await api<{ error: string }>(
                "/api/tts/speak",
                json("POST", { text: " ".repeat(3) })
            );
            expect(missingText.status).toBe(400);
            expect(missingText.body.error).toBe("Missing text");

            const tooLong = await api<{ error: string }>(
                "/api/tts/speak",
                json("POST", { text: "x".repeat(4001) })
            );
            expect(tooLong.status).toBe(400);
            expect(tooLong.body.error).toBe("Text is too long. Max is 4000 characters.");

            const providerFailure = await api<{ error: string }>(
                "/api/tts/speak",
                json("POST", { text: "provider should fail" })
            );
            expect(providerFailure.status).toBe(502);
            expect(providerFailure.body.error).toBe(
                "TTS service temporarily unavailable"
            );

            const stt = await fetch(`${testState.baseUrl}/api/stt/transcribe`, {
                body: new Uint8Array([7, 8, 9]),
                headers: { "Content-Type": "audio/mp3" },
                method: "POST",
            });
            expect(stt.status).toBe(500);
            expect(await stt.json()).toEqual({ error: "Failed to transcribe audio" });
        } finally {
            Object.defineProperty(console, "error", {
                configurable: true,
                value: originalConsoleError,
                writable: true,
            });
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
            if (previousApiKey === undefined) {
                delete process.env.ELEVENLABS_API_KEY;
            } else {
                process.env.ELEVENLABS_API_KEY = previousApiKey;
            }
        }
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

        const configFiles = await api<{
            files: Array<{ relativePath: string; type: string }>;
            root: string;
        }>("/api/config-files");
        expect(configFiles.status).toBe(200);
        expect(configFiles.body.root).toBe(testState.openclawRoot);
        expect(configFiles.body.files).toContainEqual(
            expect.objectContaining({ relativePath: "openclaw.json", type: "file" })
        );

        const updatedTransform = await api<{
            isSuccess: boolean;
            relativePath: string;
        }>(
            "/api/config-files/hooks/transforms/agentmail.ts",
            json("PUT", { content: "export default function transform() {}\n" })
        );
        expect(updatedTransform.status).toBe(200);
        expect(updatedTransform.body).toMatchObject({
            isSuccess: true,
            relativePath: "hooks/transforms/agentmail.ts",
        });

        const transform = await api<{ content: string; relativePath: string }>(
            "/api/config-files/hooks/transforms/agentmail.ts"
        );
        expect(transform.status).toBe(200);
        expect(transform.body).toMatchObject({
            content: "export default function transform() {}\n",
            relativePath: "hooks/transforms/agentmail.ts",
        });

        const deniedConfig = await api<{ error: string }>(
            "/api/config-files/agents/main/config.json",
            json("PUT", { content: "{}" })
        );
        expect(deniedConfig.status).toBe(403);
        expect(deniedConfig.body.error).toBe("Access denied: file not in allowed list");
    });

    it("loads agent config, status, metadata updates, and task history from OpenClaw home", async () => {
        const agentsRoot = path.join(testState.openclawRoot, "agents");
        const agentSessions = path.join(agentsRoot, "mira-2026", "sessions");
        await fs.mkdir(agentSessions, { recursive: true });

        const missingConfig = await api<{ error: string }>("/api/agents/config");
        expect(missingConfig.status).toBe(404);
        expect(missingConfig.body.error).toBe("Agent configuration not found");

        await fs.writeFile(
            path.join(testState.openclawRoot, "openclaw.json"),
            JSON.stringify({
                agents: {
                    defaults: {
                        model: { primary: "codex" },
                        models: { "openai/gpt-5.5": { alias: "codex" } },
                    },
                    list: [{ id: "mira-2026", model: { primary: "codex" } }],
                },
            })
        );
        await fs.writeFile(
            path.join(agentSessions, "sessions.json"),
            JSON.stringify([
                {
                    key: "agent:main:main",
                    sessionId: "session-1",
                    updatedAt: Date.now(),
                    channel: "webchat",
                    displayName: "Main session",
                },
            ])
        );
        await fs.writeFile(
            path.join(agentSessions, "session-1.jsonl"),
            [
                JSON.stringify({ role: "user", content: "Investigate dashboard tests" }),
                JSON.stringify({
                    type: "tool_call",
                    name: "exec_command",
                    arguments: JSON.stringify({ command: "bun test" }),
                }),
            ].join("\n")
        );

        const config = await api<{ list: Array<{ id: string }> }>("/api/agents/config");
        expect(config.status).toBe(200);
        expect(config.body.list).toContainEqual(
            expect.objectContaining({ id: "mira-2026" })
        );

        const invalidMetadataBody = await api<{ error: string }>(
            "/api/agents/mira-2026/metadata",
            json("PUT", {})
        );
        expect(invalidMetadataBody.status).toBe(400);
        expect(invalidMetadataBody.body.error).toBe("Provide currentTask");

        const metadata = await api<{ currentTask: string; updatedAt: string }>(
            "/api/agents/mira-2026/metadata",
            json("PUT", { currentTask: "Cover agent dashboard behavior" })
        );
        expect(metadata.status).toBe(200);
        expect(metadata.body.currentTask).toBe("Cover agent dashboard behavior");
        expect(typeof metadata.body.updatedAt).toBe("string");

        const status = await api<{
            agents: Array<{
                currentTask?: string;
                id: string;
                model: string;
                sessionKey?: string;
            }>;
        }>("/api/agents/status");
        expect(status.status).toBe(200);
        expect(status.body.agents).toContainEqual(
            expect.objectContaining({
                currentTask: "Cover agent dashboard behavior",
                id: "mira-2026",
                model: "gpt-5.5",
                sessionKey: "agent:main:main",
            })
        );

        const unknownAgent = await api<{ error: string }>("/api/agents/unknown/status");
        expect(unknownAgent.status).toBe(404);
        expect(unknownAgent.body.error).toBe("Agent 'unknown' not found");

        const singleStatus = await api<{ currentTask?: string; id: string }>(
            "/api/agents/mira-2026/status"
        );
        expect(singleStatus.status).toBe(200);
        expect(singleStatus.body).toMatchObject({
            currentTask: "Cover agent dashboard behavior",
            id: "mira-2026",
        });

        await api<{ currentTask: string }>(
            "/api/agents/mira-2026/metadata",
            json("PUT", { currentTask: "Next task" })
        );
        const history = await api<{
            tasks: Array<{ agentId: string; status: string; task: string }>;
        }>("/api/agents/tasks/history?limit=1");
        expect(history.status).toBe(200);
        expect(history.body.tasks).toContainEqual(
            expect.objectContaining({
                agentId: "mira-2026",
                status: "completed",
                task: "Cover agent dashboard behavior",
            })
        );

        const defaultHistory = await api<{
            tasks: Array<{ agentId: string; task: string }>;
        }>("/api/agents/tasks/history?limit=not-a-number");
        expect(defaultHistory.status).toBe(200);
        expect(defaultHistory.body.tasks).toContainEqual(
            expect.objectContaining({
                agentId: "mira-2026",
                task: "Cover agent dashboard behavior",
            })
        );

        const invalidMetadata = await api<{ error: string }>(
            "/api/agents/../metadata",
            json("PUT", { currentTask: "escape" })
        );
        expect(invalidMetadata.status).toBe(404);
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
