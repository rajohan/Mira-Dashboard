import crypto from "node:crypto";
import express, { type RequestHandler } from "express";

import { db } from "../db.js";
import gateway from "../gateway.js";

type Status = "todo" | "in-progress" | "blocked" | "done";

interface DbTask {
    id: number;
    title: string;
    body: string;
    status: Status;
    priority: "low" | "medium" | "high";
    labels_json: string;
    assignee: string | null;
    created_at: string;
    updated_at: string;
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

function notifyMira(eventType: string, task: { id: number; title: string }) {
    const ws = gateway.getGatewayWs();
    if (!ws || ws.readyState !== 1) {
        return;
    }

    const id = `tasks-notify-${crypto.randomUUID()}`;
    const message = `Task ${eventType}: #${task.id} ${task.title}. Reminder: this is a new/updated task that may need pickup.`;

    ws.send(
        JSON.stringify({
            type: "req",
            id,
            method: "sessions.send",
            params: {
                sessionKey: "agent:main:main",
                message,
            },
        })
    );
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
        const { title, body, labels } = req.body as {
            title?: string;
            body?: string;
            labels?: string[];
        };

        if (!title || !title.trim()) {
            res.status(400).json({ error: "Title is required" });
            return;
        }

        const now = new Date().toISOString();
        const labelList = Array.isArray(labels) ? labels : [];
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
                 VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
            )
            .run(
                title.trim(),
                body || "",
                status,
                priority,
                JSON.stringify(labelList),
                now,
                now
            );

        const id = Number(result.lastInsertRowid);
        recordEvent(id, "created", { title: title.trim(), status, priority });
        notifyMira("created", { id, title: title.trim() });

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
        ).run(title, body, nextStatus, nextPriority, JSON.stringify(labels), updatedAt, id);

        recordEvent(id, "updated", { title, status: nextStatus, priority: nextPriority });
        notifyMira("updated", { id, title });

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

        const updatedAt = new Date().toISOString();
        db.prepare(`UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?`).run(
            assignee || null,
            updatedAt,
            id
        );

        recordEvent(id, "assigned", { assignee: assignee || null });
        notifyMira("assigned", { id, title: existing.title });

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
            .prepare("SELECT id, title FROM tasks WHERE id = ?")
            .get(id) as unknown as { id: number; title: string } | undefined;

        if (!existing) {
            res.status(404).json({ error: "Task not found" });
            return;
        }

        db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
        notifyMira("deleted", existing);
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
        const labels = labelsFromTask(existing)
            .filter((label) => !["todo", "in-progress", "blocked", "done"].includes(label))
            .concat([status]);

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
