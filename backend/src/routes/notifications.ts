import express, { type RequestHandler } from "express";

import { db } from "../db.ts";
import { nullableString, objectFallback, stringFallback } from "../lib/values.ts";
import { pruneReadNotifications } from "../services/notificationMaintenance.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

/** Defines notification type. */
type NotificationType = "info" | "warning" | "error" | "success";

/** Represents one notification row. */
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

/** Performs list notifications. */
function listNotifications(limit: number): NotificationRow[] {
    const statement = db.prepare(`
        SELECT id, title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
        FROM notifications
        ORDER BY COALESCE(datetime(occurred_at), datetime(created_at)) DESC
        LIMIT ?
    `);

    return statement.all(limit) as unknown as NotificationRow[];
}

/** Performs to response. */
function toResponse(row: NotificationRow) {
    let metadata: Record<string, unknown> = {};
    try {
        const parsed = row.metadata_json ? JSON.parse(row.metadata_json) : {};
        metadata =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
    } catch {
        // Keep the default empty metadata for malformed historical rows.
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

/** Registers notifications API routes. */
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
        const readCount =
            (
                db
                    .prepare(
                        "SELECT COUNT(*) as count FROM notifications WHERE is_read = 1"
                    )
                    .get() as { count?: number }
            )?.count || 0;

        res.json({
            items: rows.map(toResponse),
            readCount,
            unreadCount,
        });
    }) as RequestHandler);

    app.post("/api/notifications", express.json(), ((req, res) => {
        const rawTitle = req.body?.title;
        if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
            res.status(400).json({ error: "title must be a string" });
            return;
        }
        const rawDescription = req.body?.description;
        if (
            rawDescription !== undefined &&
            rawDescription !== null &&
            typeof rawDescription !== "string"
        ) {
            res.status(400).json({ error: "description must be a string" });
            return;
        }
        const rawSource = req.body?.source;
        if (
            rawSource !== undefined &&
            rawSource !== null &&
            typeof rawSource !== "string"
        ) {
            res.status(400).json({ error: "source must be a string" });
            return;
        }
        const rawDedupeKey = req.body?.dedupeKey;
        if (
            rawDedupeKey !== undefined &&
            rawDedupeKey !== null &&
            typeof rawDedupeKey !== "string"
        ) {
            res.status(400).json({ error: "dedupeKey must be a string" });
            return;
        }
        const rawType = req.body?.type;
        if (rawType !== undefined && typeof rawType !== "string") {
            res.status(400).json({ error: "invalid notification type" });
            return;
        }
        const title = nullableString((rawTitle ?? "").trim());
        const description = stringFallback(rawDescription).trim();
        const source = nullableString((rawSource ?? "").trim());
        const dedupeKey = nullableString((rawDedupeKey ?? "").trim());
        const type = rawType === undefined ? "info" : rawType;
        const metadata =
            req.body?.metadata &&
            typeof req.body.metadata === "object" &&
            !Array.isArray(req.body.metadata)
                ? objectFallback(req.body.metadata)
                : {};
        const rawOccurredAt = req.body?.occurredAt;
        const occurredAt =
            rawOccurredAt === undefined ? dateToISOString(new Date()) : rawOccurredAt;
        if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
            res.status(400).json({ error: "invalid occurredAt" });
            return;
        }

        if (!title) {
            res.status(400).json({ error: "title is required" });
            return;
        }

        if (!["info", "warning", "error", "success"].includes(type)) {
            res.status(400).json({ error: "invalid notification type" });
            return;
        }

        const now = dateToISOString(new Date());

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
            RETURNING id
        `);

        const row = insert.get(
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
        const id = (row as null | undefined | { id?: unknown })?.id;
        if (typeof id !== "number") {
            console.error("[Notifications] Failed to create notification:", row);
            res.status(500).json({
                ok: false,
                error: "Failed to create notification",
            });
            return;
        }

        pruneReadNotifications();
        res.json({ ok: true, id });
    }) as RequestHandler);

    app.post("/api/notifications/mark-all-read", ((_, res) => {
        db.prepare(
            "UPDATE notifications SET is_read = 1, updated_at = ? WHERE is_read = 0"
        ).run(dateToISOString(new Date()));
        res.json({ ok: true });
    }) as RequestHandler);

    app.post("/api/notifications/clear-read", express.json(), ((req, res) => {
        const rawSource = req.body?.source ?? req.query.source;
        if (
            rawSource !== undefined &&
            rawSource !== null &&
            typeof rawSource !== "string"
        ) {
            res.status(400).json({ error: "source must be a string" });
            return;
        }
        const source = nullableString(stringFallback(rawSource).trim());
        const result = source
            ? db
                  .prepare("DELETE FROM notifications WHERE is_read = 1 AND source = ?")
                  .run(source)
            : db.prepare("DELETE FROM notifications WHERE is_read = 1").run();
        res.json({ ok: true, deleted: result.changes });
    }) as RequestHandler);

    app.post("/api/notifications/:id/read", ((req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            res.status(400).json({ error: "invalid id" });
            return;
        }

        db.prepare(
            "UPDATE notifications SET is_read = 1, updated_at = ? WHERE id = ?"
        ).run(dateToISOString(new Date()), id);

        res.json({ ok: true });
    }) as RequestHandler);

    app.delete("/api/notifications/:id", ((req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            res.status(400).json({ error: "invalid id" });
            return;
        }

        const result = db.prepare("DELETE FROM notifications WHERE id = ?").run(id);
        res.json({ ok: true, deleted: result.changes || 0 });
    }) as RequestHandler);
}
