import { database, sqlNullable } from "../../database.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { caughtMessage, nowIso, serviceLabel } from "./support.ts";
import type { JsonRecord, ManagedServiceRow } from "./types.ts";

const logger = createStructuredLogger("docker-updater");

function insertEvent(
    service: ManagedServiceRow,
    eventType: string,
    message: string,
    details: Record<string, unknown> = {}
) {
    database
        .prepare(
            `INSERT INTO docker_update_events (
            managed_service_id, app_slug, service_name, event_type, from_tag, to_tag,
            from_digest, to_digest, message, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            service.id,
            service.app_slug,
            service.service_name,
            eventType,
            sqlNullable(service.current_tag),
            sqlNullable(service.latest_tag),
            sqlNullable(service.current_digest),
            sqlNullable(service.latest_digest),
            message,
            JSON.stringify(details),
            nowIso()
        );
}

export function insertEventBestEffort(
    service: ManagedServiceRow,
    eventType: string,
    message: string,
    details: Record<string, unknown> = {}
) {
    try {
        insertEvent(service, eventType, message, details);
    } catch (error) {
        logger.error("docker_updater.event_persist_failed", {
            error: caughtMessage(error),
            eventType,
            service: serviceLabel(service),
        });
    }
}

function createNotification(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
) {
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

export function createNotificationBestEffort(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
) {
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
