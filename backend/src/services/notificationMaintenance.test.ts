import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { db } from "../db.js";
import { pruneReadNotifications } from "./notificationMaintenance.js";

function insertNotification(options: {
    title: string;
    source: string;
    isRead: boolean;
    occurredAt: string;
}) {
    const now = new Date().toISOString();
    db.prepare(
        `INSERT INTO notifications (
            title,
            description,
            type,
            source,
            dedupe_key,
            metadata_json,
            is_read,
            created_at,
            updated_at,
            occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        options.title,
        "Test notification",
        "info",
        options.source,
        `${options.source}:${options.title}`,
        "{}",
        options.isRead ? 1 : 0,
        now,
        now,
        options.occurredAt
    );
}

function countBySource(source: string, where = "1 = 1"): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) as count FROM notifications WHERE source = ? AND ${where}`
        )
        .get(source) as { count: number };
    return row.count;
}

describe("notification maintenance", () => {
    const source = `maintenance-test-${Date.now()}`;

    beforeEach(() => {
        db.exec("BEGIN TRANSACTION");
    });

    afterEach(() => {
        db.exec("ROLLBACK");
    });

    it("removes stale read notifications while preserving unread items", () => {
        const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const recentDate = new Date(Date.now() + 60_000).toISOString();

        insertNotification({
            source,
            title: "old-read",
            isRead: true,
            occurredAt: oldDate,
        });
        insertNotification({
            source,
            title: "old-unread",
            isRead: false,
            occurredAt: oldDate,
        });
        insertNotification({
            source,
            title: "recent-read",
            isRead: true,
            occurredAt: recentDate,
        });

        pruneReadNotifications();

        assert.equal(countBySource(source), 2);
        assert.equal(countBySource(source, "title = 'old-read'"), 0);
        assert.equal(countBySource(source, "title = 'old-unread' AND is_read = 0"), 1);
        assert.equal(countBySource(source, "title = 'recent-read' AND is_read = 1"), 1);
    });

    it("keeps only the newest 300 read notifications", () => {
        const baseTime = Date.now() + 10 * 60_000;

        for (let index = 0; index < 305; index += 1) {
            insertNotification({
                source,
                title: `read-${String(index).padStart(3, "0")}`,
                isRead: true,
                occurredAt: new Date(baseTime + index * 1000).toISOString(),
            });
        }

        pruneReadNotifications();

        assert.equal(countBySource(source, "is_read = 1"), 300);
        assert.equal(countBySource(source, "title = 'read-000'"), 0);
        assert.equal(countBySource(source, "title = 'read-004'"), 0);
        assert.equal(countBySource(source, "title = 'read-005'"), 1);
        assert.equal(countBySource(source, "title = 'read-304'"), 1);
    });
});
