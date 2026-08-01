import { database } from "../../database.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { caughtMessage, nowIso } from "./support.ts";
import type { JsonRecord } from "./types.ts";

const logger = createStructuredLogger("docker-updater");

function createNotification(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
): void {
    const timestamp = nowIso();
    database
        .prepare(
            `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json,
            is_read, created_at, updated_at, occurred_at
         ) VALUES (?, ?, ?, 'docker-updater', ?, ?, 0, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            type = excluded.type,
            metadata_json = excluded.metadata_json,
            is_read = 0,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
        )
        .run(
            title,
            description,
            type,
            dedupeKey,
            JSON.stringify(metadata),
            timestamp,
            timestamp,
            timestamp
        );
}

/**
 * Persists an updater notification without failing the updater workflow.
 * @param title Notification title.
 * @param description Notification description.
 * @param dedupeKey Stable notification deduplication key.
 * @param type Notification severity.
 * @param metadata Structured notification metadata.
 */
export function createNotificationBestEffort(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
): void {
    try {
        createNotification(title, description, dedupeKey, type, metadata);
    } catch (error) {
        logger.error("docker_updater.notification_persist_failed", {
            dedupeKey,
            error: caughtMessage(error),
            title,
        });
    }
}
