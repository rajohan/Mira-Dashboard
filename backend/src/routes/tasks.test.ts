import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import { TASK_ASSIGNEES } from "../constants/taskActors.js";
import { db } from "../db.js";
import gateway from "../gateway.js";
import tasksRoutes, { __testing } from "./tasks.js";

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
        lastRunStatus?: string;
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

    it("covers task mapping helper edge cases", () => {
        const baseTask = {
            id: 42,
            title: "Helper task",
            body: "Body",
            status: "todo",
            priority: "medium",
            labels_json: JSON.stringify(["custom", 123]),
            automation_json: "{}",
            assignee: null,
            created_at: "2026-05-25T00:00:00.000Z",
            updated_at: "2026-05-25T00:00:00.000Z",
        };

        assert.equal(__testing.normalizeStatus("done"), "done");
        assert.equal(__testing.normalizeStatus("blocked"), "blocked");
        assert.equal(__testing.normalizeStatus("in-progress"), "in-progress");
        assert.equal(__testing.normalizeStatus("unknown"), "todo");
        assert.equal(__testing.derivePriority(["priority-high"]), "high");
        assert.equal(__testing.derivePriority(["priority-low"]), "low");
        assert.equal(__testing.derivePriority(["low"]), "low");
        assert.equal(__testing.derivePriority([]), "medium");
        assert.deepEqual(__testing.parseRecordJson("{bad"), {});
        assert.deepEqual(__testing.parseRecordJson("[]"), {});
        assert.deepEqual(__testing.parseRecordJson("null"), {});
        assert.equal(__testing.serializeTaskEventPayload("started"), '"started"');
        assert.equal(__testing.serializeTaskEventPayload(3), "3");
        assert.equal(__testing.serializeTaskEventPayload(false), "false");
        assert.equal(__testing.serializeTaskEventPayload({ ok: true }), '{"ok":true}');
        assert.equal(__testing.serializeTaskEventPayload(null), "{}");
        const missingPayload: unknown = undefined;
        assert.equal(__testing.serializeTaskEventPayload(missingPayload), "null");
        assert.equal(__testing.normalizeAutomationInput(null), "{}");
        assert.equal(__testing.normalizeAutomationInput([]), "{}");
        assert.equal(__testing.normalizeAutomationInput({ cronJobId: "   " }), "{}");
        assert.deepEqual(__testing.normalizeCronJobs({ jobs: [{ id: "job-1" }] }), [
            { id: "job-1" },
        ]);
        assert.deepEqual(__testing.normalizeCronJobs({ items: [{ id: "job-2" }] }), [
            { id: "job-2" },
        ]);
        assert.deepEqual(__testing.normalizeCronJobs(null), []);
        assert.deepEqual(__testing.normalizeCronJobs({}), []);
        assert.equal(__testing.formatScheduleSummary(void 0), undefined);
        assert.equal(
            __testing.formatScheduleSummary({
                kind: "cron",
                expr: "0 * * * *",
                tz: "UTC",
            }),
            "0 * * * * (UTC)"
        );
        assert.equal(
            __testing.formatScheduleSummary({ kind: "cron", expr: "0 * * * *" }),
            "0 * * * *"
        );
        assert.equal(
            __testing.formatScheduleSummary({ kind: "every", everyMs: 30 * 60_000 }),
            "Every 30m"
        );
        assert.equal(
            __testing.formatScheduleSummary({ kind: "every", everyMs: 2 * 60 * 60_000 }),
            "Every 2h"
        );
        assert.equal(
            __testing.formatScheduleSummary({ kind: "every", everyMs: 15_000 }),
            "Every 15s"
        );
        assert.equal(
            __testing.formatScheduleSummary({ kind: "every", everyMs: 0 }),
            "every"
        );
        assert.equal(
            __testing.formatScheduleSummary({ kind: "at", at: "2026-05-25T09:00:00Z" }),
            "2026-05-25T09:00:00Z"
        );
        assert.equal(__testing.formatScheduleSummary({ kind: "custom" }), "custom");
        assert.equal(__testing.formatScheduleSummary({}), "Scheduled");

        const normalizedAutomation = JSON.parse(
            __testing.normalizeAutomationInput({
                cronJobId: " cron-1 ",
                recurring: false,
                scheduleSummary: " hourly ",
                sessionTarget: " agent:main:main ",
                model: " codex ",
                thinking: " high ",
            })
        );
        assert.deepEqual(normalizedAutomation, {
            type: "cron",
            recurring: false,
            cronJobId: "cron-1",
            scheduleSummary: "hourly",
            sessionTarget: "agent:main:main",
            model: "codex",
            thinking: "high",
        });

        const frontend = __testing.toFrontendTask(baseTask as never);
        assert.equal(frontend.state, "OPEN");
        assert.deepEqual(frontend.assignees, []);
        assert.deepEqual(
            frontend.labels.map((label) => label.name).sort(),
            ["custom", "priority-medium", "todo"].sort()
        );

        const nonArrayLabels = __testing.labelsFromTask({
            ...baseTask,
            labels_json: JSON.stringify({ label: "not-array" }),
            status: "done",
            priority: "high",
        } as never);
        assert.deepEqual(nonArrayLabels.sort(), ["done", "priority-high"].sort());

        const invalidLabels = __testing.labelsFromTask({
            ...baseTask,
            labels_json: "{bad",
            status: "blocked",
            priority: "low",
        } as never);
        assert.deepEqual(invalidLabels.sort(), ["blocked", "priority-low"].sort());
    });

    it("lists tasks with cron automation details from the gateway", async () => {
        const originalRequest = gateway.request;
        gateway.request = async () => ({
            jobs: [
                {
                    jobId: "cron-enriched",
                    name: "Backend coverage",
                    enabled: true,
                    schedule: { kind: "every", everyMs: 120 * 60_000 },
                    payload: { model: "codex", thinking: "high" },
                    state: {
                        nextRunAtMs: 1,
                        runningAtMs: 2,
                        lastRunAtMs: 3,
                        lastStatus: "ok",
                        lastDurationMs: 4,
                    },
                    sessionTarget: "agent:main:main",
                },
                { id: "" },
            ],
        });

        try {
            const created = await requestJson<FrontendTask>(server, "/api/tasks", {
                method: "POST",
                body: {
                    title: `${titlePrefix}cron-list`,
                    assignee: TASK_ASSIGNEES.raymond.id,
                    labels: ["todo", "low"],
                    automation: {
                        cronJobId: "cron-enriched",
                        scheduleSummary: "Stored schedule",
                        sessionTarget: "stored-target",
                    },
                },
            });

            assert.equal(created.status, 201);

            const listed = await requestJson<FrontendTask[]>(server, "/api/tasks");
            const task = listed.body.find((item) => item.number === created.body.number);
            assert.ok(task);
            assert.deepEqual(task.automation, {
                type: "cron",
                recurring: true,
                cronJobId: "cron-enriched",
                jobName: "Backend coverage",
                enabled: true,
                schedule: { kind: "every", everyMs: 120 * 60_000 },
                scheduleSummary: "Every 2h",
                sessionTarget: "agent:main:main",
                model: "codex",
                thinking: "high",
                nextRunAtMs: 1,
                runningAtMs: 2,
                lastRunAtMs: 3,
                lastRunStatus: "ok",
                lastDurationMs: 4,
                source: "cron",
            });
        } finally {
            gateway.request = originalRequest;
        }
    });

    it("falls back for stored task and cron automation edge cases", async () => {
        const originalRequest = gateway.request;
        let response: unknown = {
            items: [
                {
                    id: "cron-items",
                    schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Oslo" },
                    state: { lastRunStatus: "failed" },
                },
                { jobId: "" },
            ],
        };
        gateway.request = async () => response;

        try {
            const cronCreated = await requestJson<FrontendTask>(server, "/api/tasks", {
                method: "POST",
                body: {
                    title: `${titlePrefix}cron-items`,
                    assignee: TASK_ASSIGNEES.raymond.id,
                    labels: ["todo"],
                    automation: {
                        cronJobId: "cron-items",
                        scheduleSummary: "Stored fallback",
                    },
                },
            });
            assert.equal(cronCreated.status, 201);

            const malformedCreated = await requestJson<FrontendTask>(
                server,
                "/api/tasks",
                {
                    method: "POST",
                    body: {
                        title: `${titlePrefix}malformed-json`,
                        assignee: TASK_ASSIGNEES.raymond.id,
                        labels: ["todo"],
                    },
                }
            );
            assert.equal(malformedCreated.status, 201);
            db.prepare(
                "UPDATE tasks SET labels_json = ?, automation_json = ? WHERE id = ?"
            ).run("not-json", "not-json", malformedCreated.body.number);

            const listed = await requestJson<FrontendTask[]>(server, "/api/tasks");
            const cronTask = listed.body.find(
                (item) => item.number === cronCreated.body.number
            );
            assert.equal(
                cronTask?.automation?.scheduleSummary,
                "0 8 * * * (Europe/Oslo)"
            );
            assert.equal(cronTask?.automation?.lastRunStatus, "failed");
            assert.equal(cronTask?.automation?.source, "cron");

            const malformedTask = listed.body.find(
                (item) => item.number === malformedCreated.body.number
            );
            assert.deepEqual(
                malformedTask?.labels.map((label) => label.name).sort(),
                ["priority-medium", "todo"].sort()
            );
            assert.equal(malformedTask?.automation, undefined);

            response = null;
            const withoutCron = await requestJson<FrontendTask>(
                server,
                `/api/tasks/${cronCreated.body.number}`
            );
            assert.equal(withoutCron.body.automation?.source, "stored");
            assert.equal(withoutCron.body.automation?.scheduleSummary, "Stored fallback");

            gateway.request = async () => {
                throw new Error("cron unavailable");
            };
            const afterCronFailure = await requestJson<FrontendTask>(
                server,
                `/api/tasks/${cronCreated.body.number}`
            );
            assert.equal(afterCronFailure.body.automation?.source, "stored");
        } finally {
            gateway.request = originalRequest;
        }
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

        const doneCreated = await requestJson<FrontendTask>(server, "/api/tasks", {
            method: "POST",
            body: {
                title: `${titlePrefix}done-at-create`,
                assignee: TASK_ASSIGNEES.raymond.id,
                labels: ["done"],
            },
        });
        assert.equal(doneCreated.status, 201);
        assert.equal(doneCreated.body.state, "CLOSED");

        const defaultCreated = await requestJson<FrontendTask>(server, "/api/tasks", {
            method: "POST",
            body: {
                title: `${titlePrefix}default-labels`,
                assignee: TASK_ASSIGNEES.raymond.id,
                automation: {},
            },
        });
        assert.equal(defaultCreated.status, 201);
        assert.deepEqual(
            defaultCreated.body.labels.map((label) => label.name).sort(),
            ["todo", "priority-medium"].sort()
        );
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

        const fetched = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}`
        );

        assert.equal(fetched.status, 200);
        assert.equal(fetched.body.number, created.body.number);
        assert.equal(fetched.body.title, `${titlePrefix}lifecycle`);
        assert.deepEqual(fetched.body.automation, created.body.automation);

        const invalidFetch = await requestJson<{ error: string }>(
            server,
            "/api/tasks/not-a-number"
        );

        assert.equal(invalidFetch.status, 400);
        assert.equal(invalidFetch.body.error, "Invalid id");

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

        const patchedInProgress = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}`,
            {
                method: "PATCH",
                body: { labels: ["in-progress", "priority-low"] },
            }
        );
        assert.equal(patchedInProgress.status, 200);
        assert.deepEqual(
            patchedInProgress.body.labels.map((label) => label.name).sort(),
            ["in-progress", "priority-low"].sort()
        );

        const patchedBlocked = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}`,
            {
                method: "PATCH",
                body: { labels: ["blocked", "priority-low"] },
            }
        );
        assert.equal(patchedBlocked.status, 200);
        assert.deepEqual(
            patchedBlocked.body.labels.map((label) => label.name).sort(),
            ["blocked", "priority-low"].sort()
        );

        const patchedTodo = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}`,
            {
                method: "PATCH",
                body: { labels: ["priority-low"] },
            }
        );
        assert.equal(patchedTodo.status, 200);
        assert.deepEqual(
            patchedTodo.body.labels.map((label) => label.name).sort(),
            ["priority-low", "todo"].sort()
        );

        const patchedWithoutLabels = await requestJson<FrontendTask>(
            server,
            `/api/tasks/${created.body.number}`,
            {
                method: "PATCH",
                body: { body: "Updated without label changes" },
            }
        );
        assert.equal(patchedWithoutLabels.status, 200);
        assert.deepEqual(
            patchedWithoutLabels.body.labels.map((label) => label.name).sort(),
            ["priority-low", "todo"].sort()
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
        db.prepare(
            "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)"
        ).run(created.body.number, created.body.number);

        const deleted = await requestJson<{ ok: true }>(
            server,
            `/api/tasks/${created.body.number}`,
            { method: "DELETE" }
        );

        assert.equal(deleted.status, 200);
        assert.deepEqual(deleted.body, { ok: true });
        assert.equal(
            (
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?"
                    )
                    .get(created.body.number, created.body.number) as { count: number }
            ).count,
            0
        );

        const missingFetch = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}`
        );
        assert.equal(missingFetch.status, 404);
        assert.equal(missingFetch.body.error, "Task not found");

        const missing = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}`,
            { method: "DELETE" }
        );
        assert.equal(missing.status, 404);
    });

    it("validates missing task mutations and notifies Mira assignments without failing", async () => {
        const originalSendSessionMessage = gateway.sendSessionMessage;
        const messages: string[] = [];
        gateway.sendSessionMessage = async (_sessionKey, message) => {
            messages.push(message);
            throw new Error("gateway offline");
        };

        try {
            const created = await requestJson<FrontendTask>(server, "/api/tasks", {
                method: "POST",
                body: {
                    title: `${titlePrefix}mira-notify`,
                    assignee: TASK_ASSIGNEES.mira.id,
                    labels: ["blocked", "high"],
                },
            });

            assert.equal(created.status, 201);
            assert.equal(created.body.assignees[0]?.login, TASK_ASSIGNEES.mira.id);

            const patchedMiraTask = await requestJson<FrontendTask>(
                server,
                `/api/tasks/${created.body.number}`,
                {
                    method: "PATCH",
                    body: {
                        title: `${titlePrefix}mira-notify-updated`,
                        labels: ["in-progress", "high"],
                    },
                }
            );
            assert.equal(patchedMiraTask.status, 200);
            assert.equal(patchedMiraTask.body.title, `${titlePrefix}mira-notify-updated`);

            const missingPatch = await requestJson<{ error: string }>(
                server,
                "/api/tasks/999999999",
                { method: "PATCH", body: { title: "Nope" } }
            );
            assert.equal(missingPatch.status, 404);

            const invalidPatch = await requestJson<{ error: string }>(
                server,
                "/api/tasks/not-a-number",
                { method: "PATCH", body: { title: "Nope" } }
            );
            assert.equal(invalidPatch.status, 400);

            const invalidAssign = await requestJson<{ error: string }>(
                server,
                `/api/tasks/${created.body.number}/assign`,
                { method: "POST", body: { assignee: "nobody" } }
            );
            assert.equal(invalidAssign.status, 400);

            const invalidAssignId = await requestJson<{ error: string }>(
                server,
                "/api/tasks/not-a-number/assign",
                { method: "POST", body: { assignee: TASK_ASSIGNEES.mira.id } }
            );
            assert.equal(invalidAssignId.status, 400);

            const missingAssign = await requestJson<{ error: string }>(
                server,
                "/api/tasks/999999999/assign",
                { method: "POST", body: { assignee: TASK_ASSIGNEES.mira.id } }
            );
            assert.equal(missingAssign.status, 404);

            const invalidMove = await requestJson<{ error: string }>(
                server,
                `/api/tasks/${created.body.number}/move`,
                { method: "POST", body: {} }
            );
            assert.equal(invalidMove.status, 400);

            const missingMove = await requestJson<{ error: string }>(
                server,
                "/api/tasks/999999999/move",
                { method: "POST", body: { columnLabel: "done" } }
            );
            assert.equal(missingMove.status, 404);

            const progress = await requestJson<TaskUpdate>(
                server,
                `/api/tasks/${created.body.number}/updates`,
                {
                    method: "POST",
                    body: {
                        author: TASK_ASSIGNEES.mira.id,
                        messageMd: "  Progress note  ",
                    },
                }
            );
            assert.equal(progress.status, 201);

            const reassigned = await requestJson<FrontendTask>(
                server,
                `/api/tasks/${created.body.number}/assign`,
                { method: "POST", body: { assignee: TASK_ASSIGNEES.mira.id } }
            );
            assert.equal(reassigned.status, 200);

            const deleted = await requestJson<{ ok: true }>(
                server,
                `/api/tasks/${created.body.number}`,
                { method: "DELETE" }
            );
            assert.equal(deleted.status, 200);

            const invalidDelete = await requestJson<{ error: string }>(
                server,
                "/api/tasks/not-a-number",
                { method: "DELETE" }
            );
            assert.equal(invalidDelete.status, 400);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
                messages.some((message) => message.includes("mira-notify")),
                true
            );
            assert.equal(
                messages.some((message) => message.includes("mira-notify-updated")),
                true
            );

            gateway.sendSessionMessage = async (_sessionKey, message) => {
                messages.push(`sent:${message}`);
            };
            const notified = await requestJson<FrontendTask>(server, "/api/tasks", {
                method: "POST",
                body: {
                    title: `${titlePrefix}mira-notify-success`,
                    assignee: TASK_ASSIGNEES.mira.id,
                    labels: ["todo"],
                },
            });
            assert.equal(notified.status, 201);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
                messages.some((message) => message.includes("sent:Task created")),
                true
            );
        } finally {
            gateway.sendSessionMessage = originalSendSessionMessage;
        }
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

        const invalidUpdateId = await requestJson<{ error: string }>(
            server,
            "/api/tasks/not-a-number/updates",
            {
                method: "POST",
                body: {
                    author: TASK_ASSIGNEES.raymond.id,
                    messageMd: "Invalid task id",
                },
            }
        );
        assert.equal(invalidUpdateId.status, 400);

        const invalidListUpdatesId = await requestJson<{ error: string }>(
            server,
            "/api/tasks/not-a-number/updates"
        );
        assert.equal(invalidListUpdatesId.status, 400);

        const missingTaskUpdate = await requestJson<{ error: string }>(
            server,
            "/api/tasks/999999999/updates",
            {
                method: "POST",
                body: {
                    author: TASK_ASSIGNEES.raymond.id,
                    messageMd: "Missing task",
                },
            }
        );
        assert.equal(missingTaskUpdate.status, 404);

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

        const invalidEdit = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}/updates/not-a-number`,
            {
                method: "PATCH",
                body: { author: TASK_ASSIGNEES.mira.id, messageMd: "Bad id" },
            }
        );
        assert.equal(invalidEdit.status, 400);

        const invalidDelete = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}/updates/not-a-number`,
            { method: "DELETE" }
        );
        assert.equal(invalidDelete.status, 400);

        const deleted = await requestJson<{ ok: true }>(
            server,
            `/api/tasks/${created.body.number}/updates/${update.body.id}`,
            { method: "DELETE" }
        );

        assert.equal(deleted.status, 200);
        assert.deepEqual(deleted.body, { ok: true });

        const missingUpdate = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}/updates/${update.body.id}`,
            {
                method: "PATCH",
                body: { author: TASK_ASSIGNEES.mira.id, messageMd: "Gone" },
            }
        );
        assert.equal(missingUpdate.status, 404);

        const missingDelete = await requestJson<{ error: string }>(
            server,
            `/api/tasks/${created.body.number}/updates/${update.body.id}`,
            { method: "DELETE" }
        );
        assert.equal(missingDelete.status, 404);
    });
});
