import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { afterEach, describe, expect, it } from "bun:test";

import { database } from "../src/database.ts";

const cleanupCallbacks: Array<() => void> = [];

function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}

function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() => rmSync(root, { force: true, recursive: true }));
    return root;
}

function writeExecutable(filePath: string, content: string): void {
    writeFileSync(filePath, content);
    chmodSync(filePath, 0o755);
}

function isolateOpenClawEnvironment(prefix: string): void {
    rememberEnvironment("OPENCLAW_HOME");
    rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
    const root = createTemporaryRoot(prefix);
    process.env.OPENCLAW_HOME = path.join(root, "openclaw-home");
    process.env.MIRA_DASHBOARD_OPENCLAW_HOME = path.join(root, "dashboard-home");
}

function requestWithParameters<T extends string>(
    route: string,
    parameters: Record<T, string>,
    init?: RequestInit
): Request & { params: Record<T, string> } {
    return Object.assign(new Request(`https://test.local${route}`, init), {
        params: parameters,
    });
}

function jsonRequest(route: string, body: unknown): Request {
    return new Request(`https://test.local${route}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });
}

function fakeServer(address = "127.0.0.1"): Server<unknown> {
    return {
        requestIP: () => ({ address, family: "IPv4", port: 12_345 }),
    } as unknown as Server<unknown>;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
    database
        .prepare(
            "DELETE FROM task_updates WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database
        .prepare(
            "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database.prepare("DELETE FROM tasks WHERE title LIKE 'Coverage %'").run();
    database
        .prepare(
            "DELETE FROM notifications WHERE dedupe_key LIKE 'quota:%' OR dedupe_key LIKE 'openclaw:%'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM quota_alert_state WHERE provider IN ('openrouter', 'elevenlabs', 'synthetic', 'openai')"
        )
        .run();
    database.prepare("DELETE FROM openclaw_alert_state WHERE id = 1").run();
    database.prepare("DELETE FROM scheduled_job_runs WHERE job_id LIKE 'cache.%'").run();
    database.prepare("DELETE FROM scheduled_jobs WHERE id LIKE 'cache.%'").run();
    database
        .prepare(
            "DELETE FROM cache_entries WHERE key IN ('quotas.summary', 'system.host', 'system.openclaw', 'git.workspace', 'backup.kopia.status', 'backup.walg.status', 'log_rotation.state')"
        )
        .run();
    database.prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'").run();
    database
        .prepare(
            "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'coverage-%')"
        )
        .run();
    database.prepare("DELETE FROM users WHERE username LIKE 'coverage-%'").run();
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
});

describe("backend route and service behavior", () => {
    it("auth route validation, login, session, and logout branches", async () => {
        isolateOpenClawEnvironment("mira-auth-route-coverage-");
        const { authRoutes } = await import("../src/routes/authRoutes.ts");
        const { createUser } = await import("../src/auth.ts");
        const server = fakeServer();
        const username = `coverage-${Bun.randomUUIDv7().slice(-8)}`;

        const bootstrap = await authRoutes["/api/auth/bootstrap"].GET();
        expect(await responseJson(bootstrap)).toHaveProperty("isBootstrapRequired");

        const invalidFirstUser = await authRoutes["/api/auth/register-first-user"].POST(
            jsonRequest("/api/auth/register-first-user", {
                gatewayToken: "",
                password: "short",
                username: "x",
            }),
            server
        );
        expect(invalidFirstUser.status).toBe(400);
        await expect(invalidFirstUser.json()).resolves.toEqual({
            error: "Username must be 3-32 chars: letters, numbers, dot, dash, underscore",
        });

        const bootstrapLogin = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "correct-password",
                username,
            }),
            server
        );
        expect(bootstrapLogin.status).toBe(409);

        const user = createUser(username, "correct-password");
        const invalidLogin = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "wrong-password",
                username,
            }),
            server
        );
        expect(invalidLogin.status).toBe(401);

        const login = await authRoutes["/api/auth/login"].POST(
            jsonRequest("/api/auth/login", {
                password: "correct-password",
                username,
            }),
            server
        );
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("mira_dashboard_session=");
        await expect(login.json()).resolves.toMatchObject({
            authenticated: true,
            user: { id: user.id, username },
        });

        const session = await authRoutes["/api/auth/session"].GET(
            new Request("https://test.local/api/auth/session", {
                headers: { cookie },
            }),
            server
        );
        await expect(session.json()).resolves.toMatchObject({
            authenticated: true,
            isBootstrapRequired: false,
        });

        const logout = authRoutes["/api/auth/logout"].POST(
            new Request("https://test.local/api/auth/logout", {
                headers: { cookie },
                method: "POST",
            }),
            server
        );
        expect(await responseJson(logout)).toEqual({ isOk: true });
        expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    it("task route automation, validation, assignment, movement, updates, and deletion", async () => {
        isolateOpenClawEnvironment("mira-task-route-coverage-");
        const gatewayModule = await import("../src/gateway.ts");
        const gateway = gatewayModule.default;
        const originalRequest = gateway.request;
        const originalSendSessionMessage = gateway.sendSessionMessage;
        cleanupCallbacks.push(() => {
            gateway.request = originalRequest;
            gateway.sendSessionMessage = originalSendSessionMessage;
        });
        gateway.request = async () => ({
            jobs: [
                {
                    enabled: true,
                    id: "cron-unit",
                    name: "Coverage cron",
                    payload: { model: "codex", thinking: "high" },
                    schedule: { everyMs: 3_600_000, kind: "every" },
                    sessionTarget: "agent:main:main",
                    state: { lastDurationMs: 42, lastRunStatus: "success" },
                },
            ],
        });
        gateway.sendSessionMessage = async () => {};

        const { taskRoutes } = await import("../src/routes/taskRoutes.ts");
        const invalidCreate = await taskRoutes["/api/tasks"].POST(
            jsonRequest("/api/tasks", { labels: "bug", title: "Coverage invalid" })
        );
        expect(invalidCreate.status).toBe(400);

        const create = await taskRoutes["/api/tasks"].POST(
            jsonRequest("/api/tasks", {
                automation: {
                    cronJobId: "cron-unit",
                    model: "stored-model",
                    scheduleSummary: "stored schedule",
                },
                body: "Body",
                labels: ["blocked", "priority-high"],
                title: "Coverage route task",
            })
        );
        expect(create.status).toBe(201);
        const created = await responseJson(create);
        const id = Number(created.number);
        expect(created).toMatchObject({
            automation: {
                cronJobId: "cron-unit",
                model: "stored-model",
                scheduleSummary: "stored schedule",
                source: "stored",
            },
            state: "OPEN",
            title: "Coverage route task",
        });

        const enriched = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters(`/api/tasks/${id}`, { id: String(id) })
        );
        await expect(enriched.json()).resolves.toMatchObject({
            automation: {
                enabled: true,
                model: "codex",
                scheduleSummary: "Every 1h",
                source: "cron",
            },
        });

        const getInvalid = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters("/api/tasks/not-a-number", { id: "not-a-number" })
        );
        expect(getInvalid.status).toBe(400);

        const patch = await taskRoutes["/api/tasks/:id"].PATCH(
            requestWithParameters(
                `/api/tasks/${id}`,
                { id: String(id) },
                {
                    body: JSON.stringify({
                        automation: {},
                        labels: ["done", "priority-low"],
                        title: "Coverage route task updated",
                    }),
                    method: "PATCH",
                }
            )
        );
        await expect(patch.json()).resolves.toMatchObject({
            state: "CLOSED",
            title: "Coverage route task updated",
        });

        const invalidAssign = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                { id: String(id) },
                { body: JSON.stringify({ assignee: "nobody" }), method: "POST" }
            )
        );
        expect(invalidAssign.status).toBe(400);

        const assign = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                { id: String(id) },
                { body: JSON.stringify({ assignee: "mira-2026" }), method: "POST" }
            )
        );
        await expect(assign.json()).resolves.toMatchObject({
            assignees: [{ login: "mira-2026", name: "mira-2026" }],
        });

        const invalidMove = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                `/api/tasks/${id}/move`,
                { id: String(id) },
                { body: JSON.stringify({ columnLabel: "icebox" }), method: "POST" }
            )
        );
        expect(invalidMove.status).toBe(400);

        const move = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                `/api/tasks/${id}/move`,
                { id: String(id) },
                { body: JSON.stringify({ columnLabel: "in-progress" }), method: "POST" }
            )
        );
        await expect(move.json()).resolves.toMatchObject({ state: "OPEN" });

        const invalidUpdate = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                `/api/tasks/${id}/updates`,
                { id: String(id) },
                {
                    body: JSON.stringify({ author: "mira-2026", messageMd: "" }),
                    method: "POST",
                }
            )
        );
        expect(invalidUpdate.status).toBe(400);

        const update = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                `/api/tasks/${id}/updates`,
                { id: String(id) },
                {
                    body: JSON.stringify({
                        author: "mira-2026",
                        messageMd: "Progress update",
                    }),
                    method: "POST",
                }
            )
        );
        expect(update.status).toBe(201);
        const updateBody = await responseJson(update);
        const updateId = Number(updateBody.id);

        const patchUpdate = await taskRoutes["/api/tasks/:id/updates/:updateId"].PATCH(
            requestWithParameters(
                `/api/tasks/${id}/updates/${updateId}`,
                { id: String(id), updateId: String(updateId) },
                {
                    body: JSON.stringify({
                        author: "rajohan",
                        messageMd: "Raymond update",
                    }),
                    method: "PATCH",
                }
            )
        );
        await expect(patchUpdate.json()).resolves.toMatchObject({
            author: "rajohan",
            messageMd: "Raymond update",
        });

        const deleteUpdate = taskRoutes["/api/tasks/:id/updates/:updateId"].DELETE(
            requestWithParameters(`/api/tasks/${id}/updates/${updateId}`, {
                id: String(id),
                updateId: String(updateId),
            })
        );
        expect(await responseJson(deleteUpdate)).toEqual({ isOk: true });

        const deleteTask = taskRoutes["/api/tasks/:id"].DELETE(
            requestWithParameters(`/api/tasks/${id}`, { id: String(id) })
        );
        expect(await responseJson(deleteTask)).toEqual({ isOk: true });
    });

    it("file route listing, hidden path rejection, text writes, binary reads, and directory errors", async () => {
        rememberEnvironment("WORKSPACE_ROOT");
        const workspaceRoot = createTemporaryRoot("mira-file-route-coverage-");
        process.env.WORKSPACE_ROOT = workspaceRoot;
        mkdirSync(path.join(workspaceRoot, "notes"), { recursive: true });
        writeFileSync(path.join(workspaceRoot, "notes", "readme.txt"), "hello");
        writeFileSync(path.join(workspaceRoot, "image.png"), "png");
        writeFileSync(path.join(workspaceRoot, "binary.bin"), "a\0b");

        const { fileRoutes } = await import("../src/routes/fileRoutes.ts");
        const list = await fileRoutes["/api/files"].GET(
            new Request("https://test.local/api/files")
        );
        await expect(list.json()).resolves.toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({ name: "notes", type: "directory" }),
                expect.objectContaining({ name: "image.png", type: "file" }),
            ]),
            root: workspaceRoot,
        });

        const hidden = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/.secret")
        );
        expect(hidden.status).toBe(403);

        const directory = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/notes")
        );
        expect(directory.status).toBe(400);

        const binary = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/binary.bin")
        );
        await expect(binary.json()).resolves.toMatchObject({
            content: "[Binary file]",
            isBinary: true,
            path: "binary.bin",
        });

        const image = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/image.png")
        );
        await expect(image.json()).resolves.toMatchObject({
            isBinary: true,
            isImage: true,
            mimeType: "image/png",
            path: "image.png",
        });

        const write = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: JSON.stringify({ content: "updated" }),
                method: "PUT",
            })
        );
        expect(await responseJson(write)).toMatchObject({
            isSuccess: true,
            path: "notes/readme.txt",
        });

        const directoryWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes", {
                body: JSON.stringify({ content: "updated" }),
                method: "PUT",
            })
        );
        expect(directoryWrite.status).toBe(400);
    });

    it("config file route allowlist, reads, writes, and backups", async () => {
        isolateOpenClawEnvironment("mira-config-file-route-");
        const root = process.env.OPENCLAW_HOME!;
        mkdirSync(path.join(root, "hooks", "transforms"), { recursive: true });
        writeFileSync(path.join(root, "openclaw.json"), '{"model":"codex"}\n');
        writeFileSync(
            path.join(root, "hooks", "transforms", "agentmail.ts"),
            "export default {}\n"
        );
        const { configFileRoutes } = await import("../src/routes/configFileRoutes.ts");

        const listed = await configFileRoutes["/api/config-files"].GET();
        const listedJson = await responseJson(listed);
        expect((listedJson.files as unknown[]).length).toBe(2);
        expect(listedJson.root).toBe(root);

        const deniedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/secrets.env")
        );
        expect(deniedRead.status).toBe(403);

        const read = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        await expect(read.json()).resolves.toMatchObject({
            content: '{"model":"codex"}\n',
            isBinary: false,
            path: "config:openclaw.json",
            relativePath: "openclaw.json",
            size: 18,
        });

        const invalidWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({ content: 42 }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        expect(invalidWrite.status).toBe(400);

        const written = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({ content: '{"model":"glm51"}\n' }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
            })
        );
        await expect(written.json()).resolves.toMatchObject({
            isSuccess: true,
            path: "config:openclaw.json",
            relativePath: "openclaw.json",
            size: 18,
        });
        await expect(Bun.file(path.join(root, "openclaw.json")).text()).resolves.toBe(
            '{"model":"glm51"}\n'
        );
        await expect(Bun.file(path.join(root, "openclaw.json.bak")).text()).resolves.toBe(
            '{"model":"codex"}\n'
        );
    });

    it("defensive route contracts for Docker, pull requests, cache, database, and backup APIs", async () => {
        isolateOpenClawEnvironment("mira-route-contract-coverage-");
        const terminalRoot = createTemporaryRoot("mira-terminal-route-coverage-");
        const terminalDirectory = path.join(terminalRoot, "work dir");
        const terminalFile = path.join(terminalRoot, "work file.txt");
        const terminalExecutable = path.join(terminalRoot, "work-bin");
        mkdirSync(terminalDirectory);
        writeFileSync(terminalFile, "text");
        writeExecutable(terminalExecutable, "#!/usr/bin/env bash\nexit 0\n");
        const [
            { backupRoutes },
            { cacheRoutes },
            { dockerRoutes },
            { pullRequestRoutes },
            { terminalRoutes },
        ] = await Promise.all([
            import("../src/routes/backupRoutes.ts"),
            import("../src/routes/cacheRoutes.ts"),
            import("../src/routes/dockerRoutes.ts"),
            import("../src/routes/pullRequestRoutes.ts"),
            import("../src/routes/terminalRoutes.ts"),
        ]);

        const missingCache = await cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/", { key: "" })
        );
        expect(missingCache.status).toBe(400);

        const unknownCache = await cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/nope", { key: "nope" })
        );
        expect(unknownCache.status).toBe(404);

        const backupStatus = backupRoutes["/api/backups/kopia"].GET();
        await expect(backupStatus.json()).resolves.toEqual({ job: undefined });

        const terminalComplete = await terminalRoutes["/api/terminal/complete"].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: terminalRoot,
                partial: "echo work",
            })
        );
        await expect(terminalComplete.json()).resolves.toMatchObject({
            commonPrefix: "echo work",
            completions: [
                {
                    completion: String.raw`echo work\ dir`,
                    display: "work dir/",
                    type: "directory",
                },
                {
                    completion: "echo work-bin",
                    display: "work-bin",
                    type: "executable",
                },
                {
                    completion: String.raw`echo work\ file.txt`,
                    display: "work file.txt",
                    type: "file",
                },
            ],
        });

        const invalidTerminalComplete = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: "relative",
                partial: "work",
            })
        );
        expect(invalidTerminalComplete.status).toBe(400);

        const terminalCdFile = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalRoot,
                path: "work file.txt",
            })
        );
        await expect(terminalCdFile.json()).resolves.toMatchObject({
            error: "Not a directory: work file.txt",
            isSuccess: false,
            newCwd: terminalRoot,
        });

        const invalidContainer = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(
            requestWithParameters("/api/docker/containers/--bad", {
                containerId: "--bad",
            })
        );
        expect(invalidContainer.status).toBe(400);

        const invalidAction = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/abc/action",
                { containerId: "abc" },
                { body: JSON.stringify({ action: "destroy" }), method: "POST" }
            )
        );
        expect(invalidAction.status).toBe(400);

        const missingExec = dockerRoutes["/api/docker/exec/:jobId"].GET(
            requestWithParameters("/api/docker/exec/missing", { jobId: "missing" })
        );
        expect(missingExec.status).toBe(404);

        const invalidExecStart = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", { command: "", containerId: "" })
        );
        expect(invalidExecStart.status).toBe(400);

        const invalidPrune = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", { target: "networks" })
        );
        expect(invalidPrune.status).toBe(400);

        const invalidUpdater = await dockerRoutes[
            "/api/docker/updater/services/:serviceId/update"
        ].POST(
            requestWithParameters("/api/docker/updater/services/not-number/update", {
                serviceId: "not-number",
            })
        );
        expect(invalidUpdater.status).toBe(400);

        for (const [route, handler] of [
            [
                "/api/pull-requests/:number/approve",
                pullRequestRoutes["/api/pull-requests/:number/approve"].POST,
            ],
            [
                "/api/pull-requests/:number/reject",
                pullRequestRoutes["/api/pull-requests/:number/reject"].POST,
            ],
            [
                "/api/pull-requests/:number/review-approval",
                pullRequestRoutes["/api/pull-requests/:number/review-approval"].POST,
            ],
            [
                "/api/pull-requests/:number/update-branch",
                pullRequestRoutes["/api/pull-requests/:number/update-branch"].POST,
            ],
        ] as const) {
            const response = await handler(
                requestWithParameters(route.replace(":number", "bad"), { number: "bad" })
            );
            expect(response.status).toBe(400);
        }
    });

    it("exec service validation and error normalization branches", async () => {
        const { execErrorResponse, getExecJob, runExecOnce, startExecJob, stopExecJob } =
            await import("../src/services/execJobs.ts");

        await expect(runExecOnce(undefined)).rejects.toThrow(
            "request body must be a JSON object"
        );
        await expect(runExecOnce({ command: "" })).rejects.toThrow(
            "command must be a non-empty string"
        );
        await expect(
            runExecOnce({ command: "x".repeat(4097), shell: true })
        ).rejects.toThrow("command exceeds maximum length");
        await expect(runExecOnce({ command: "echo\nnope", shell: true })).rejects.toThrow(
            "command contains disallowed control characters"
        );
        await expect(runExecOnce({ command: "echo", shell: "yes" })).rejects.toThrow(
            "shell must be a boolean"
        );
        await expect(
            runExecOnce({ args: ["hi"], command: "echo", shell: true })
        ).rejects.toThrow("args cannot be combined with shell mode");
        await expect(runExecOnce({ command: "echo", shell: true })).rejects.toThrow(
            "shell mode is only available"
        );
        await expect(runExecOnce({ command: "echo" })).rejects.toThrow(
            "args are required"
        );
        await expect(runExecOnce({ args: "hi", command: "echo" })).rejects.toThrow(
            "command executable is not approved"
        );
        await expect(runExecOnce({ args: ["hi"], command: "./echo" })).rejects.toThrow(
            "command must be an approved executable name"
        );
        await expect(runExecOnce({ args: ["hi"], command: "echo" })).rejects.toThrow(
            "command executable is not approved"
        );
        await expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: "relative",
                shell: true,
            })
        ).rejects.toThrow("cwd must be an absolute path");
        const missingCwd = path.join(tmpdir(), "missing-mira-dashboard-exec-cwd");
        await expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: missingCwd,
                shell: true,
            })
        ).rejects.toThrow("cwd does not exist");

        const result = await runExecOnce({
            command: "__mira_dashboard_shell_smoke_test__",
            cwd: process.cwd(),
            shell: true,
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("__mira_dashboard_shell_smoke_test__");

        const teapotError = Object.assign(new Error("nope"), { statusCode: 418 });
        expect(execErrorResponse(teapotError)).toEqual({
            error: "nope",
            status: 418,
        });
        const unknownExecError = JSON.parse("null") as unknown;
        expect(execErrorResponse(unknownExecError)).toEqual({
            error: "internal server error",
            status: 500,
        });

        expect(() => getExecJob("missing")).toThrow("Exec job not found");
        expect(() => stopExecJob("missing")).toThrow("Exec job not found");
        expect(() => startExecJob({ command: "" })).toThrow(
            "command must be a non-empty string"
        );

        const started = startExecJob({
            command: "__mira_dashboard_shell_smoke_test__",
            cwd: process.cwd(),
            shell: true,
        });
        expect(getExecJob(started.jobId)).toMatchObject({
            jobId: started.jobId,
            status: "running",
        });
        await Bun.sleep(50);
        const completed = getExecJob(started.jobId);
        expect(completed.status).toBe("done");
        expect(completed.code).not.toBe(0);
        expect(completed.stderr).toContain("__mira_dashboard_shell_smoke_test__");
        expect(() => stopExecJob(started.jobId)).toThrow("Job is not running");
    });

    it("log rotation config validation and dry-run summaries", async () => {
        const { runLogRotationService } = await import("../src/services/logRotation.ts");
        const root = createTemporaryRoot("mira-log-rotation-");
        const logFile = path.join(root, "service.log");
        const excludedFile = path.join(root, "excluded.log");
        writeFileSync(logFile, "line 1\nline 2\n");
        writeFileSync(excludedFile, "skip me\n");

        const validConfig = path.join(root, "log-rotation.json");
        writeFileSync(
            validConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: { keep: 2, maxSizeMb: 0.000001, missingOk: false },
                groups: [
                    {
                        name: "app",
                        paths: [path.join(root, "*.log")],
                        excludePaths: [excludedFile],
                        strategy: "copytruncate",
                    },
                    {
                        enabled: false,
                        name: "disabled",
                        paths: [logFile],
                    },
                ],
            })
        );

        const summary = await runLogRotationService({
            config: validConfig,
            group: "app",
            isDryRun: true,
            verbose: true,
        });
        expect(summary.isOk).toBe(true);
        expect(summary.checkedGroups).toBe(1);
        expect(summary.checkedFiles).toBe(1);
        expect(summary.rotatedFiles).toBe(1);
        expect(summary.skippedFiles).toBe(0);

        const badVersionConfig = path.join(root, "bad-version.json");
        writeFileSync(
            badVersionConfig,
            JSON.stringify({ version: 2, groups: [{ name: "app", paths: [logFile] }] })
        );
        await expect(
            runLogRotationService({ config: badVersionConfig, isDryRun: true })
        ).rejects.toThrow("Config version must be 1");

        const missingPathsConfig = path.join(root, "missing-paths.json");
        writeFileSync(
            missingPathsConfig,
            JSON.stringify({ version: 1, groups: [{ name: "app" }] })
        );
        await expect(
            runLogRotationService({ config: missingPathsConfig, isDryRun: true })
        ).rejects.toThrow("Group app needs at least one path pattern");

        const conflictingCadenceConfig = path.join(root, "conflicting-cadence.json");
        writeFileSync(
            conflictingCadenceConfig,
            JSON.stringify({
                version: 1,
                groups: [{ daily: true, name: "app", paths: [logFile], weekly: true }],
            })
        );
        await expect(
            runLogRotationService({ config: conflictingCadenceConfig, isDryRun: true })
        ).rejects.toThrow("cannot set both daily and weekly");

        const liveLogFile = path.join(root, "live.log");
        writeFileSync(liveLogFile, "rotated bytes\n");
        const liveConfig = path.join(root, "live-log-rotation.json");
        writeFileSync(
            liveConfig,
            JSON.stringify({
                version: 1,
                approvedRoots: [root],
                defaults: {
                    compress: false,
                    keep: 2,
                    maxSizeMb: 0.000001,
                    missingOk: false,
                    shouldCompress: false,
                    skipEmpty: false,
                    strategy: "copytruncate",
                },
                groups: [{ name: "live", paths: [liveLogFile] }],
            })
        );

        const liveSummary = await runLogRotationService({
            config: liveConfig,
            group: "live",
            isDryRun: false,
        });
        expect(liveSummary).toMatchObject({
            checkedFiles: 1,
            isDryRun: false,
            isOk: true,
            rotatedFiles: 1,
        });
        expect(readFileSync(liveLogFile, "utf8")).toBe("");
        const archiveName = readdirSync(root).find((entry) =>
            entry.startsWith("live.log.202")
        );
        expect(archiveName).toBeDefined();
        const archivePath = path.join(root, archiveName ?? "");
        expect(existsSync(archivePath)).toBe(true);
        expect(readFileSync(archivePath, "utf8")).toBe("rotated bytes\n");
    });

    it("cached quota/system readers and notification checks", async () => {
        const { TASK_ASSIGNEE_IDS, TASK_ASSIGNEES } =
            await import("../src/constants/taskActors.ts");
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");
        const { fetchCachedQuotas, hasQuotaStatus } =
            await import("../src/lib/quotasCache.ts");
        const { fetchCachedSystemHost } = await import("../src/lib/systemCache.ts");
        const { runQuotaNotificationCheck } =
            await import("../src/services/quotaNotifications.ts");
        const { runOpenClawNotificationCheck } =
            await import("../src/services/openclawNotifications.ts");

        expect(TASK_ASSIGNEE_IDS).toContain(TASK_ASSIGNEES.mira.id);
        expect(hasQuotaStatus({ status: "not_configured" })).toBe(true);
        expect(hasQuotaStatus({ status: "fresh" })).toBe(false);
        await expect(fetchCachedQuotas()).rejects.toThrow("Quota cache entry");
        await expect(fetchCachedSystemHost()).rejects.toThrow("System host cache entry");

        const checkedAt = Date.now() - 1000;
        writeCacheSuccess({
            key: "quotas.summary",
            data: {
                checkedAt,
                cacheAgeMs: 0,
                openrouter: {
                    percentUsed: 91,
                    remaining: 4.25,
                    totalCredits: 100,
                    usage: 95.75,
                    usageMonthly: 95.75,
                },
                elevenlabs: {
                    percentUsed: 70,
                    remaining: 3000,
                    resetAt: undefined,
                    tier: "starter",
                    total: 10_000,
                    used: 7000,
                },
                synthetic: {
                    rollingFiveHourLimit: {
                        limited: false,
                        max: 100,
                        nextTickAt: undefined,
                        percentUsed: 96,
                        remaining: 4,
                    },
                    searchHourly: {
                        limit: 20,
                        percentUsed: 10,
                        remaining: 18,
                        renewsAt: undefined,
                        requests: 2,
                    },
                    subscription: {
                        limit: 100,
                        percentUsed: 50,
                        remaining: 50,
                        renewsAt: undefined,
                        requests: 50,
                    },
                    weeklyTokenLimit: {
                        nextRegenAt: undefined,
                        percentRemaining: 6,
                    },
                },
                openai: {
                    account: "codex",
                    fiveHourLeftPercent: 9,
                    fiveHourReset: undefined,
                    model: "gpt",
                    percentUsed: 91,
                    resetAt: undefined,
                    weeklyLeftPercent: 8,
                    weeklyReset: undefined,
                },
            },
            metadata: { source: "test" },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });

        const quotas = await fetchCachedQuotas();
        expect(quotas.cacheAgeMs).toBeGreaterThanOrEqual(0);
        expect(await runQuotaNotificationCheck()).toBe(true);
        const quotaNotifications = database
            .prepare(
                "SELECT title FROM notifications WHERE source = 'quota' ORDER BY title"
            )
            .all() as Array<{ title: string }>;
        expect(quotaNotifications.map((row) => row.title)).toEqual([
            "OpenAI / Codex usage high (80%)",
            "OpenAI / Codex usage high (90%)",
            "OpenRouter usage high (80%)",
            "OpenRouter usage high (90%)",
            "Synthetic.new usage high (80%)",
            "Synthetic.new usage high (90%)",
            "Synthetic.new usage high (95%)",
        ]);

        const systemHostPayload = JSON.parse(`{
            "checkedAt": "2026-06-25T10:00:00.000Z",
            "gateway": null,
            "version": {
                "checkedAt": ${checkedAt},
                "current": "1.0.0",
                "latest": "1.1.0",
                "updateAvailable": true
            }
        }`) as Record<string, unknown>;
        writeCacheSuccess({
            key: "system.host",
            data: systemHostPayload,
            metadata: { source: "test" },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });

        const systemHost = await fetchCachedSystemHost();
        expect(systemHost.data.gateway).toBeUndefined();
        expect(systemHost.meta).toEqual({ source: "test" });
        expect(await runOpenClawNotificationCheck()).toBe(true);
        const openClawNotification = database
            .prepare(
                "SELECT title, description FROM notifications WHERE source = 'openclaw' LIMIT 1"
            )
            .get() as { description: string; title: string } | undefined;
        expect(openClawNotification).toEqual({
            description: "Current 1.0.0 \u{2192} latest 1.1.0.",
            title: "OpenClaw update available",
        });
    });

    it("refreshes Moltbook cache entries through normalized API responses", async () => {
        rememberEnvironment("MOLTBOOK_API_KEY");
        process.env.MOLTBOOK_API_KEY = "test-key";
        const originalFetch = fetch;
        cleanupCallbacks.push(() => {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        });
        const requestedUrls: string[] = [];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: (async (input: Parameters<typeof fetch>[0]) => {
                const url = String(input);
                requestedUrls.push(url);
                const body = url.endsWith("/home")
                    ? {
                          your_direct_messages: {
                              pending_request_count: "2",
                              unread_message_count: 3,
                          },
                          activity_on_your_posts: [{ id: "activity" }],
                          what_to_do_next: ["reply"],
                          latest_moltbook_announcement: {
                              author_name: "Moltbook",
                              created_at: "2026-06-25T10:00:00Z",
                              post_id: "post-1",
                              preview: "Hello",
                              title: "News",
                          },
                          posts_from_accounts_you_follow: [{ id: "followed" }],
                          explore: [{ id: "explore" }],
                      }
                    : url.includes("/feed?sort=hot")
                      ? {
                            feed_type: "hot",
                            has_more: true,
                            posts: [{ id: "hot-1" }],
                            tip: "hot tip",
                        }
                      : url.includes("/feed?sort=new")
                        ? {
                              feed_filter: "latest",
                              posts: [{ id: "new-1" }],
                          }
                        : url.includes("/agents/profile")
                          ? {
                                agent: { name: "mira_2026" },
                                recentComments: [{ id: "comment-1" }],
                                recentPosts: [{ id: "post-2" }],
                            }
                          : undefined;
                if (!body) {
                    return new Response("not found", { status: 404 });
                }
                return Response.json(body);
            }) as typeof fetch,
            writable: true,
        });

        const { refreshCacheProducer, refreshMoltbookCache } =
            await import("../src/services/cacheRefresh.ts");
        await expect(refreshMoltbookCache()).resolves.toEqual({
            refreshed: [
                "moltbook.home",
                "moltbook.feed.hot",
                "moltbook.feed.new",
                "moltbook.profile",
                "moltbook.my-content",
            ],
        });
        await expect(refreshCacheProducer("moltbook.feed.hot")).resolves.toEqual({
            refreshed: ["moltbook.feed.hot"],
        });
        expect(requestedUrls).toEqual(
            expect.arrayContaining([
                "https://www.moltbook.com/api/v1/home",
                "https://www.moltbook.com/api/v1/feed?sort=hot&limit=25",
                "https://www.moltbook.com/api/v1/feed?sort=new&limit=25",
                "https://www.moltbook.com/api/v1/agents/profile?name=mira_2026",
            ])
        );

        const rows = database
            .prepare(
                "SELECT key, data_json, source FROM cache_entries WHERE key LIKE 'moltbook.%' ORDER BY key"
            )
            .all() as Array<{ data_json: string; key: string; source: string }>;
        expect(rows.map((row) => row.key)).toEqual([
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.home",
            "moltbook.my-content",
            "moltbook.profile",
        ]);
        expect(rows.every((row) => row.source === "moltbook-api")).toBe(true);
        const home = JSON.parse(
            rows.find((row) => row.key === "moltbook.home")?.data_json ?? "{}"
        ) as Record<string, unknown>;
        expect(home).toMatchObject({
            activityOnYourPostsCount: 1,
            exploreCount: 1,
            pendingRequestCount: 2,
            unreadMessageCount: 3,
        });
        const profile = JSON.parse(
            rows.find((row) => row.key === "moltbook.profile")?.data_json ?? "{}"
        ) as Record<string, unknown>;
        expect(profile).toEqual({ agent: { name: "mira_2026" } });
    });

    it("refreshes backup and log-rotation cache producers through fake CLI output", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DOCKER_BIN");
        const binRoot = createTemporaryRoot("mira-cache-cli-");
        const now = new Date().toISOString();
        const dockerBin = path.join(binRoot, "docker");
        writeExecutable(
            dockerBin,
            `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == "exec kopia kopia snapshot list --all --json-verbose --json" ]]; then
  cat <<'JSON'
