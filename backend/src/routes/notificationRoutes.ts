import { database } from "../database.ts";
import { json, readJson, readRequestBytes } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { nullableString, objectFallback, stringFallback } from "../lib/values.ts";
import { pruneReadNotifications } from "../services/notificationMaintenance.ts";

type NotificationType = "error" | "info" | "success" | "warning";
type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

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

function nowIso(): string {
    return new Date().toISOString();
}

function listNotifications(limit: number): NotificationRow[] {
    return database
        .prepare(
            `SELECT id, title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
             FROM notifications
             ORDER BY COALESCE(datetime(occurred_at), datetime(created_at)) DESC
             LIMIT ?`
        )
        .all(limit) as NotificationRow[];
}

function toResponse(row: NotificationRow) {
    let metadata: Record<string, unknown>;
    try {
        const parsed = row.metadata_json ? JSON.parse(row.metadata_json) : {};
        metadata =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
    } catch {
        metadata = {};
    }
    return {
        createdAt: row.created_at,
        dedupeKey: row.dedupe_key,
        description: row.description,
        id: row.id,
        isRead: row.is_read === 1,
        metadata,
        occurredAt: row.occurred_at,
        source: row.source,
        title: row.title,
        type: row.type,
        updatedAt: row.updated_at,
    };
}

function optionalStringField(
    field: string,
    value: unknown
): { error?: Response; value?: string } {
    if (value === undefined || value === null) {
        return {};
    }
    return typeof value === "string"
        ? { value }
        : { error: json({ error: `${field} must be a string` }, { status: 400 }) };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: string | undefined): number | null {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const notificationRoutes = {
    "/api/notifications": {
        GET: (request: Request) => {
            const rawLimit = new URL(request.url).searchParams.get("limit");
            const limitValue = rawLimit === null ? null : Number(rawLimit);
            const limit =
                limitValue !== null && Number.isFinite(limitValue)
                    ? Math.max(1, Math.min(200, Math.floor(limitValue)))
                    : 100;
            const unreadCount =
                (
                    database
                        .prepare(
                            "SELECT COUNT(*) as count FROM notifications WHERE is_read = 0"
                        )
                        .get() as { count?: number }
                )?.count || 0;
            const readCount =
                (
                    database
                        .prepare(
                            "SELECT COUNT(*) as count FROM notifications WHERE is_read = 1"
                        )
                        .get() as { count?: number }
                )?.count || 0;
            return json({
                items: listNotifications(limit).map(toResponse),
                readCount,
                unreadCount,
            });
        },

        POST: async (request: Request) => {
            let body: Record<string, unknown>;
            try {
                body = await readJson<Record<string, unknown>>(request);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Invalid JSON") },
                    { status: httpStatusCode(error) }
                );
            }
            if (!isJsonObject(body)) {
                return json({ error: "Request body must be an object" }, { status: 400 });
            }
            const titleField = optionalStringField("title", body.title);
            if (titleField.error) return titleField.error;
            const descriptionField = optionalStringField("description", body.description);
            if (descriptionField.error) return descriptionField.error;
            const sourceField = optionalStringField("source", body.source);
            if (sourceField.error) return sourceField.error;
            const dedupeKeyField = optionalStringField("dedupeKey", body.dedupeKey);
            if (dedupeKeyField.error) return dedupeKeyField.error;
            const typeField = optionalStringField("type", body.type);
            if (typeField.error) {
                return json({ error: "invalid notification type" }, { status: 400 });
            }
            const title = nullableString((titleField.value ?? "").trim());
            const description = stringFallback(descriptionField.value).trim();
            const source = nullableString((sourceField.value ?? "").trim());
            const dedupeKey = nullableString((dedupeKeyField.value ?? "").trim());
            const type = typeField.value ?? "info";
            const metadata =
                body.metadata &&
                typeof body.metadata === "object" &&
                !Array.isArray(body.metadata)
                    ? objectFallback(body.metadata)
                    : {};
            const occurredAt = body.occurredAt === undefined ? nowIso() : body.occurredAt;
            if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
                return json({ error: "invalid occurredAt" }, { status: 400 });
            }
            if (!title) return json({ error: "title is required" }, { status: 400 });
            if (!["info", "warning", "error", "success"].includes(type)) {
                return json({ error: "invalid notification type" }, { status: 400 });
            }
            const now = nowIso();
            const row = database
                .prepare(
                    `INSERT INTO notifications (
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
                    RETURNING id`
                )
                .get(
                    title,
                    description,
                    type,
                    source,
                    dedupeKey,
                    JSON.stringify(metadata),
                    now,
                    now,
                    occurredAt
                ) as { id?: unknown } | null | undefined;
            if (typeof row?.id !== "number") {
                return json(
                    { error: "Failed to create notification", isOk: false },
                    { status: 500 }
                );
            }
            try {
                pruneReadNotifications();
            } catch (error) {
                console.error(
                    "[Notifications] Failed to prune read notifications:",
                    error
                );
            }
            return json({ id: row.id, isOk: true });
        },
    },

    "/api/notifications/mark-all-read": {
        POST: () => {
            database
                .prepare(
                    "UPDATE notifications SET is_read = 1, updated_at = ? WHERE is_read = 0"
                )
                .run(nowIso());
            return json({ isOk: true });
        },
    },

    "/api/notifications/clear-read": {
        POST: async (request: Request) => {
            const querySource = new URL(request.url).searchParams.get("source");
            let body: { source?: unknown };
            let rawBody: Buffer;
            try {
                rawBody = await readRequestBytes(request, 1024);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Invalid JSON") },
                    { status: httpStatusCode(error) }
                );
            }
            if (rawBody.length === 0) {
                body = {};
            } else {
                try {
                    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
                    if (!isJsonObject(parsed)) {
                        return json(
                            { error: "Request body must be an object" },
                            { status: 400 }
                        );
                    }
                    body = parsed;
                } catch {
                    return json({ error: "Invalid JSON" }, { status: 400 });
                }
            }
            const rawSource = body.source ?? querySource;
            if (
                rawSource !== undefined &&
                rawSource !== null &&
                typeof rawSource !== "string"
            ) {
                return json({ error: "source must be a string" }, { status: 400 });
            }
            const source = nullableString(stringFallback(rawSource).trim());
            const result = source
                ? database
                      .prepare(
                          "DELETE FROM notifications WHERE is_read = 1 AND source = ?"
                      )
                      .run(source)
                : database.prepare("DELETE FROM notifications WHERE is_read = 1").run();
            return json({ deleted: result.changes, isOk: true });
        },
    },

    "/api/notifications/:id/read": {
        POST: (request: ParametersRequest<"id">) => {
            const id = validId(request.params.id);
            if (id === null) return json({ error: "invalid id" }, { status: 400 });
            database
                .prepare(
                    "UPDATE notifications SET is_read = 1, updated_at = ? WHERE id = ?"
                )
                .run(nowIso(), id);
            return json({ isOk: true });
        },
    },

    "/api/notifications/:id": {
        DELETE: (request: ParametersRequest<"id">) => {
            const id = validId(request.params.id);
            if (id === null) return json({ error: "invalid id" }, { status: 400 });
            const result = database
                .prepare("DELETE FROM notifications WHERE id = ?")
                .run(id);
            return json({ deleted: result.changes || 0, isOk: true });
        },
    },
} as const;
