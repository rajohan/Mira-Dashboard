import { type Database } from "bun:sqlite";

import { database } from "../database.ts";

const READ_RETENTION_DAYS = 14;
const MAX_READ_ITEMS = 300;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Performs prune read notifications. */
export function pruneReadNotifications(
    databaseConnection: Database = database,
    now = new Date()
): number {
    const cutoff = new Date(
        now.getTime() - READ_RETENTION_DAYS * MILLISECONDS_PER_DAY
    ).toISOString();

    const expired = databaseConnection
        .prepare(
            `DELETE FROM notifications
             WHERE is_read = 1
               AND COALESCE(
                       datetime(occurred_at),
                       datetime(created_at)
                   ) < datetime(?)`
        )
        .run(cutoff).changes;

    const beyondLimit = databaseConnection
        .prepare(
            `DELETE FROM notifications
             WHERE is_read = 1
               AND id IN (
                   SELECT id
                   FROM notifications
                   WHERE is_read = 1
                   ORDER BY COALESCE(
                                datetime(occurred_at),
                                datetime(created_at)
                            ) DESC,
                            id DESC
                   LIMIT -1 OFFSET ?
               )`
        )
        .run(MAX_READ_ITEMS).changes;

    return expired + beyondLimit;
}
