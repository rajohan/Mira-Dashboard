/* global Buffer, fetch, process */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(repoRoot, "dist/server.js");
const port = 3301;
const baseUrl = `http://127.0.0.1:${port}`;

let server;
let roots;

async function request(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: {
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...options.headers,
        },
    });

    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        body = text;
    }
    return { response, body };
}

async function waitForServer() {
    const deadline = Date.now() + 10_000;
    let lastError;

    while (Date.now() < deadline) {
        try {
            const { response } = await request("/api/health");
            if (response.ok) {
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(100);
    }

    throw lastError || new Error("Server did not become ready");
}

async function startServer() {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mira-dashboard-api-test-"));
    const homeRoot = path.join(temporaryRoot, "home");
    const openClawHome = path.join(homeRoot, ".openclaw");
    const workspaceRoot = path.join(temporaryRoot, "workspace");
    const dataRoot = path.join(temporaryRoot, "app");
    const mediaRoot = path.join(openClawHome, "media");
    await mkdir(path.join(openClawHome, "media"), { recursive: true });
    await mkdir(path.join(openClawHome, "cron"), { recursive: true });
    await mkdir(path.join(openClawHome, "hooks", "transforms"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "assets"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });

    await writeFile(
        path.join(openClawHome, "openclaw.json"),
        JSON.stringify(
            {
                agents: {
                    defaults: {
                        model: { primary: "codex", fallbacks: ["glm51"] },
                        models: { "openai-codex/gpt-5.5": { alias: "codex" } },
                    },
                    list: [
                        { id: "main", default: true, model: { primary: "codex" } },
                        {
                            id: "ops",
                            model: { primary: "synthetic/hf:zai-org/GLM-5.1" },
                        },
                    ],
                },
            },
            undefined,
            2
        ),
        "utf8"
    );
    await writeFile(path.join(openClawHome, "cron", "jobs.json"), "[]\n", "utf8");
    await writeFile(
        path.join(openClawHome, "hooks", "transforms", "agentmail.ts"),
        "export {};\n",
        "utf8"
    );
    await writeFile(path.join(workspaceRoot, "README.md"), "# Test Workspace\n", "utf8");
    await writeFile(path.join(workspaceRoot, ".secret"), "hidden\n", "utf8");
    await writeFile(
        path.join(workspaceRoot, "assets", "pixel.png"),
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            "base64"
        )
    );
    await writeFile(path.join(mediaRoot, "hello.txt"), "hello media", "utf8");

    const child = spawn(process.execPath, [serverEntry], {
        cwd: dataRoot,
        env: {
            ...process.env,
            HOME: homeRoot,
            MIRA_DASHBOARD_OPENCLAW_HOME: path.join(dataRoot, "openclaw-client"),
            OPENCLAW_HOME: openClawHome,
            PORT: String(port),
            WORKSPACE_ROOT: workspaceRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
        output += chunk.toString();
    });

    try {
        await waitForServer();
    } catch (error) {
        child.kill("SIGTERM");
        throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${output}`,
            { cause: error }
        );
    }

    return {
        roots: {
            dataRoot,
            homeRoot,
            mediaRoot,
            openClawHome,
            temporaryRoot,
            workspaceRoot,
        },
        async stop() {
            child.kill("SIGTERM");
            await new Promise((resolve) => child.once("exit", resolve));
            await rm(temporaryRoot, { recursive: true, force: true });
        },
    };
}

before(async () => {
    server = await startServer();
    roots = server.roots;
});

after(async () => {
    await server?.stop();
});

test("health and loopback session endpoints are available", async () => {
    const health = await request("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(typeof health.body.gatewayConnected, "boolean");

    const session = await request("/api/auth/session");
    assert.equal(session.response.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.user.username, "mira-local");
});

test("task lifecycle API supports create, update, move, progress, and delete", async () => {
    const created = await request("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
            title: "Smoke test task",
            body: "Created by backend API smoke test",
            labels: ["priority-high"],
            assignee: "rajohan",
        }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.title, "Smoke test task");
    assert.deepEqual(
        created.body.labels.map((label) => label.name).toSorted(),
        ["priority-high", "todo"].toSorted()
    );

    const taskId = created.body.number;
    assert.equal(typeof taskId, "number");

    const listed = await request("/api/tasks");
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.some((task) => task.number === taskId));

    const moved = await request(`/api/tasks/${taskId}/move`, {
        method: "POST",
        body: JSON.stringify({ columnLabel: "in-progress" }),
    });
    assert.equal(moved.response.status, 200);
    assert.ok(moved.body.labels.some((label) => label.name === "in-progress"));

    const update = await request(`/api/tasks/${taskId}/updates`, {
        method: "POST",
        body: JSON.stringify({
            author: "mira-2026",
            messageMd: "Progress update from smoke test",
        }),
    });
    assert.equal(update.response.status, 201);
    assert.equal(update.body.messageMd, "Progress update from smoke test");

    const updates = await request(`/api/tasks/${taskId}/updates`);
    assert.equal(updates.response.status, 200);
    assert.equal(updates.body.length, 1);

    const patched = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({
            title: "Updated smoke test task",
            labels: ["done", "priority-low"],
        }),
    });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.body.title, "Updated smoke test task");
    assert.equal(patched.body.state, "CLOSED");

    const deleted = await request(`/api/tasks/${taskId}`, { method: "DELETE" });
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(deleted.body, { ok: true });
});

test("task API returns validation errors for invalid input", async () => {
    const missingTitle = await request("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ assignee: "rajohan" }),
    });
    assert.equal(missingTitle.response.status, 400);
    assert.equal(missingTitle.body.error, "Title is required");

    const invalidAssignee = await request("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "Invalid", assignee: "nobody" }),
    });
    assert.equal(invalidAssignee.response.status, 400);
    assert.equal(invalidAssignee.body.error, "Assignee must be Mira or Raymond");

    const missingTask = await request("/api/tasks/999999/move", {
        method: "POST",
        body: JSON.stringify({ columnLabel: "done" }),
    });
    assert.equal(missingTask.response.status, 404);
    assert.equal(missingTask.body.error, "Task not found");
});

test("files API lists, reads, writes, and blocks traversal outside workspace", async () => {
    const listed = await request("/api/files");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.root, roots.workspaceRoot);
    assert.ok(listed.body.files.some((file) => file.path === "README.md"));
    assert.ok(listed.body.files.some((file) => file.path === "assets"));
    assert.equal(
        listed.body.files.some((file) => file.name === ".secret"),
        false
    );

    const readme = await request("/api/files/README.md");
    assert.equal(readme.response.status, 200);
    assert.equal(readme.body.content, "# Test Workspace\n");
    assert.equal(readme.body.isBinary, false);

    const image = await request("/api/files/assets%2Fpixel.png");
    assert.equal(image.response.status, 200);
    assert.equal(image.body.isImage, true);
    assert.equal(image.body.mimeType, "image/png");

    const written = await request("/api/files/notes%2Ftodo.md", {
        method: "PUT",
        body: JSON.stringify({ content: "ship more tests\n" }),
    });
    assert.equal(written.response.status, 200);
    assert.equal(written.body.success, true);

    const reread = await request("/api/files/notes%2Ftodo.md");
    assert.equal(reread.response.status, 200);
    assert.equal(reread.body.content, "ship more tests\n");

    const missingContent = await request("/api/files/notes%2Fmissing.md", {
        method: "PUT",
        body: JSON.stringify({}),
    });
    assert.equal(missingContent.response.status, 400);
    assert.equal(missingContent.body.error, "Content required");

    const traversal = await request(`/api/files/${encodeURIComponent("../outside.txt")}`);
    assert.equal(traversal.response.status, 403);
});

test("config-files API is whitelist constrained and creates backups on write", async () => {
    const listed = await request("/api/config-files");
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.root, roots.openClawHome);
    assert.deepEqual(
        listed.body.files.map((file) => file.relPath).toSorted(),
        ["cron/jobs.json", "hooks/transforms/agentmail.ts", "openclaw.json"].toSorted()
    );

    const original = await request("/api/config-files/openclaw.json");
    assert.equal(original.response.status, 200);
    assert.ok(original.body.content.includes('"agents"'));

    const updatedContent = JSON.stringify(
        { agents: { defaults: {}, list: [] } },
        undefined,
        2
    );
    const updated = await request("/api/config-files/openclaw.json", {
        method: "PUT",
        body: JSON.stringify({ content: updatedContent }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.success, true);

    const reread = await request("/api/config-files/openclaw.json");
    assert.equal(reread.response.status, 200);
    assert.equal(reread.body.content, updatedContent);

    const denied = await request("/api/config-files/not-allowed.json");
    assert.equal(denied.response.status, 403);

    await request("/api/config-files/openclaw.json", {
        method: "PUT",
        body: JSON.stringify({ content: original.body.content }),
    });
});

test("agent config, status, metadata, and task history APIs work from isolated OpenClaw home", async () => {
    const config = await request("/api/agents/config");
    assert.equal(config.response.status, 200);
    assert.equal(config.body.defaults.model.primary, "codex");
    assert.deepEqual(
        config.body.list.map((agent) => agent.id),
        ["main", "ops"]
    );

    const firstTask = await request("/api/agents/main/metadata", {
        method: "PUT",
        body: JSON.stringify({ currentTask: "Write backend tests" }),
    });
    assert.equal(firstTask.response.status, 200);
    assert.equal(firstTask.body.currentTask, "Write backend tests");

    const repeatedTask = await request("/api/agents/main/metadata", {
        method: "PUT",
        body: JSON.stringify({ currentTask: "Write backend tests" }),
    });
    assert.equal(repeatedTask.response.status, 200);

    const secondTask = await request("/api/agents/main/metadata", {
        method: "PUT",
        body: JSON.stringify({ currentTask: "Review backend tests" }),
    });
    assert.equal(secondTask.response.status, 200);
    assert.equal(secondTask.body.currentTask, "Review backend tests");

    const status = await request("/api/agents/main/status");
    assert.equal(status.response.status, 200);
    assert.equal(status.body.id, "main");
    assert.equal(status.body.model, "gpt-5.5");
    assert.equal(status.body.currentTask, "Review backend tests");

    const history = await request("/api/agents/tasks/history?limit=1");
    assert.equal(history.response.status, 200);
    assert.equal(history.body.tasks.length, 1);
    assert.equal(history.body.tasks[0].task, "Write backend tests");
    assert.equal(history.body.tasks[0].status, "completed");

    const invalid = await request("/api/agents/main/metadata", {
        method: "PUT",
        body: JSON.stringify({ currentTask: "" }),
    });
    assert.equal(invalid.response.status, 400);

    const missing = await request("/api/agents/missing/status");
    assert.equal(missing.response.status, 404);
});

test("settings API returns defaults and persists updates in isolated home", async () => {
    const defaults = await request("/api/settings");
    assert.equal(defaults.response.status, 200);
    assert.equal(defaults.body.theme, "dark");
    assert.equal(defaults.body.defaultModel, "ollama/glm-5");
    assert.equal(defaults.body.gateway.gateway, "disconnected");

    const updated = await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ theme: "light", sidebarCollapsed: true }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.theme, "light");
    assert.equal(updated.body.sidebarCollapsed, true);

    const reread = await request("/api/settings");
    assert.equal(reread.response.status, 200);
    assert.equal(reread.body.theme, "light");
    assert.equal(reread.body.sidebarCollapsed, true);
});

test("notifications API validates, dedupes, marks read, clears, and deletes", async () => {
    const invalid = await request("/api/notifications", {
        method: "POST",
        body: JSON.stringify({ description: "Missing title" }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error, "title is required");

    const created = await request("/api/notifications", {
        method: "POST",
        body: JSON.stringify({
            title: "Quota warning",
            description: "OpenRouter is nearly empty",
            type: "warning",
            source: "test",
            dedupeKey: "quota:openrouter",
            metadata: { provider: "openrouter" },
        }),
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.ok, true);
    assert.equal(typeof created.body.id, "number");

    const deduped = await request("/api/notifications", {
        method: "POST",
        body: JSON.stringify({
            title: "Quota warning updated",
            description: "Still nearly empty",
            type: "error",
            source: "test",
            dedupeKey: "quota:openrouter",
            metadata: { provider: "openrouter", severity: "high" },
        }),
    });
    assert.equal(deduped.response.status, 200);

    const listed = await request("/api/notifications?limit=20");
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.unreadCount >= 1);
    const notification = listed.body.items.find(
        (item) => item.dedupeKey === "quota:openrouter"
    );
    assert.equal(notification.title, "Quota warning updated");
    assert.deepEqual(notification.metadata, {
        provider: "openrouter",
        severity: "high",
    });

    const notificationId = notification.id;
    const marked = await request(`/api/notifications/${notificationId}/read`, {
        method: "POST",
    });
    assert.equal(marked.response.status, 200);
    assert.equal(marked.body.ok, true);

    const afterRead = await request("/api/notifications?limit=20");
    const readNotification = afterRead.body.items.find(
        (item) => item.id === notificationId
    );
    assert.equal(readNotification.isRead, true);

    const cleared = await request("/api/notifications/clear-read", { method: "POST" });
    assert.equal(cleared.response.status, 200);
    assert.ok(cleared.body.deleted >= 1);

    const invalidDelete = await request("/api/notifications/not-a-number", {
        method: "DELETE",
    });
    assert.equal(invalidDelete.response.status, 400);
});

test("terminal completion and cd endpoints resolve relative paths", async () => {
    const completed = await request("/api/terminal/complete", {
        method: "POST",
        body: JSON.stringify({ partial: "REA", cwd: roots.workspaceRoot }),
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.commonPrefix, "README.md");
    assert.deepEqual(completed.body.completions[0], {
        completion: "README.md",
        display: "README.md",
        type: "file",
    });

    const changed = await request("/api/terminal/cd", {
        method: "POST",
        body: JSON.stringify({ path: "src", cwd: roots.workspaceRoot }),
    });
    assert.equal(changed.response.status, 200);
    assert.deepEqual(changed.body, {
        success: true,
        newCwd: path.join(roots.workspaceRoot, "src"),
    });

    const invalid = await request("/api/terminal/cd", {
        method: "POST",
        body: JSON.stringify({ path: "missing", cwd: roots.workspaceRoot }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.success, false);
});

test("media API serves files from OpenClaw media root only", async () => {
    const mediaPath = path.join(roots.mediaRoot, "hello.txt");
    const media = await request(`/api/media?path=${encodeURIComponent(mediaPath)}`);
    assert.equal(
        media.response.status,
        200,
        JSON.stringify({ body: media.body, mediaPath })
    );
    assert.equal(media.response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(media.body, "hello media");

    const denied = await request(
        `/api/media?path=${encodeURIComponent(path.join(roots.workspaceRoot, "README.md"))}`
    );
    assert.equal(denied.response.status, 403);
});

test("auth bootstrap validation and logout endpoints avoid gateway side effects", async () => {
    const bootstrap = await request("/api/auth/bootstrap");
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.body.bootstrapRequired, true);
    assert.equal(bootstrap.body.hasGatewayToken, false);

    const badRegistration = await request("/api/auth/register-first-user", {
        method: "POST",
        body: JSON.stringify({ username: "x", password: "short", gatewayToken: "" }),
    });
    assert.equal(badRegistration.response.status, 400);
    assert.match(badRegistration.body.error, /Username/u);

    const prematureLogin = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "raymond", password: "password123" }),
    });
    assert.equal(prematureLogin.response.status, 409);
    assert.equal(prematureLogin.body.error, "Create the first user before logging in");

    const logout = await request("/api/auth/logout", { method: "POST" });
    assert.equal(logout.response.status, 200);
    assert.equal(logout.body.ok, true);
    assert.match(logout.response.headers.get("set-cookie") || "", /Max-Age=0/u);
});

test("task assignment and progress update editing endpoints validate lifecycle changes", async () => {
    const created = await request("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
            title: "Task update lifecycle",
            body: "Exercise update edit/delete endpoints",
            labels: ["priority-low"],
            assignee: "rajohan",
            automation: {
                cronJobId: "cron-123",
                scheduleSummary: "Every 30m",
                model: "codex",
            },
        }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.automation.cronJobId, "cron-123");
    assert.equal(created.body.automation.scheduleSummary, "Every 30m");

    const taskId = created.body.number;

    const invalidAssign = await request(`/api/tasks/${taskId}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignee: "nobody" }),
    });
    assert.equal(invalidAssign.response.status, 400);
    assert.equal(invalidAssign.body.error, "Assignee must be Mira or Raymond");

    const assigned = await request(`/api/tasks/${taskId}/assign`, {
        method: "POST",
        body: JSON.stringify({ assignee: "rajohan" }),
    });
    assert.equal(assigned.response.status, 200);
    assert.equal(assigned.body.assignees[0].login, "rajohan");

    const invalidUpdate = await request(`/api/tasks/${taskId}/updates`, {
        method: "POST",
        body: JSON.stringify({ author: "rajohan", messageMd: "" }),
    });
    assert.equal(invalidUpdate.response.status, 400);

    const update = await request(`/api/tasks/${taskId}/updates`, {
        method: "POST",
        body: JSON.stringify({ author: "rajohan", messageMd: "Initial progress" }),
    });
    assert.equal(update.response.status, 201);
    assert.equal(update.body.messageMd, "Initial progress");

    const edited = await request(`/api/tasks/${taskId}/updates/${update.body.id}`, {
        method: "PATCH",
        body: JSON.stringify({ author: "mira-2026", messageMd: "Edited progress" }),
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.author, "mira-2026");
    assert.equal(edited.body.messageMd, "Edited progress");

    const missingEdit = await request(`/api/tasks/${taskId}/updates/999999`, {
        method: "PATCH",
        body: JSON.stringify({ author: "rajohan", messageMd: "Nope" }),
    });
    assert.equal(missingEdit.response.status, 404);

    const deletedUpdate = await request(
        `/api/tasks/${taskId}/updates/${update.body.id}`,
        {
            method: "DELETE",
        }
    );
    assert.equal(deletedUpdate.response.status, 200);
    assert.equal(deletedUpdate.body.ok, true);

    const deletedAgain = await request(`/api/tasks/${taskId}/updates/${update.body.id}`, {
        method: "DELETE",
    });
    assert.equal(deletedAgain.response.status, 404);

    const deletedTask = await request(`/api/tasks/${taskId}`, { method: "DELETE" });
    assert.equal(deletedTask.response.status, 200);
});