[
  {"id":"snap-docker","source":{"path":"/source/docker"},"stats":{"fileCount":2,"totalSize":200,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]},
  {"id":"snap-openclaw","source":{"path":"/source/openclaw"},"stats":{"fileCount":3,"totalSize":300,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]},
  {"id":"snap-projects","source":{"path":"/source/projects"},"stats":{"fileCount":4,"totalSize":400,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]}
]
JSON
elif [[ "$args" == "exec walg wal-g backup-list --detail --json" ]]; then
  cat <<'JSON'
[
  {"backup_name":"base_0001","finish_time":"${now}","start_time":"${now}","wal_file_name":"000000010000000000000001","storage_name":"default"}
]
JSON
else
  echo "unexpected docker args: $*" >&2
  exit 2
fi
`
        );
        process.env.MIRA_DOCKER_BIN = dockerBin;
        process.env.PATH = `${binRoot}:${process.env.PATH ?? ""}`;

        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");
        await expect(refreshCacheProducer("backup.kopia.status")).resolves.toEqual({
            refreshed: ["backup.kopia.status"],
        });
        await expect(refreshCacheProducer("backup.walg.status")).resolves.toEqual({
            refreshed: ["backup.walg.status"],
        });
        await expect(refreshCacheProducer("log_rotation.state")).resolves.toEqual({
            refreshed: ["log_rotation.state"],
        });

        const rows = database
            .prepare(
                "SELECT key, data_json, status FROM cache_entries WHERE key IN ('backup.kopia.status', 'backup.walg.status', 'log_rotation.state') ORDER BY key"
            )
            .all() as Array<{ data_json: string; key: string; status: string }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["backup.kopia.status", "fresh"],
            ["backup.walg.status", "fresh"],
            ["log_rotation.state", "fresh"],
        ]);
        const kopia = JSON.parse(
            rows.find((row) => row.key === "backup.kopia.status")?.data_json ?? "{}"
        ) as { isOk?: boolean; latest?: unknown[]; stale?: unknown[] };
        expect(kopia).toMatchObject({
            isOk: true,
            latest: expect.arrayContaining([
                expect.objectContaining({ path: "/source/docker" }),
                expect.objectContaining({ path: "/source/openclaw" }),
                expect.objectContaining({ path: "/source/projects" }),
            ]),
            stale: [],
        });
        const walg = JSON.parse(
            rows.find((row) => row.key === "backup.walg.status")?.data_json ?? "{}"
        ) as { backupCount?: number; isOk?: boolean; latest?: { backupName?: string } };
        expect(walg).toMatchObject({
            backupCount: 1,
            isOk: true,
            latest: { backupName: "base_0001" },
        });
    });

    it("refreshes quota cache with isolated missing-provider state", async () => {
        for (const key of [
            "OPENROUTER_API_KEY",
            "ELEVENLABS_API_KEY",
            "SYNTHETIC_API_KEY",
            "CODEX_BIN",
            "QUOTAS_CODEX_HOME",
        ]) {
            rememberEnvironment(key);
            delete process.env[key];
        }
        const codexHome = createTemporaryRoot("mira-quota-codex-home-");
        process.env.CODEX_BIN = path.join(codexHome, "missing-codex");
        process.env.QUOTAS_CODEX_HOME = codexHome;

        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");
        await expect(refreshCacheProducer("quotas.summary")).resolves.toEqual({
            refreshed: ["quotas.summary"],
        });

        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'quotas.summary' LIMIT 1"
            )
            .get() as
            | { data_json: string; metadata_json: string; status: string }
            | undefined;
        expect(row?.status).toBe("fresh");
        const data = JSON.parse(row?.data_json ?? "{}") as Record<
            string,
            Record<string, unknown>
        >;
        expect(data.openrouter).toEqual({ status: "not_configured" });
        expect(data.elevenlabs).toEqual({ status: "not_configured" });
        expect(data.synthetic).toEqual({ status: "not_configured" });
        expect(["not_configured", "error"]).toContain(String(data.openai?.status));
        const metadata = JSON.parse(row?.metadata_json ?? "{}") as {
            missing?: string[];
        };
        expect(metadata.missing).toEqual(
            expect.arrayContaining(["openrouter", "elevenlabs", "synthetic"])
        );
    });

    it("refreshes system cache through a fake OpenClaw binary", async () => {
        rememberEnvironment("OPENCLAW_BIN");
        const binRoot = createTemporaryRoot("mira-system-cache-bin-");
        const openclawBin = path.join(binRoot, "openclaw");
        writeExecutable(
            openclawBin,
            `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "status --json")
    cat <<'JSON'
{"runtimeVersion":"1.0.0","gateway":{"status":"ok"},"gatewayService":{"active":true},"nodeService":{"active":false},"heartbeat":{"ok":true},"tasks":{"queued":1},"taskAudit":{"stale":0}}
JSON
    ;;
  "update status --json")
    cat <<'JSON'
{"availability":{"latestVersion":"1.1.0"},"update":{"registry":{"latestVersion":"1.1.0"}}}
JSON
    ;;
  "doctor")
    printf '%s' "- WARNING: Gateway clients: informational"
    ;;
  "security audit --json")
    cat <<'JSON'
{"findings":[],"isOk":true}
JSON
    ;;
  *)
    echo "unexpected openclaw args: $*" >&2
    exit 2
    ;;
