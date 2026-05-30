import assert from "node:assert/strict";
import http from "node:http";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import express from "express";

import { db } from "../db.js";
import notificationsRoutes from "./notifications.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

interface NotificationItem {
    id: number;
    title: string;
    description: string;
    type: string;
    source: string | null;
    dedupeKey: string | null;
    metadata: Record<string, unknown>;
    isRead: boolean;
    occurredAt: string;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    notificationsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            server.off("listening", onListening);
            server.off("error", onError);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0);
    });
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

function cleanupNotifications(source: string): void {
    db.prepare("DELETE FROM notifications WHERE source = ?").run(source);
}

describe("notifications routes", () => {
    let source: string;
    let server: TestServer;
    let notificationIdToCleanup: number | null = null;

    before(async () => {
        server = await startServer();
    });

    beforeEach(() => {
        source = `backend-notifications-${Date.now()}-${Math.random()}`;
    });

    afterEach(() => {
        if (notificationIdToCleanup !== null) {
            db.prepare("DELETE FROM notifications WHERE id = ?").run(
                notificationIdToCleanup
            );
            notificationIdToCleanup = null;
        }
        cleanupNotifications(source);
    });

    after(async () => {
        await server.close();
    });

    it("validates required fields and notification type", async () => {
        const missingTitle = await requestJson<{ error: string }>(
            server,
            "/api/notifications",
            { method: "POST", body: { description: "body", source } }
        );
        assert.equal(missingTitle.status, 400);
        assert.equal(missingTitle.body.error, "title is required");

        const missingDescription = await requestJson<{ error: string }>(
            server,
            "/api/notifications",
            { method: "POST", body: { title: "Title", source } }
        );
        assert.equal(missingDescription.status, 400);
        assert.equal(missingDescription.body.error, "description is required");

        const invalidType = await requestJson<{ error: string }>(
            server,
            "/api/notifications",
            {
                method: "POST",
                body: { title: "Title", description: "body", type: "loud", source },
            }
        );
        assert.equal(invalidType.status, 400);
        assert.equal(invalidType.body.error, "invalid notification type");

        const defaultType = await requestJson<{ ok: true; id: number | null }>(
            server,
            "/api/notifications",
            {
                method: "POST",
                body: { title: "Default type", description: "body", source },
            }
        );
        assert.equal(defaultType.status, 200);
        assert.equal(typeof defaultType.body.id, "number");
    });

    it("reports insert failures without pruning notifications", async () => {
        const originalPrepare = db.prepare.bind(db);
        const consoleError = mock.method(console, "error", () => {});
        const prepare = mock.method(db, "prepare", (sql: string) => {
            if (sql.includes("INSERT INTO notifications")) {
                return { get: () => null } as unknown as ReturnType<typeof db.prepare>;
            }
            return originalPrepare(sql);
        });

        try {
            const response = await requestJson<{ ok: false; error: string }>(
                server,
                "/api/notifications",
                {
                    method: "POST",
                    body: { title: "Broken insert", description: "body", source },
                }
            );

            assert.equal(response.status, 500);
            assert.deepEqual(response.body, {
                ok: false,
                error: "Failed to create notification",
            });
            assert.equal(consoleError.mock.callCount(), 1);
        } finally {
            prepare.mock.restore();
            consoleError.mock.restore();
        }
    });

    it("creates, upserts, lists, reads, clears, and deletes notifications", async () => {
        const first = await requestJson<{ ok: true; id: number | null }>(
            server,
            "/api/notifications",
            {
                method: "POST",
                body: {
                    title: "Initial title",
                    description: "Initial body",
                    type: "warning",
                    source,
                    dedupeKey: `${source}:same`,
                    metadata: { branch: "add-playwright-smoke-tests" },
                    occurredAt: "2026-05-11T00:00:00.000Z",
                },
            }
        );

        assert.equal(first.status, 200);
        assert.equal(first.body.ok, true);
        assert.equal(typeof first.body.id, "number");

        const whitespaceFields = await requestJson<{ ok: true; id: number | null }>(
            server,
            "/api/notifications",
            {
                method: "POST",
                body: {
                    title: "Whitespace fields",
                    description: "Body",
                    source: "   ",
                    dedupeKey: "   ",
                    metadata: [],
                },
            }
        );
        assert.equal(whitespaceFields.status, 200);
        notificationIdToCleanup = whitespaceFields.body.id;

        const upsert = await requestJson<{ ok: true; id: number | null }>(
            server,
            "/api/notifications",
            {
                method: "POST",
                body: {
                    title: "Updated title",
                    description: "Updated body",
                    type: "success",
                    source,
                    dedupeKey: `${source}:same`,
                    metadata: { run: 2 },
                    occurredAt: "2026-05-11T01:00:00.000Z",
                },
            }
        );

        assert.equal(upsert.status, 200);
        assert.equal(upsert.body.id, first.body.id);

        const list = await requestJson<{
            items: NotificationItem[];
            readCount: number;
            unreadCount: number;
        }>(server, "/api/notifications?limit=10");

        assert.equal(list.status, 200);
        assert.equal(list.body.readCount >= 0, true);
        const whitespaceItem = list.body.items.find(
            (notification) => notification.id === whitespaceFields.body.id
        );
        assert.ok(whitespaceItem);
        assert.equal(whitespaceItem.source, null);
        assert.equal(whitespaceItem.dedupeKey, null);
        assert.deepEqual(whitespaceItem.metadata, {});
        const item = list.body.items.find(
            (notification) => notification.dedupeKey === `${source}:same`
        );
        assert.ok(item);
        assert.equal(item.title, "Updated title");
        assert.equal(item.description, "Updated body");
        assert.equal(item.type, "success");
        assert.deepEqual(item.metadata, { run: 2 });
        assert.equal(item.isRead, false);

        const markRead = await requestJson<{ ok: true }>(
            server,
            `/api/notifications/${item.id}/read`,
            { method: "POST" }
        );
        assert.equal(markRead.status, 200);

        const markedList = await requestJson<{
            items: NotificationItem[];
            readCount: number;
        }>(server, "/api/notifications?limit=10");
        assert.equal(
            markedList.body.items.find((notification) => notification.id === item.id)
                ?.isRead,
            true
        );
        assert.equal(markedList.body.readCount >= 1, true);

        const clearRead = await requestJson<{ ok: true; deleted: number }>(
            server,
            "/api/notifications/clear-read",
            { method: "POST", body: { source } }
        );
        assert.equal(clearRead.status, 200);
        assert.equal(clearRead.body.deleted >= 1, true);

        const deletable = await requestJson<{ ok: true; id: number }>(
            server,
            "/api/notifications",
            {
                method: "POST",
                body: {
                    title: "Delete me",
                    description: "Delete branch",
                    source,
                },
            }
        );
        assert.equal(deletable.status, 200);

        const deleteExisting = await requestJson<{ ok: true; deleted: number }>(
            server,
            `/api/notifications/${deletable.body.id}`,
            { method: "DELETE" }
        );
        assert.equal(deleteExisting.status, 200);
        assert.equal(deleteExisting.body.deleted, 1);

        const deleteMissing = await requestJson<{ ok: true; deleted: number }>(
            server,
            `/api/notifications/${deletable.body.id}`,
            { method: "DELETE" }
        );
        assert.equal(deleteMissing.status, 200);
        assert.equal(deleteMissing.body.deleted, 0);
    });

    it("handles invalid notification ids and malformed stored metadata", async () => {
        db.prepare(
            `
            INSERT INTO notifications (
                title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `
        ).run(
            "Malformed metadata",
            "Historical row",
            "info",
            source,
            `${source}:malformed`,
            "{not-json",
            "2026-05-11T02:00:00.000Z",
            "2026-05-11T02:00:00.000Z",
            "2026-05-11T02:00:00.000Z"
        );
        db.prepare(
            `
            INSERT INTO notifications (
                title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `
        ).run(
            "Empty metadata",
            "Historical row",
            "info",
            source,
            `${source}:empty-metadata`,
            "",
            "2026-05-11T02:01:00.000Z",
            "2026-05-11T02:01:00.000Z",
            "2026-05-11T02:01:00.000Z"
        );

        const list = await requestJson<{
            items: NotificationItem[];
            unreadCount: number;
        }>(server, "/api/notifications?limit=not-a-number");
        assert.equal(list.status, 200);
        const item = list.body.items.find(
            (notification) => notification.dedupeKey === `${source}:malformed`
        );
        assert.ok(item);
        assert.deepEqual(item.metadata, {});
        assert.deepEqual(
            list.body.items.find(
                (notification) => notification.dedupeKey === `${source}:empty-metadata`
            )?.metadata,
            {}
        );

        const invalidRead = await requestJson<{ error: string }>(
            server,
            "/api/notifications/not-a-number/read",
            { method: "POST" }
        );
        assert.equal(invalidRead.status, 400);
        assert.equal(invalidRead.body.error, "invalid id");

        const invalidDelete = await requestJson<{ error: string }>(
            server,
            "/api/notifications/0",
            { method: "DELETE" }
        );
        assert.equal(invalidDelete.status, 400);
        assert.equal(invalidDelete.body.error, "invalid id");
    });

    it("marks all unread notifications as read", async () => {
        await requestJson<{ ok: true }>(server, "/api/notifications", {
            method: "POST",
            body: { title: "One", description: "body", type: "info", source },
        });
        await requestJson<{ ok: true }>(server, "/api/notifications", {
            method: "POST",
            body: { title: "Two", description: "body", type: "error", source },
        });

        const marked = await requestJson<{ ok: true }>(
            server,
            "/api/notifications/mark-all-read",
            { method: "POST" }
        );
        assert.equal(marked.status, 200);

        const list = await requestJson<{ items: NotificationItem[] }>(
            server,
            "/api/notifications?limit=20"
        );
        const ownItems = list.body.items.filter((item) => item.source === source);
        assert.equal(ownItems.length >= 2, true);
        assert.equal(
            ownItems.every((item) => item.isRead),
            true
        );

        const noReadLeft = await requestJson<{ ok: true; deleted: number }>(
            server,
            "/api/notifications/clear-read",
            { method: "POST", body: { source } }
        );
        assert.equal(noReadLeft.status, 200);
        assert.equal(noReadLeft.body.deleted, ownItems.length);

        const stillNoReadLeft = await requestJson<{ ok: true; deleted: number }>(
            server,
            "/api/notifications/clear-read",
            { method: "POST", body: { source } }
        );
        assert.equal(stillNoReadLeft.status, 200);
        assert.equal(stillNoReadLeft.body.deleted, 0);

        const globalClearRead = await requestJson<{ ok: true; deleted: number }>(
            server,
            "/api/notifications/clear-read",
            { method: "POST" }
        );
        assert.equal(globalClearRead.status, 200);
        assert.equal(globalClearRead.body.deleted >= 0, true);

        const deleteNeverExisted = await requestJson<{ ok: true; deleted: number }>(
            server,
            "/api/notifications/999999999",
            { method: "DELETE" }
        );
        assert.equal(deleteNeverExisted.status, 200);
        assert.equal(deleteNeverExisted.body.deleted, 0);
    });
});
