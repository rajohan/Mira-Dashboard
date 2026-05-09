import express, { type RequestHandler } from "express";

import {
    TASK_ASSIGNEE_IDS,
    TASK_ASSIGNEES,
    type TaskAssigneeId,
} from "../constants/taskActors.js";
import { db } from "../db.js";
import gateway from "../gateway.js";

type Status = "todo" | "in-progress" | "blocked" | "done";

type Assignee = TaskAssigneeId;

interface DbTaskUpdate {
    id: number;
    task_id: number;
    author: Assignee;
    message_md: string;
    created_at: string;
}

interface DbTask {
    id: number;
    title: string;
    body: string;
    status: Status;
    priority: "low" | "medium" | "high";
    labels_json: string;
    automation_json: string;
    assignee: Assignee | null;
    created_at: string;
    updated_at: string;
}

interface CronJob {
    id?: string;
    jobId?: string;
    name?: string;
    enabled?: boolean;
    schedule?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    state?: Record<string, unknown>;
    sessionTarget?: string;
    [key: string]: unknown;
}

interface CronListResponse {
    jobs?: CronJob[];
    items?: CronJob[];
}

interface TaskAutomationInput {
    type?: string;
    recurring?: boolean;
    cronJobId?: string;
    scheduleSummary?: string;
    sessionTarget?: string;
    model?: string;
    thinking?: string;
    [key: string]: unknown;
}

function isValidAssignee(value: unknown): value is Assignee {
    return typeof value === "string" && TASK_ASSIGNEE_IDS.includes(value as Assignee);
}

function normalizeStatus(columnLabel?: string): Status {
    if (columnLabel === "done") return "done";
    if (columnLabel === "blocked") return "blocked";
    if (columnLabel === "in-progress") return "in-progress";
    return "todo";
}

function derivePriority(labels: string[]): "low" | "medium" | "high" {
    if (labels.includes("priority-high") || labels.includes("high")) return "high";
    if (labels.includes("priority-low") || labels.includes("low")) return "low";
    return "medium";
}

function labelsFromTask(task: DbTask): string[] {
    const base = (() => {
        try {
            const parsed = JSON.parse(task.labels_json) as unknown;
            return Array.isArray(parsed)
                ? parsed.filter((v): v is string => typeof v === "string")
                : [];
        } catch {
            return [];
        }
    })();

    const statusLabel = task.status === "done" ? "done" : task.status;
    if (!base.includes(statusLabel)) {
        base.push(statusLabel);
    }

    const priorityLabel = `priority-${task.priority}`;
    if (!base.includes(priorityLabel)) {
        base.push(priorityLabel);
    }

    return base;
}

function parseRecordJson(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function normalizeAutomationInput(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return "{}";
    }

    const input = value as TaskAutomationInput;
    const cronJobId = typeof input.cronJobId === "string" ? input.cronJobId.trim() : "";
    if (!cronJobId) {
        return "{}";
    }

    const automation: TaskAutomationInput = {
        type: "cron",
        recurring: input.recurring ?? true,
        cronJobId,
    };

    for (const key of ["scheduleSummary", "sessionTarget", "model", "thinking"]) {
        const keyValue = input[key];
        if (typeof keyValue === "string" && keyValue.trim()) {
            automation[key] = keyValue.trim();
        }
    }

    return JSON.stringify(automation);
}

function getCronJobId(job: CronJob): string {
    return String(job.jobId || job.id || "");
}

function normalizeCronJobs(payload: unknown): CronJob[] {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    const value = payload as CronListResponse;
    if (Array.isArray(value.jobs)) {
        return value.jobs;
    }

    if (Array.isArray(value.items)) {
        return value.items;
    }

    return [];
}

async function fetchCronJobsById(): Promise<Map<string, CronJob>> {
    try {
        const payload = await gateway.request("cron.list", { includeDisabled: true });
        return new Map(
            normalizeCronJobs(payload)
                .map((job) => [getCronJobId(job), job] as const)
                .filter(([id]) => id.length > 0)
        );
    } catch (error) {
        console.warn("[Tasks] Failed to load cron jobs for task automation:", error);
        return new Map();
    }
}

function numberFromRecord(record: Record<string, unknown> | undefined, key: string) {
    const value = record?.[key];
    return typeof value === "number" ? value : undefined;
}

