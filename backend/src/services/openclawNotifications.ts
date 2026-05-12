import { db } from "../db.js";
import { fetchCachedSystemHost } from "../lib/systemCache.js";
import { pruneReadNotifications } from "./notificationMaintenance.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/** Represents alert state. */
interface AlertState {
    is_armed: number;
    last_latest: string | null;
}

/** Returns state. */
function getState(): AlertState {
    const row = db
        .prepare("SELECT is_armed, last_latest FROM openclaw_alert_state WHERE id = 1")
        .get() as AlertState | undefined;

    return {
        is_armed: row?.is_armed ?? 1,
        last_latest: row?.last_latest ?? null,
    };
}

/** Performs set state. */
function setState(state: AlertState): void {
    db.prepare(
        `INSERT INTO openclaw_alert_state (id, is_armed, last_latest, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            is_armed = excluded.is_armed,
            last_latest = excluded.last_latest,
            updated_at = excluded.updated_at`
    ).run(state.is_armed, state.last_latest, new Date().toISOString());
}

/** Performs insert update available notification. */
function insertUpdateAvailableNotification(current: string, latest: string): void {
    const now = new Date().toISOString();
    const dedupeKey = `openclaw:update:${latest}`;

    db.prepare(
        `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
        ) VALUES (?, ?, 'warning', 'openclaw', ?, ?, 0, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
    ).run(
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

let running = false;

/** Performs run OpenClaw notification check. */
export async function runOpenClawNotificationCheck(): Promise<void> {
    if (running) {
        return;
    }

    running = true;

    try {
        const cached = await fetchCachedSystemHost();
        const version = cached.data.version;

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
    } finally {
        running = false;
    }
}

/** Performs start OpenClaw notification monitor. */
export function startOpenClawNotificationMonitor(intervalMs = DEFAULT_INTERVAL_MS): void {
    const safeInterval =
        Number.isFinite(intervalMs) && intervalMs >= 60_000
            ? intervalMs
            : DEFAULT_INTERVAL_MS;

    void runOpenClawNotificationCheck();
    setInterval(() => {
        void runOpenClawNotificationCheck();
    }, safeInterval).unref();
}
