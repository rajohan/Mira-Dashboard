import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const testState: {
    baseUrl: string;
    openclawRoot: string;
    originalHome?: string;
    originalLoopbackAuth?: string;
    server?: Server<unknown>;
    temporaryRoot: string;
} = {
    baseUrl: "",
    openclawRoot: "",
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

        testState.originalLoopbackAuth = process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH;
        testState.originalHome = process.env.HOME;
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(
            testState.temporaryRoot,
            "dashboard.database"
        );
        process.env.MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH = "1";
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.HOME = homeRoot;
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
        if (testState.originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = testState.originalHome;
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
    });

    it("serves log metadata/content and media files while rejecting unsafe inputs", async () => {
        const logsRoot = "/tmp/openclaw";
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

        const content = await api<{ content: string; file: string }>(
            "/api/logs/content?file=openclaw-dashboard-functional-test.log&lines=2"
        );
        expect(content.status).toBe(200);
        expect(content.body).toEqual({
            content: "second line\nthird line",
            file: "openclaw-dashboard-functional-test.log",
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

        const moltbook = await api<Record<string, unknown> & { error?: string }>(
            "/api/moltbook/home"
        );
        expect([200, 503]).toContain(moltbook.status);
        if (moltbook.status === 503) {
            expect(moltbook.body.error).toContain("Cache key not found");
        } else {
            expect(typeof moltbook.body).toBe("object");
            expect(moltbook.body).not.toBeNull();
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