function stringFromRecord(record: Record<string, unknown> | undefined, key: string) {
    const value = record?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatScheduleSummary(schedule: Record<string, unknown> | undefined) {
    if (!schedule) {
        return;
    }

    if (schedule.kind === "cron") {
        const expr = stringFromRecord(schedule, "expr");
        const tz = stringFromRecord(schedule, "tz");
        if (expr && tz) return `${expr} (${tz})`;
        return expr;
    }

    if (schedule.kind === "every") {
        const everyMs = numberFromRecord(schedule, "everyMs");
        if (everyMs) {
            const minutes = Math.round(everyMs / 60_000);
            if (minutes >= 60 && minutes % 60 === 0) return `Every ${minutes / 60}h`;
            return `Every ${minutes}m`;
        }
    }

    if (schedule.kind === "at") {
        return stringFromRecord(schedule, "at");
    }

    return String(schedule.kind || "Scheduled");
}

function toFrontendAutomation(task: DbTask, cronJobsById?: Map<string, CronJob>) {
    const stored = parseRecordJson(task.automation_json);
    const cronJobId = stringFromRecord(stored, "cronJobId");
    if (!cronJobId) {
        return;
    }

    const job = cronJobsById?.get(cronJobId);
    const schedule =
        job?.schedule || (stored.schedule as Record<string, unknown> | undefined);
    const payload = job?.payload;
    const state = job?.state;
    const lastRunStatus =
        stringFromRecord(state, "lastRunStatus") || stringFromRecord(state, "lastStatus");

    return {
        type: "cron",
        recurring: true,
        cronJobId,
        jobName: job?.name || stringFromRecord(stored, "jobName"),
        enabled: job?.enabled,
        schedule,
        scheduleSummary:
            formatScheduleSummary(schedule) ||
            stringFromRecord(stored, "scheduleSummary"),
        sessionTarget: job?.sessionTarget || stringFromRecord(stored, "sessionTarget"),
        model: stringFromRecord(payload, "model") || stringFromRecord(stored, "model"),
        thinking:
            stringFromRecord(payload, "thinking") || stringFromRecord(stored, "thinking"),
        nextRunAtMs: numberFromRecord(state, "nextRunAtMs"),
        runningAtMs: numberFromRecord(state, "runningAtMs"),
        lastRunAtMs: numberFromRecord(state, "lastRunAtMs"),
        lastRunStatus,
        lastDurationMs: numberFromRecord(state, "lastDurationMs"),
        source: job ? "cron" : "stored",
    };
}

function toFrontendTask(task: DbTask, cronJobsById?: Map<string, CronJob>) {
    const labels = labelsFromTask(task);
    const automation = toFrontendAutomation(task, cronJobsById);
    return {
        number: task.id,
        title: task.title,
        body: task.body,
        state: task.status === "done" ? "CLOSED" : "OPEN",
        labels: labels.map((name) => ({ name })),
        assignees: task.assignee
            ? [
                  {
                      login: task.assignee,
                      name: task.assignee,
                  },
              ]
            : [],
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        url: `/tasks/${task.id}`,
        automation,
    };
}

async function notifyMira(eventType: string, task: { id: number; title: string }) {
    const message = `Task ${eventType}: #${task.id} ${task.title}. Reminder: this is a new/updated task assigned to Mira.`;

    try {
        await gateway.sendSessionMessage("main", message);
    } catch (error) {
        console.error("[Tasks] Failed to notify Mira:", error);
    }
}

function toFrontendTaskUpdate(update: DbTaskUpdate) {
    return {
        id: update.id,
        taskId: update.task_id,
        author: update.author,
        messageMd: update.message_md,
        createdAt: update.created_at,
    };
}

function recordEvent(taskId: number, eventType: string, payload: unknown) {
    db.prepare(
        `INSERT INTO task_events (task_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?)`
    ).run(taskId, eventType, JSON.stringify(payload || {}), new Date().toISOString());
}

export default function tasksRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.get("/api/tasks", (async (_req, res) => {
        const rows = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks
                 ORDER BY datetime(updated_at) DESC, id DESC`
            )
            .all() as unknown as DbTask[];

        const cronJobsById = await fetchCronJobsById();
        res.json(rows.map((task) => toFrontendTask(task, cronJobsById)));
    }) as RequestHandler);

    app.post("/api/tasks", express.json(), (async (req, res) => {
        const { title, body, labels, assignee, automation } = req.body as {
            title?: string;
            body?: string;
            labels?: string[];
            assignee?: Assignee;
            automation?: TaskAutomationInput;
        };

        if (!title || !title.trim()) {
            res.status(400).json({ error: "Title is required" });
            return;
        }

        if (!isValidAssignee(assignee)) {
            res.status(400).json({ error: "Assignee must be Mira or Raymond" });
            return;
        }

        const now = new Date().toISOString();
        const labelList = Array.isArray(labels) ? labels : [];
        const safeAssignee = assignee;
        const status = normalizeStatus(
            labelList.includes("done")
                ? "done"
                : labelList.includes("blocked")
                  ? "blocked"
                  : labelList.includes("in-progress")
                    ? "in-progress"
                    : "todo"
        );
        const priority = derivePriority(labelList);

        const result = db
            .prepare(
                `INSERT INTO tasks (title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                title.trim(),
                body || "",
                status,
                priority,
                JSON.stringify(labelList),
                normalizeAutomationInput(automation),
                safeAssignee,
                now,
                now
            );

        const id = Number(result.lastInsertRowid);
        recordEvent(id, "created", {
            title: title.trim(),
            status,
            priority,
            assignee: safeAssignee,
        });
        if (safeAssignee === TASK_ASSIGNEES.mira.id) {
            void notifyMira("created", { id, title: title.trim() });
        }

        const row = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask;

        res.status(201).json(toFrontendTask(row));
    }) as RequestHandler);

    app.patch("/api/tasks/:id", express.json(), (async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) {
            res.status(400).json({ error: "Invalid id" });
            return;
        }

        const existing = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask | undefined;

        if (!existing) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        const updates = req.body as {
            title?: string;
            body?: string;
            labels?: string[];
            automation?: TaskAutomationInput | null;
        };

        const labels = updates.labels ?? labelsFromTask(existing);
        const nextStatus = normalizeStatus(
            labels.includes("done")
                ? "done"
                : labels.includes("blocked")
                  ? "blocked"
                  : labels.includes("in-progress")
                    ? "in-progress"
                    : "todo"
        );
        const nextPriority = derivePriority(labels);

        const title = updates.title?.trim() || existing.title;
        const body = updates.body ?? existing.body;
        const automationJson =
            updates.automation === undefined
                ? existing.automation_json
                : normalizeAutomationInput(updates.automation);
        const updatedAt = new Date().toISOString();

        db.prepare(
            `UPDATE tasks
             SET title = ?, body = ?, status = ?, priority = ?, labels_json = ?, automation_json = ?, updated_at = ?
             WHERE id = ?`
        ).run(
            title,
            body,
            nextStatus,
            nextPriority,
            JSON.stringify(labels),
            automationJson,
            updatedAt,
            id
        );

        recordEvent(id, "updated", {
            title,
            status: nextStatus,
            priority: nextPriority,
            assignee: existing.assignee,
        });
        if (existing.assignee === TASK_ASSIGNEES.mira.id) {
            void notifyMira("updated", { id, title });
        }

        const row = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask;

        res.json(toFrontendTask(row));
    }) as RequestHandler);

    app.post("/api/tasks/:id/assign", express.json(), (async (req, res) => {
        const id = Number(req.params.id);
        const { assignee } = req.body as { assignee?: string | null };

        if (!Number.isInteger(id)) {
            res.status(400).json({ error: "Invalid request" });
            return;
        }

        if (!isValidAssignee(assignee)) {
            res.status(400).json({ error: "Assignee must be Mira or Raymond" });
            return;
        }

        const existing = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask | undefined;

        if (!existing) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        const safeAssignee = assignee;
        const updatedAt = new Date().toISOString();
        db.prepare(`UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?`).run(
            safeAssignee,
            updatedAt,
            id
        );

        recordEvent(id, "assigned", { assignee: safeAssignee });
        if (safeAssignee === TASK_ASSIGNEES.mira.id) {
            void notifyMira("assigned", { id, title: existing.title });
        }

        const row = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask;

        res.json(toFrontendTask(row));
    }) as RequestHandler);

    app.delete("/api/tasks/:id", (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) {
            res.status(400).json({ error: "Invalid id" });
            return;
        }

        const existing = db
            .prepare("SELECT id, title, assignee FROM tasks WHERE id = ?")
            .get(id) as unknown as
            | { id: number; title: string; assignee?: string }
            | undefined;

        if (!existing) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        db.prepare("DELETE FROM task_updates WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
        if (existing.assignee === TASK_ASSIGNEES.mira.id) {
            void notifyMira("deleted", existing);
        }
        res.json({ ok: true });
    });

    app.get("/api/tasks/:id/updates", (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) {
            res.status(400).json({ error: "Invalid id" });
            return;
        }

        const rows = db
            .prepare(
                `SELECT id, task_id, author, message_md, created_at
                 FROM task_updates
                 WHERE task_id = ?
                 ORDER BY datetime(created_at) DESC, id DESC`
            )
            .all(id) as unknown as DbTaskUpdate[];

        res.json(rows.map(toFrontendTaskUpdate));
    });

    app.post("/api/tasks/:id/updates", express.json(), (req, res) => {
        const id = Number(req.params.id);
        const { author, messageMd } = req.body as {
            author?: Assignee;
            messageMd?: string;
        };

        if (!Number.isInteger(id) || !isValidAssignee(author) || !messageMd?.trim()) {
            res.status(400).json({ error: "Invalid update payload" });
            return;
        }

        const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
        if (!existing) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        const createdAt = new Date().toISOString();
        const result = db
            .prepare(
                `INSERT INTO task_updates (task_id, author, message_md, created_at)
                 VALUES (?, ?, ?, ?)`
            )
            .run(id, author, messageMd.trim(), createdAt);

        db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(createdAt, id);

        const row = db
            .prepare(
                `SELECT id, task_id, author, message_md, created_at
                 FROM task_updates
                 WHERE id = ?`
            )
            .get(Number(result.lastInsertRowid)) as unknown as DbTaskUpdate;

        const taskRow = db
            .prepare("SELECT title, assignee FROM tasks WHERE id = ?")
            .get(id) as unknown as { title: string; assignee: Assignee | null };

        if (taskRow.assignee === TASK_ASSIGNEES.mira.id) {
            void notifyMira("progress", { id, title: taskRow.title });
        }

        res.status(201).json(toFrontendTaskUpdate(row));
    });

    app.patch("/api/tasks/:id/updates/:updateId", express.json(), (req, res) => {
        const id = Number(req.params.id);
        const updateId = Number(req.params.updateId);
        const { author, messageMd } = req.body as {
            author?: Assignee;
            messageMd?: string;
        };

        if (
            !Number.isInteger(id) ||
            !Number.isInteger(updateId) ||
            !isValidAssignee(author) ||
            !messageMd?.trim()
        ) {
            res.status(400).json({ error: "Invalid update payload" });
            return;
        }

        const existing = db
            .prepare("SELECT id FROM task_updates WHERE id = ? AND task_id = ?")
            .get(updateId, id);

        if (!existing) {
            res.status(404).json({ error: "Update not found" });
            return;
        }

        const updatedAt = new Date().toISOString();
        db.prepare(
            `UPDATE task_updates
             SET author = ?, message_md = ?
             WHERE id = ? AND task_id = ?`
        ).run(author, messageMd.trim(), updateId, id);
        db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(updatedAt, id);

        const row = db
            .prepare(
                `SELECT id, task_id, author, message_md, created_at
                 FROM task_updates
                 WHERE id = ?`
            )
            .get(updateId) as unknown as DbTaskUpdate;

        res.json(toFrontendTaskUpdate(row));
    });

    app.delete("/api/tasks/:id/updates/:updateId", (req, res) => {
        const id = Number(req.params.id);
        const updateId = Number(req.params.updateId);
        if (!Number.isInteger(id) || !Number.isInteger(updateId)) {
            res.status(400).json({ error: "Invalid id" });
            return;
        }

        const existing = db
            .prepare("SELECT id FROM task_updates WHERE id = ? AND task_id = ?")
            .get(updateId, id);
        if (!existing) {
            res.status(404).json({ error: "Update not found" });
            return;
        }

        db.prepare("DELETE FROM task_updates WHERE id = ? AND task_id = ?").run(
            updateId,
            id
        );
        db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            id
        );

        res.json({ ok: true });
    });

    app.post("/api/tasks/:id/move", express.json(), (async (req, res) => {
        const id = Number(req.params.id);
        const { columnLabel } = req.body as { columnLabel?: string };

        if (!Number.isInteger(id) || !columnLabel) {
            res.status(400).json({ error: "Invalid request" });
            return;
        }

        const existing = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask | undefined;

        if (!existing) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        const status = normalizeStatus(columnLabel);
        const labels = [
            ...labelsFromTask(existing).filter(
                (label) => !["todo", "in-progress", "blocked", "done"].includes(label)
            ),
            status,
        ];

        const updatedAt = new Date().toISOString();

        db.prepare(
            `UPDATE tasks
             SET status = ?, labels_json = ?, updated_at = ?
             WHERE id = ?`
        ).run(status, JSON.stringify(labels), updatedAt, id);

        recordEvent(id, "moved", { status });

        const row = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask;

        res.json(toFrontendTask(row));
    }) as RequestHandler);
}
