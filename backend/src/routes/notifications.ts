import express, { type RequestHandler } from "express";

import { db } from "../db.js";
import { pruneReadNotifications } from "../services/notificationMaintenance.js";

type NotificationType = "info" | "warning" | "error" | "success";

interface NotificationRow {
    id: number;
    title: string;
    description: string;
    type: NotificationType;
    source: string | null;
    dedupe_key: string | null;
    metadata_json: string;
    is_read: number;
    created_at: string;
    updated_at: string;
    occurred_at: string;
}

function listNotifications(limit: number): NotificationRow[] {
    const statement = db.prepare(`
        SELECT id, title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
        FROM notifications
        ORDER BY datetime(occurred_at) DESC
        LIMIT ?
    `);

    return statement.all(limit) as unknown as NotificationRow[];
}

function toResponse(row: NotificationRow) {
    let metadata: Record<string, unknown> = {};
    try {
        metadata = row.metadata_json
            ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
            : {};
    } catch {
        metadata = {};
    }

    return {
        id: row.id,
        title: row.title,
        description: row.description,
        type: row.type,
        source: row.source,
        dedupeKey: row.dedupe_key,
        metadata,
        isRead: row.is_read === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        occurredAt: row.occurred_at,
    };
}

export default function notificationsRoutes(app: express.Application): void {
    app.get("/api/notifications", ((req, res) => {
        const limitValue = Number(req.query.limit);
        const limit = Number.isFinite(limitValue)
            ? Math.max(1, Math.min(200, Math.floor(limitValue)))
            : 100;

        const rows = listNotifications(limit);
        const unreadCount =
            (
                db
                    .prepare(
                        "SELECT COUNT(*) as count FROM notifications WHERE is_read = 0"
                    )
                    .get() as { count?: number }
            )?.count || 0;

        res.json({
            items: rows.map(toResponse),
            unreadCount,
        });
    }) as RequestHandler);

    app.post("/api/notifications", express.json(), ((req, res) => {
        const title = (req.body?.title || "").toString().trim();
        const description = (req.body?.description || "").toString().trim();
        const type = (req.body?.type || "info").toString() as NotificationType;
        const source = req.body?.source ? String(req.body.source) : null;
        const dedupeKey = req.body?.dedupeKey ? String(req.body.dedupeKey) : null;
        const metadata =
            req.body?.metadata && typeof req.body.metadata === "object"
                ? req.body.metadata
                : {};
        const occurredAt = req.body?.occurredAt
            ? String(req.body.occurredAt)
            : new Date().toISOString();

        if (!title) {
            res.status(400).json({ error: "title is required" });
            return;
        }

        if (!description) {
            res.status(400).json({ error: "description is required" });
            return;
        }

        if (!["info", "warning", "error", "success"].includes(type)) {
            res.status(400).json({ error: "invalid notification type" });
            return;
        }

        const now = new Date().toISOString();

        const insert = db.prepare(`
            INSERT INTO notifications (
                title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                type = excluded.type,
                source = excluded.source,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at,
                occurred_at = excluded.occurred_at
        `);

        const result = insert.run(
            title,
            description,
            type,
            source,
            dedupeKey,
            JSON.stringify(metadata),
            now,
            now,
            occurredAt
        );

        pruneReadNotifications();
        res.json({ ok: true, id: result.lastInsertRowid ?? null });
    }) as RequestHandler);

    app.post("/api/notifications/mark-all-read", ((_, res) => {
        db.prepare(
            "UPDATE notifications SET is_read = 1, updated_at = ? WHERE is_read = 0"
        ).run(new Date().toISOString());
        res.json({ ok: true });
    }) as RequestHandler);

    app.post("/api/notifications/clear-read", ((_, res) => {
        const result = db.prepare("DELETE FROM notifications WHERE is_read = 1").run();
        res.json({ ok: true, deleted: result.changes ?? 0 });
    }) as RequestHandler);

    app.post("/api/notifications/:id/read", ((req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            res.status(400).json({ error: "invalid id" });
            return;
        }

        db.prepare(
            "UPDATE notifications SET is_read = 1, updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), id);

        res.json({ ok: true });
    }) as RequestHandler);

    app.delete("/api/notifications/:id", ((req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            res.status(400).json({ error: "invalid id" });
            return;
        }

        const result = db.prepare("DELETE FROM notifications WHERE id = ?").run(id);
        res.json({ ok: true, deleted: result.changes ?? 0 });
    }) as RequestHandler);
}
