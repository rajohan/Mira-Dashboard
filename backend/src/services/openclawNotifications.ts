import { database } from "../database.ts";
import { fetchCachedSystemHost } from "../lib/systemCache.ts";
import { pruneReadNotifications } from "./notificationMaintenance.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const OPENCLAW_NOTIFICATION_JOB_ID = "notifications.openclaw";

/** Represents alert state. */
interface AlertState {
    is_armed: number;
    last_latest: string | null;
}

/** Returns state. */
function getState(): AlertState {
    const row = database
        .prepare("SELECT is_armed, last_latest FROM openclaw_alert_state WHERE id = 1")
        .get() as AlertState | undefined;

    return {
        is_armed: row?.is_armed ?? 1,
        last_latest: row?.last_latest ?? null,
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
        .run(state.is_armed, state.last_latest, dateToISOString(new Date()));
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

const openClawNotificationState = { isRunning: false };
/** Performs run OpenClaw notification check. */
export async function runOpenClawNotificationCheck(): Promise<boolean> {
    if (openClawNotificationState.isRunning) {
        return true;
    }

    openClawNotificationState.isRunning = true;

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
        return true;
    } catch (error) {
        console.error("[OpenClawNotifications] check failed", error);
        return false;
    } finally {
        openClawNotificationState.isRunning = false;
    }
}

/** Registers OpenClaw update notification checks with the shared scheduler. */
export function registerOpenClawNotificationScheduledJobs(): void {
    registerScheduledJobAction("notifications.openclaw", async () => {
        const isOk = await runOpenClawNotificationCheck();
        if (!isOk) {
            throw new Error("OpenClaw notification check failed");
        }
        return { isOk: true };
    });
    database.exec("BEGIN");
    try {
        removeScheduledJobsNotInAction("notifications.openclaw", [
            OPENCLAW_NOTIFICATION_JOB_ID,
        ]);
        const existing = getScheduledJob(OPENCLAW_NOTIFICATION_JOB_ID);
        upsertScheduledJob({
            id: OPENCLAW_NOTIFICATION_JOB_ID,
            name: "OpenClaw notifications",
            description: "Check cached OpenClaw version status and update notifications.",
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? "interval",
            intervalSeconds: existing?.intervalSeconds ?? 60 * 60,
            timeOfDay: existing?.timeOfDay ?? null,
            cronExpression: existing?.cronExpression ?? null,
            actionKey: "notifications.openclaw",
            actionPayload: {},
        });
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}
