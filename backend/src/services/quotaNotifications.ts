import { db } from "../db.js";
import {
    fetchCachedQuotas,
    hasQuotaStatus,
    type SyntheticQuota,
} from "../lib/quotasCache.js";
import { pruneReadNotifications } from "./notificationMaintenance.js";

/** Defines provider key. */
type ProviderKey = "openrouter" | "elevenlabs" | "synthetic" | "openai";

const THRESHOLDS = [80, 90, 95] as const;
const HYSTERESIS = 5;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;
const quotaMonitorIntervals = new Set<NodeJS.Timeout>();

/** Formats the Synthetic.new weekly remaining quota. */
function formatSyntheticWeeklyRemaining(
    weeklyTokenLimit: SyntheticQuota["weeklyTokenLimit"]
): string {
    if (
        weeklyTokenLimit.remainingCredits !== undefined &&
        weeklyTokenLimit.remainingCredits !== null
    ) {
        return `${weeklyTokenLimit.remainingCredits} left`;
    }
    if (weeklyTokenLimit.percentRemaining === null) {
        return "unknown";
    }

    return `${weeklyTokenLimit.percentRemaining}% left`;
}

/** Returns provIDer percent. */
function getProviderPercent(
    provider: ProviderKey,
    quotas: Awaited<ReturnType<typeof fetchCachedQuotas>>
): number | null {
    if (provider === "openrouter") {
        return hasQuotaStatus(quotas.openrouter) ? null : quotas.openrouter.percentUsed;
    }

    if (provider === "elevenlabs") {
        return hasQuotaStatus(quotas.elevenlabs) ? null : quotas.elevenlabs.percentUsed;
    }

    if (provider === "synthetic") {
        if (hasQuotaStatus(quotas.synthetic)) {
            return null;
        }
        const weeklyPercentUsed =
            quotas.synthetic.weeklyTokenLimit.percentRemaining === null
                ? null
                : 100 - quotas.synthetic.weeklyTokenLimit.percentRemaining;
        const rollingPercentUsed = quotas.synthetic.rollingFiveHourLimit.percentUsed;
        if (rollingPercentUsed === null && weeklyPercentUsed === null) {
            return null;
        }
        return Math.max(rollingPercentUsed ?? 0, weeklyPercentUsed ?? 0);
    }

    return hasQuotaStatus(quotas.openai) ? null : quotas.openai.percentUsed;
}

/** Returns notification payload. */
function getNotificationPayload(
    provider: ProviderKey,
    bucket: number,
    quotas: Awaited<ReturnType<typeof fetchCachedQuotas>>
) {
    if (provider === "openrouter" && !hasQuotaStatus(quotas.openrouter)) {
        return {
            title: `OpenRouter usage high (${bucket}%)`,
            description: `${quotas.openrouter.percentUsed}% used ($${quotas.openrouter.remaining.toFixed(2)} remaining)`,
        };
    }

    if (provider === "elevenlabs" && !hasQuotaStatus(quotas.elevenlabs)) {
        return {
            title: `ElevenLabs usage high (${bucket}%)`,
            description: `${quotas.elevenlabs.percentUsed}% used (${quotas.elevenlabs.remaining.toLocaleString()} chars remaining)`,
        };
    }

    if (provider === "synthetic" && !hasQuotaStatus(quotas.synthetic)) {
        return {
            title: `Synthetic.new usage high (${bucket}%)`,
            description: `5h ${Math.max(100 - (quotas.synthetic.rollingFiveHourLimit.percentUsed ?? 0), 0)}% left · weekly ${formatSyntheticWeeklyRemaining(quotas.synthetic.weeklyTokenLimit)}`,
        };
    }

    if (provider === "openai" && !hasQuotaStatus(quotas.openai)) {
        return {
            title: `OpenAI / Codex usage high (${bucket}%)`,
            description: `${quotas.openai.percentUsed}% used (5h ${quotas.openai.fiveHourLeftPercent}% left · weekly ${quotas.openai.weeklyLeftPercent}% left)`,
        };
    }
    return null;
}

/** Returns a notification payload or skips inconsistent quota snapshots. */
function getProviderNotificationPayload(
    provider: ProviderKey,
    bucket: number,
    quotas: Awaited<ReturnType<typeof fetchCachedQuotas>>
) {
    const payload = getNotificationPayload(provider, bucket, quotas);
    if (!payload) {
        console.warn(
            `[QuotaNotifications] Missing notification payload for ${provider} ${bucket}%`
        );
        return null;
    }
    return payload;
}

