/* global fetch, process */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(repoRoot, "dist/server.js");
const port = 3301;
const baseUrl = `http://127.0.0.1:${port}`;

async function request(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: {
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...options.headers,
        },
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;
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
    const openClawHome = path.join(temporaryRoot, "openclaw");
    const dataRoot = path.join(temporaryRoot, "app");
    await mkdir(path.join(openClawHome, "media"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });

    const child = spawn(process.execPath, [serverEntry], {
        cwd: dataRoot,
        env: {
            ...process.env,
            OPENCLAW_HOME: openClawHome,
            PORT: String(port),
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
        async stop() {
            child.kill("SIGTERM");
            await new Promise((resolve) => child.once("exit", resolve));
            await rm(temporaryRoot, { recursive: true, force: true });
        },
    };
}

test("health and loopback session endpoints are available", async () => {
    const server = await startServer();
    try {
        const health = await request("/api/health");
        assert.equal(health.response.status, 200);
        assert.equal(health.body.status, "ok");
        assert.equal(typeof health.body.gatewayConnected, "boolean");

        const session = await request("/api/auth/session");
        assert.equal(session.response.status, 200);
        assert.equal(session.body.authenticated, true);
        assert.equal(session.body.user.username, "mira-local");
    } finally {
        await server.stop();
    }
});

test("task lifecycle API supports create, update, move, progress, and delete", async () => {
    const server = await startServer();
    try {
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
    } finally {
        await server.stop();
    }
});

test("task API returns validation errors for invalid input", async () => {
    const server = await startServer();
    try {
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
    } finally {
        await server.stop();
    }
});
