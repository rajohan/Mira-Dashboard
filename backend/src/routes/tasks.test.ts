import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import { TASK_ASSIGNEES } from "../constants/taskActors.js";
import { db } from "../db.js";
import tasksRoutes from "./tasks.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    tasksRoutes(app, express);
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

function cleanupTasksWithPrefix(prefix: string): void {
    const rows = db
        .prepare("SELECT id FROM tasks WHERE title LIKE ?")
        .all(`${prefix}%`) as Array<{
        id: number;
    }>;

    for (const row of rows) {
        db.prepare("DELETE FROM task_updates WHERE task_id = ?").run(row.id);
        db.prepare("DELETE FROM task_events WHERE task_id = ?").run(row.id);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(row.id);
    }
}

interface FrontendTask {
    number: number;
    title: string;
    body: string;
    state: "OPEN" | "CLOSED";
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string; name: string }>;
    automation?: {
        type: "cron";
        recurring: boolean;
        cronJobId: string;
        scheduleSummary?: string;
        sessionTarget?: string;
        model?: string;
        thinking?: string;
        source: "stored" | "cron";
    };
}

interface TaskUpdate {
    id: number;
    taskId: number;
    author: string;
    messageMd: string;
    createdAt: string;
}

describe("tasks routes", () => {
    const titlePrefix = `backend-test-${Date.now()}-`;
    let server: TestServer;

    before(async () => {
        cleanupTasksWithPrefix(titlePrefix);
        server = await startServer();
    });

    after(async () => {
        await server.close();
        cleanupTasksWithPrefix(titlePrefix);
    });

    it("validates task creation input", async () => {
        const missingTitle = await requestJson<{ error: string }>(server, "/api/tasks", {
            method: "POST",
            body: { title: "", assignee: TASK_ASSIGNEES.raymond.id },
        });

        assert.equal(missingTitle.status, 400);
        assert.equal(missingTitle.body.error, "Title is required");

        const invalidAssignee = await requestJson<{ error: string }>(
            server,
            "/api/tasks",
            {
                method: "POST",
                body: { title: `${titlePrefix}invalid`, assignee: "nobody" },
            }
        );

        assert.equal(invalidAssignee.status, 400);
        assert.equal(invalidAssignee.body.error, "Assignee must be Mira or Raymond");
    });

    it("creates, edits, moves, assigns, and deletes tasks", async () => {
        const created = await requestJson<FrontendTask>(server, "/api/tasks", {
            method: "POST",
            body: {
                title: `  ${titlePrefix}lifecycle  `,
                body: "Initial body",
                assignee: TASK_ASSIGNEES.raymond.id,
                labels: ["in-progress", "priority-high", "backend"],
                automation: {
                    cronJobId: "cron-test-1",
                    scheduleSummary: "Every 30m",
                    sessionTarget: "session:backend-tests",
                    model: "codex",
                    thinking: "high",
                },
            },
        });

        assert.equal(created.status, 201);
        assert.equal(created.body.title, `${titlePrefix}lifecycle`);
        assert.equal(created.body.body, "Initial body");
        assert.equal(created.body.state, "OPEN");
        assert.deepEqual(
            created.body.labels.map((label) => label.name).sort(),
            ["backend", "in-progress", "priority-high"].sort()
        );
        assert.deepEqual(created.body.assignees, [
            { login: TASK_ASSIGNEES.raymond.id, name: TASK_ASSIGNEES.raymond.id },
        ]);
        assert.deepEqual(created.body.automation, {
            type: "cron",
            recurring: true,
            cronJobId: "cron-test-1",
            scheduleSummary: "Every 30m",
            sessionTarget: "session:backend-tests",
            model: "codex",
            thinking: "high",
            source: "stored",
        });

        const patched = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}`,
            {
                method: "PATCH",
                body: {
                    title: "   ",
                    body: "Updated body",
                    labels: ["done", "priority-low"],
                    automation: null,
                },
            }
        );

        assert.equal(patched.status, 200);
        assert.equal(patched.body.title, `${titlePrefix}lifecycle`);
        assert.equal(patched.body.body, "Updated body");
        assert.equal(patched.body.state, "CLOSED");
        assert.equal(patched.body.automation, undefined);
        assert.deepEqual(
            patched.body.labels.map((label) => label.name).sort(),
            ["done", "priority-low"].sort()
        );

        const moved = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}/move`,
            { method: "POST", body: { columnLabel: "blocked" } }
        );

        assert.equal(moved.status, 200);
        assert.equal(moved.body.state, "OPEN");
        assert.deepEqual(
            moved.body.labels.map((label) => label.name).sort(),
            ["blocked", "priority-low"].sort()
        );

        const assigned = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}/assign`,
            { method: "POST", body: { assignee: TASK_ASSIGNEES.raymond.id } }
        );

        assert.equal(assigned.status, 200);
        assert.deepEqual(assigned.body.assignees, [
            { login: TASK_ASSIGNEES.raymond.id, name: TASK_ASSIGNEES.raymond.id },
        ]);

        const deleted = await requestJson<{ ok: true }>(
            server,
            `/api/tasks/${created.body.number}`,
            { method: "DELETE" }
        );

        assert.equal(deleted.status, 200);
        assert.deepEqual(deleted.body, { ok: true });

        const missing = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}`,
            { method: "DELETE" }
        );
        assert.equal(missing.status, 404);
    });

    it("validates, creates, edits, lists, and deletes task updates", async () => {
        const created = await requestJson<FrontendTask>(server, "/api/tasks", {
            method: "POST",
            body: {
                title: `${titlePrefix}updates`,
                assignee: TASK_ASSIGNEES.raymond.id,
                labels: ["todo"],
            },
        });

        assert.equal(created.status, 201);

        const invalidUpdate = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}/updates`,
            {
                method: "POST",
                body: { author: "nobody", messageMd: "" },
            }
        );

        assert.equal(invalidUpdate.status, 400);

        const update = await requestJson<TaskUpdate>(
            server,
            `/api/tasks/${created.body.number}/updates`,
            {
                method: "POST",
                body: {
                    author: TASK_ASSIGNEES.raymond.id,
                    messageMd: "  Started work  ",
                },
            }
        );

        assert.equal(update.status, 201);
        assert.equal(update.body.taskId, created.body.number);
        assert.equal(update.body.author, TASK_ASSIGNEES.raymond.id);
        assert.equal(update.body.messageMd, "Started work");

        const listed = await requestJson<TaskUpdate[]>(
            server,
            `/api/tasks/${created.body.number}/updates`
        );

        assert.equal(listed.status, 200);
        assert.equal(listed.body[0]?.id, update.body.id);

        const edited = await requestJson<TaskUpdate>(
            server,
            `/api/tasks/${created.body.number}/updates/${update.body.id}`,
            {
                method: "PATCH",
                body: { author: TASK_ASSIGNEES.mira.id, messageMd: "  Done  " },
            }
        );

        assert.equal(edited.status, 200);
        assert.equal(edited.body.author, TASK_ASSIGNEES.mira.id);
        assert.equal(edited.body.messageMd, "Done");

        const deleted = await requestJson<{ ok: true }>(
            server,
            `/api/tasks/${created.body.number}/updates/${update.body.id}`,
            { method: "DELETE" }
        );

        assert.equal(deleted.status, 200);
        assert.deepEqual(deleted.body, { ok: true });
    });
});
