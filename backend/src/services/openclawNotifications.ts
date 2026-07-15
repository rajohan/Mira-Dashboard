import { database, sqlNullable } from "../database.ts";
import type { CachedOpenClawVersion } from "../lib/systemCache.ts";
import { pruneReadNotifications } from "./notificationMaintenance.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

/** Represents alert state. */
interface AlertState {
    is_armed: number;
    last_latest: string | undefined;
}

/** Returns state. */
function getState(): AlertState {
    const row = database
        .prepare("SELECT is_armed, last_latest FROM openclaw_alert_state WHERE id = 1")
        .get() as AlertState | undefined;

    return {
        is_armed: row?.is_armed ?? 1,
        last_latest: row?.last_latest ?? undefined,
    };
}

/** Performs set state. */
function setState(state: AlertState): void {
    database
        .prepare(
            `INSERT INTO openclaw_alert_state (id, is_armed, last_latest, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            is_armed = excluded.is_armed,
            last_latest = excluded.last_latest,
            updated_at = excluded.updated_at`
        )
        .run(state.is_armed, sqlNullable(state.last_latest), dateToISOString(new Date()));
}

/** Performs insert update available notification. */
function insertUpdateAvailableNotification(current: string, latest: string): void {
    const now = dateToISOString(new Date());
    const dedupeKey = `openclaw:update:${latest}`;

    database
        .prepare(
            `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
        ) VALUES (?, ?, 'warning', 'openclaw', ?, ?, 0, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
        )
        .run(
            "OpenClaw update available",
            `Current ${current} → latest ${latest}.`,
            dedupeKey,
            JSON.stringify({ current, latest, updateAvailable: true }),
            now,
            now,
            now
        );

    pruneReadNotifications();
}

/** Evaluates OpenClaw version state after a successful system refresh. */
export function evaluateOpenClawNotifications(systemHost: {
    version?: CachedOpenClawVersion;
}): void {
    try {
        const version = systemHost.version;
        if (!version) {
            throw new Error("OpenClaw version missing from system.host cache");
        }
        const state = getState();

        if (version.updateAvailable && version.latest) {
            const shouldNotify =
                state.is_armed === 1 || state.last_latest !== version.latest;
            if (shouldNotify) {
                insertUpdateAvailableNotification(version.current, version.latest);
            }

            setState({
                is_armed: 0,
                last_latest: version.latest,
            });
        } else {
            setState({
                is_armed: 1,
                last_latest: version.latest,
            });
        }
    } catch (error) {
        console.error("[OpenClawNotifications] check failed", error);
    }
}
