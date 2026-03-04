import express, { type RequestHandler } from "express";

import {
    TASK_ASSIGNEE_IDS,
    TASK_ASSIGNEES,
    type TaskAssigneeId,
} from "../constants/taskActors.js";
import { db } from "../db.js";

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
    assignee: Assignee | null;
    created_at: string;
    updated_at: string;
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

function toFrontendTask(task: DbTask) {
    const labels = labelsFromTask(task);
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
    };
}

async function notifyMira(eventType: string, task: { id: number; title: string }) {
    const message = `Task ${eventType}: #${task.id} ${task.title}. Reminder: this is a new/updated task assigned to Mira.`;

    // NOTE: OpenClaw gateway WS does not currently expose a stable session-send RPC
    // method in this backend path. Keep event logged and use app-side polling until
    // we wire a dedicated notifier endpoint.
    console.info("[Tasks] Notify pending integration:", message);
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
    app.get("/api/tasks", (_req, res) => {
        const rows = db
            .prepare(
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
                 FROM tasks
                 ORDER BY datetime(updated_at) DESC, id DESC`
            )
            .all() as unknown as DbTask[];

        res.json(rows.map(toFrontendTask));
    });

    app.post("/api/tasks", express.json(), (async (req, res) => {
        const { title, body, labels, assignee } = req.body as {
            title?: string;
            body?: string;
            labels?: string[];
            assignee?: Assignee;
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
                `INSERT INTO tasks (title, body, status, priority, labels_json, assignee, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                title.trim(),
                body || "",
                status,
                priority,
                JSON.stringify(labelList),
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
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
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
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
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
        const updatedAt = new Date().toISOString();

        db.prepare(
            `UPDATE tasks
             SET title = ?, body = ?, status = ?, priority = ?, labels_json = ?, updated_at = ?
             WHERE id = ?`
        ).run(
            title,
            body,
            nextStatus,
            nextPriority,
            JSON.stringify(labels),
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
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
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
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
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
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
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
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
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
                `SELECT id, title, body, status, priority, labels_json, assignee, created_at, updated_at
                 FROM tasks WHERE id = ?`
            )
            .get(id) as unknown as DbTask;

        res.json(toFrontendTask(row));
    }) as RequestHandler);
}
