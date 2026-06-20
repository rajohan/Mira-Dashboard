import { database } from "../database.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const READ_RETENTION_DAYS = 14;
const MAX_READ_ITEMS = 300;

/** Performs prune read notifications. */
export function pruneReadNotifications(): void {
    const cutoff = dateToISOString(
        new Date(Date.now() - READ_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    );

    database
        .prepare("DELETE FROM notifications WHERE is_read = 1 AND occurred_at < ?")
        .run(cutoff);

    database
        .prepare(
            `DELETE FROM notifications
         WHERE id IN (
            SELECT id
            FROM notifications
            WHERE is_read = 1
            ORDER BY datetime(occurred_at) DESC
            LIMIT -1 OFFSET ?
         )`
        )
        .run(MAX_READ_ITEMS);
}