/** Performs ensure state row. */
function ensureStateRow(provider: ProviderKey, bucket: number): void {
    db.prepare(
        `INSERT INTO quota_alert_state (provider, bucket, is_armed, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(provider, bucket) DO NOTHING`
    ).run(provider, bucket, new Date().toISOString());
}

/** Returns state. */
function getState(provider: ProviderKey, bucket: number): { is_armed: number } {
    const state = db
        .prepare(
            "SELECT is_armed FROM quota_alert_state WHERE provider = ? AND bucket = ?"
        )
        .get(provider, bucket) as { is_armed?: number } | undefined;

    return {
        is_armed: state?.is_armed ?? 1,
    };
}

/** Performs set state. */
function setState(provider: ProviderKey, bucket: number, isArmed: number): void {
    db.prepare(
        `UPDATE quota_alert_state
         SET is_armed = ?, updated_at = ?
         WHERE provider = ? AND bucket = ?`
    ).run(isArmed, new Date().toISOString(), provider, bucket);
}

/** Performs insert notification. */
function insertNotification(
    provider: ProviderKey,
    bucket: number,
    percent: number,
    occurredAt: string,
    title: string,
    description: string
): void {
    const now = new Date().toISOString();
    const dedupeKey = `quota:${provider}:${bucket}`;

    db.prepare(
        `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json, is_read, created_at, updated_at, occurred_at
        ) VALUES (?, ?, 'warning', 'quota', ?, ?, 0, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            metadata_json = excluded.metadata_json,
            is_read = 0,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
    ).run(
        title,
        description,
        dedupeKey,
        JSON.stringify({ provider, bucket, percent }),
        now,
        now,
        occurredAt
    );

    pruneReadNotifications();
}

/** Handles one quota threshold bucket. */
function handleQuotaBucket(
    provider: ProviderKey,
    bucket: number,
    percent: number,
    quotas: Awaited<ReturnType<typeof fetchCachedQuotas>>,
    occurredAt: string
): void {
    const payload = getProviderNotificationPayload(provider, bucket, quotas);
    if (!payload) {
        return;
    }
    ensureStateRow(provider, bucket);
    const state = getState(provider, bucket);

    let isArmed = state.is_armed;

    if (isArmed === 1 && percent >= bucket) {
        insertNotification(
            provider,
            bucket,
            percent,
            occurredAt,
            payload.title,
            payload.description
        );
        isArmed = 0;
    } else if (percent < bucket - HYSTERESIS) {
        isArmed = 1;
    }

    setState(provider, bucket, isArmed);
}

let running = false;

/** Returns false only when a check is attempted and fails; concurrent calls are non-failure skips. */
export async function runQuotaNotificationCheck(): Promise<boolean> {
    if (running) {
        return true;
    }

    running = true;

    try {
        const quotas = await fetchCachedQuotas();
        const occurredAt = new Date(quotas.checkedAt).toISOString();
        const providers: ProviderKey[] = [
            "openrouter",
            "elevenlabs",
            "synthetic",
            "openai",
        ];

        for (const provider of providers) {
            const percent = getProviderPercent(provider, quotas);
            if (percent === null) {
                continue;
            }

            for (const bucket of THRESHOLDS) {
                handleQuotaBucket(provider, bucket, percent, quotas, occurredAt);
            }
        }
        return true;
    } catch (error) {
        console.error("[QuotaNotifications] check failed", error);
        return false;
    } finally {
        running = false;
    }
}

/** Performs start quota notification monitor. */
export function startQuotaNotificationMonitor(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (quotaMonitorIntervals.size > 0) {
        return;
    }

    const safeInterval =
        Number.isFinite(intervalMs) && intervalMs >= 60_000
            ? Math.min(Math.trunc(intervalMs), MAX_TIMER_MS)
            : DEFAULT_INTERVAL_MS;

    void runQuotaNotificationCheck();
    const monitor = setInterval(() => {
        void runQuotaNotificationCheck();
    }, safeInterval);
    quotaMonitorIntervals.add(monitor);
    monitor.unref();
}

/** Stops quota notification monitors. */
export function stopQuotaNotificationMonitor(): void {
    for (const monitor of quotaMonitorIntervals) {
        clearInterval(monitor);
    }
    quotaMonitorIntervals.clear();
}

export const __testing = {
    getNotificationPayload,
    getProviderNotificationPayload,
    getProviderPercent,
    getState,
    handleQuotaBucket,
    isRunning: () => running,
};
