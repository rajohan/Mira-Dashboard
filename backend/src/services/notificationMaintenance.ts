import { db } from "../db.js";

const READ_RETENTION_DAYS = 14;
const MAX_READ_ITEMS = 300;

/** Performs prune read notifications. */
export function pruneReadNotifications(): void {
    const cutoff = new Date(
        Date.now() - READ_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    db.prepare("DELETE FROM notifications WHERE is_read = 1 AND occurred_at < ?").run(
        cutoff
    );

    db.prepare(
        `DELETE FROM notifications
         WHERE id IN (
            SELECT id
            FROM notifications
            WHERE is_read = 1
            ORDER BY datetime(occurred_at) DESC
            LIMIT -1 OFFSET ?
         )`
    ).run(MAX_READ_ITEMS);
}
