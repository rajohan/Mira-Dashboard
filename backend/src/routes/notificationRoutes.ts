import {
    type NotificationItem,
    type NotificationType,
    parseClearReadNotificationsRequest,
    parseCreateNotificationInput,
} from "../../../contracts/notifications.ts";
import { isPlainRecord } from "../../../contracts/runtime.ts";
import { database, sqlNullable } from "../database/connection.ts";
import { json } from "../http/core.ts";
import {
    type ParametersRequest,
    readApiJson,
    readApiJsonOrError,
    routeErrorResponse,
    routeFailureResponse,
} from "../http/routeSupport.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { pruneReadNotifications } from "../services/notificationMaintenance.ts";

const logger = createStructuredLogger("notifications");

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

function toResponse(row: NotificationRow): NotificationItem {
    let metadata: Record<string, unknown>;
    try {
        const parsed: unknown = row.metadata_json ? JSON.parse(row.metadata_json) : {};
        metadata = isPlainRecord(parsed) ? parsed : {};
    } catch {
        metadata = {};
    }
    return {
        createdAt: row.created_at,
        dedupeKey: row.dedupe_key ?? undefined,
        description: row.description,
        id: row.id,
        isRead: row.is_read === 1,
        metadata,
        occurredAt: row.occurred_at,
        source: row.source ?? undefined,
        title: row.title,
        type: row.type,
        updatedAt: row.updated_at,
    };
}

function validId(value: string | undefined): number | undefined {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function notificationRouteError(error: unknown, fallback: string): Response {
    return routeErrorResponse(undefined, error, {
        code: "notification_request_failed",
        context: "notification",
        message: fallback,
    });
}

export const notificationRoutes = {
    "/api/notifications": {
        GET: (request: Request) => {
            try {
                const rawLimit = new URL(request.url).searchParams.get("limit");
                const limitValue = rawLimit === null ? undefined : Number(rawLimit);
                const limit =
                    limitValue !== undefined && Number.isFinite(limitValue)
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
                    items: listNotifications(limit).map((item) => toResponse(item)),
                    readCount,
                    unreadCount,
                });
            } catch (error) {
                return notificationRouteError(error, "Failed to list notifications");
            }
        },

        POST: async (request: Request) => {
            let body;
            try {
                body = await readApiJson(request, parseCreateNotificationInput);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "invalid_notification_request",
                    context: "notification.create",
                    message: "Invalid notification request",
                });
            }
            const {
                dedupeKey,
                description = "",
                metadata = {},
                occurredAt = nowIso(),
                source,
                title,
                type = "info",
            } = body;
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
                    sqlNullable(source),
                    sqlNullable(dedupeKey),
                    JSON.stringify(metadata),
                    now,
                    now,
                    occurredAt
                ) as { id?: unknown } | undefined;
            if (typeof row?.id !== "number") {
                return routeFailureResponse({
                    context: "notification",
                    message: "Failed to create notification",
                    status: 500,
                });
            }
            try {
                pruneReadNotifications();
            } catch (error) {
                logger.error("notifications.prune_read_failed", { error });
            }
            return json({ id: row.id, isOk: true });
        },
    },

    "/api/notifications/mark-all-read": {
        POST: () => {
            try {
                database
                    .prepare(
                        "UPDATE notifications SET is_read = 1, updated_at = ? WHERE is_read = 0"
                    )
                    .run(nowIso());
                return json({ isOk: true });
            } catch (error) {
                return notificationRouteError(error, "Failed to mark notifications read");
            }
        },
    },

    "/api/notifications/clear-read": {
        POST: async (request: Request) => {
            const body = await readApiJsonOrError(
                request,
                parseClearReadNotificationsRequest,
                {
                    code: "invalid_notification_request",
                    context: "notification.clear-read",
                    message: "Invalid notification request",
                    maxBytes: 1024,
                }
            );
            if (body instanceof Response) return body;

            const source = body.source;
            try {
                const result = source
                    ? database
                          .prepare(
                              "DELETE FROM notifications WHERE is_read = 1 AND source = ?"
                          )
                          .run(source)
                    : database
                          .prepare("DELETE FROM notifications WHERE is_read = 1")
                          .run();
                return json({ deleted: result.changes, isOk: true });
            } catch (error) {
                return notificationRouteError(error, "Failed to clear notifications");
            }
        },
    },

    "/api/notifications/:id/read": {
        POST: (request: ParametersRequest<"id">) => {
            try {
                const id = validId(request.params.id);
                if (id === undefined)
                    return routeFailureResponse({
                        context: "notification",
                        message: "invalid id",
                        status: 400,
                    });
                database
                    .prepare(
                        "UPDATE notifications SET is_read = 1, updated_at = ? WHERE id = ?"
                    )
                    .run(nowIso(), id);
                return json({ isOk: true });
            } catch (error) {
                return notificationRouteError(error, "Failed to mark notification read");
            }
        },
    },

    "/api/notifications/:id": {
        DELETE: (request: ParametersRequest<"id">) => {
            try {
                const id = validId(request.params.id);
                if (id === undefined)
                    return routeFailureResponse({
                        context: "notification",
                        message: "invalid id",
                        status: 400,
                    });
                const result = database
                    .prepare("DELETE FROM notifications WHERE id = ?")
                    .run(id);
                return json({ deleted: result.changes || 0, isOk: true });
            } catch (error) {
                return notificationRouteError(error, "Failed to delete notification");
            }
        },
    },
} as const;
