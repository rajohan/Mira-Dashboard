import { database, sqlNullable } from "../../database/connection.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { caughtMessage, nowIso, serviceLabel } from "./support.ts";
import type { ManagedServiceRow } from "./types.ts";

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
