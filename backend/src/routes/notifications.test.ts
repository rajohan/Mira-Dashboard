import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

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

function cleanupNotifications(source: string): void {
    db.prepare("DELETE FROM notifications WHERE source = ?").run(source);
}

describe("notifications routes", () => {
    const source = `backend-notifications-${Date.now()}`;
    let server: TestServer;

    before(async () => {
        cleanupNotifications(source);
        server = await startServer();
    });

    after(async () => {
        await server.close();
        cleanupNotifications(source);
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

        const list = await requestJson<{
            items: NotificationItem[];
            unreadCount: number;
        }>(server, "/api/notifications?limit=10");

        assert.equal(list.status, 200);
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

        const markedList = await requestJson<{ items: NotificationItem[] }>(
            server,
            "/api/notifications?limit=10"
        );
        assert.equal(
            markedList.body.items.find((notification) => notification.id === item.id)
                ?.isRead,
            true
        );

        const clearRead = await requestJson<{ ok: true; deleted: number }>(
            server,
            "/api/notifications/clear-read",
            { method: "POST" }
        );
        assert.equal(clearRead.status, 200);
        assert.equal(clearRead.body.deleted >= 1, true);

        const deleteMissing = await requestJson<{ ok: true; deleted: number }>(
            server,
            `/api/notifications/${item.id}`,
            { method: "DELETE" }
        );
        assert.equal(deleteMissing.status, 200);
        assert.equal(deleteMissing.body.deleted, 0);
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
    });
});