test("exec API supports one-shot commands, async job polling, and missing-job errors", async () => {
    const oneShot = await request("/api/exec", {
        method: "POST",
        body: JSON.stringify({
            command: process.execPath,
            args: ["-e", "console.log('hello exec')"],
            cwd: roots.workspaceRoot,
        }),
    });
    assert.equal(oneShot.response.status, 200);
    assert.equal(oneShot.body.code, 0);
    assert.equal(oneShot.body.stdout, "hello exec\n");

    const started = await request("/api/exec/start", {
        method: "POST",
        body: JSON.stringify({
            command: process.execPath,
            args: ["-e", "setTimeout(() => console.log('async exec'), 20)"],
            cwd: roots.workspaceRoot,
        }),
    });
    assert.equal(started.response.status, 200);
    assert.equal(typeof started.body.jobId, "string");

    let job;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        job = await request(`/api/exec/${started.body.jobId}`);
        if (job.body.status === "done") {
            break;
        }
        await delay(50);
    }

    assert.equal(job.response.status, 200);
    assert.equal(job.body.status, "done");
    assert.equal(job.body.code, 0);
    assert.equal(job.body.stdout, "async exec\n");

    const stopDone = await request(`/api/exec/${started.body.jobId}/stop`, {
        method: "POST",
    });
    assert.equal(stopDone.response.status, 400);
    assert.equal(stopDone.body.error, "Job is not running");

    const missing = await request("/api/exec/missing-job");
    assert.equal(missing.response.status, 404);
});

test("session APIs return empty disconnected state and validate unsupported actions", async () => {
    const legacyList = await request("/api/sessions");
    assert.equal(legacyList.response.status, 200);
    assert.deepEqual(legacyList.body, []);

    const list = await request("/api/sessions/list");
    assert.equal(list.response.status, 200);
    assert.deepEqual(list.body.sessions, []);

    const filteredList = await request("/api/sessions/list?type=direct&model=codex");
    assert.equal(filteredList.response.status, 200);
    assert.deepEqual(filteredList.body.sessions, []);

    const stats = await request("/api/sessions/stats");
    assert.equal(stats.response.status, 200);
    assert.deepEqual(stats.body, {
        total: 0,
        byType: {},
        byModel: {},
        totalTokens: 0,
        activeInLastHour: 0,
    });

    const unsupportedAction = await request("/api/sessions/missing/action", {
        method: "POST",
        body: JSON.stringify({ action: "dance" }),
    });
    assert.equal(unsupportedAction.response.status, 400);
    assert.equal(unsupportedAction.body.error, "Unsupported action: dance");
});