esac
`
        );
        process.env.OPENCLAW_BIN = openclawBin;

        const { refreshCacheProducer } = await import("../src/services/cacheRefresh.ts");
        await expect(refreshCacheProducer("system.host")).resolves.toEqual({
            refreshed: ["system.openclaw", "system.host"],
        });

        const rows = database
            .prepare(
                "SELECT key, data_json, status FROM cache_entries WHERE key IN ('system.openclaw', 'system.host') ORDER BY key"
            )
            .all() as Array<{ data_json: string; key: string; status: string }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["system.host", "fresh"],
            ["system.openclaw", "fresh"],
        ]);
        const openclaw = JSON.parse(
            rows.find((row) => row.key === "system.openclaw")?.data_json ?? "{}"
        ) as {
            doctorWarnings?: string[];
            security?: { isOk?: boolean };
            version?: { latest?: string; updateAvailable?: boolean };
        };
        expect(openclaw).toMatchObject({
            doctorWarnings: ["Gateway clients: informational"],
            security: { isOk: true },
            version: { latest: "1.1.0", updateAvailable: true },
        });
        const host = JSON.parse(
            rows.find((row) => row.key === "system.host")?.data_json ?? "{}"
        ) as {
            version?: { current?: string; latest?: string; updateAvailable?: boolean };
        };
        expect(host.version).toMatchObject({
            current: "1.0.0",
            latest: "1.1.0",
            updateAvailable: true,
        });
    });

    it("cache refresh scheduled job registration preserves disabled jobs", async () => {
        const {
            registerCacheRefreshScheduledJobs,
            seedMissingLocalCacheEntry,
            waitForLocalCacheSeed,
        } = await import("../src/services/cacheRefresh.ts");
        const { writeCacheSuccess } = await import("../src/services/cacheEntryWriter.ts");
        const { runScheduledJob, upsertScheduledJob } =
            await import("../src/services/scheduledJobs.ts");
        const jobs = [
            ["cache.weather", "weather.spydeberg"],
            ["cache.quotas", "quotas.summary"],
            ["cache.system", "system.host"],
            ["cache.git", "git.workspace"],
            ["cache.moltbook", "moltbook"],
            ["cache.backup.kopia", "backup.kopia.status"],
            ["cache.backup.walg", "backup.walg.status"],
        ] as const;

        for (const [id, key] of jobs) {
            upsertScheduledJob({
                id,
                name: `Existing ${id}`,
                description: "Existing disabled cache refresh job.",
                enabled: false,
                scheduleType: "interval",
                intervalSeconds: 123,
                actionKey: "cache.refresh",
                actionPayload: { key },
            });
        }

        registerCacheRefreshScheduledJobs();

        const rows = database
            .prepare(
                "SELECT id, enabled, interval_seconds FROM scheduled_jobs WHERE id LIKE 'cache.%' ORDER BY id"
            )
            .all() as Array<{
            enabled: number;
            id: string;
            interval_seconds: number;
        }>;
        expect(rows).toHaveLength(jobs.length);
        expect(rows.every((row) => row.enabled === 0)).toBe(true);
        expect(rows.every((row) => row.interval_seconds === 123)).toBe(true);
        await expect(waitForLocalCacheSeed("weather.spydeberg")).resolves.toBeUndefined();

        const freshKey = `test.cache.fresh.${Bun.randomUUIDv7()}`;
        try {
            writeCacheSuccess({
                data: { isFresh: true },
                key: freshKey,
                metadata: { source: "coverage" },
                source: "unit",
                ttl: 10,
                ttlUnit: "minutes",
            });
            seedMissingLocalCacheEntry(freshKey);
            await expect(waitForLocalCacheSeed(freshKey)).resolves.toBeUndefined();
            expect(
                database
                    .prepare("SELECT status FROM cache_entries WHERE key = ?")
                    .get(freshKey)
            ).toEqual({ status: "fresh" });
        } finally {
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(freshKey);
        }

        upsertScheduledJob({
            id: "cache.invalid-payload",
            name: "Invalid cache refresh payload",
            description: "Coverage for cache.refresh payload validation.",
            enabled: false,
            scheduleType: "interval",
            intervalSeconds: 3600,
            actionKey: "cache.refresh",
            actionPayload: {},
        });
        await expect(runScheduledJob("cache.invalid-payload")).resolves.toMatchObject({
            jobId: "cache.invalid-payload",
            message:
                "Scheduled cache job cache.invalid-payload is missing actionPayload.key",
            status: "failed",
        });
    });
});
