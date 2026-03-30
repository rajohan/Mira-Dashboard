import { db } from "../db.js";
import { fetchCachedQuotas, hasQuotaStatus } from "../lib/quotasCache.js";
import { pruneReadNotifications } from "./notificationMaintenance.js";

type ProviderKey = "openrouter" | "elevenlabs" | "zai" | "synthetic" | "openai";

const THRESHOLDS = [80, 90, 95] as const;
const HYSTERESIS = 5;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function getProviderPercent(provider: ProviderKey, quotas: Awaited<ReturnType<typeof fetchCachedQuotas>>): number | null {
    if (provider === "openrouter") {
        return hasQuotaStatus(quotas.openrouter) ? null : quotas.openrouter.percentUsed;
    }

    if (provider === "elevenlabs") {
        return hasQuotaStatus(quotas.elevenlabs) ? null : quotas.elevenlabs.percentUsed;
    }

    if (provider === "zai") {
        return hasQuotaStatus(quotas.zai)
            ? null
            : Math.max(quotas.zai.fiveHour.usedPercentage, quotas.zai.weekly.usedPercentage);
    }

    if (provider === "synthetic") {
        return hasQuotaStatus(quotas.synthetic)
            ? null
            : Math.max(
                  quotas.synthetic.rollingFiveHourLimit.percentUsed ?? 0,
                  100 - quotas.synthetic.weeklyTokenLimit.percentRemaining
              );
    }

    return hasQuotaStatus(quotas.openai) ? null : quotas.openai.percentUsed;
}

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

    if (provider === "zai" && !hasQuotaStatus(quotas.zai)) {
        return {
            title: `Z.ai usage high (${bucket}%)`,
            description: `5h ${quotas.zai.fiveHour.usedPercentage}% · weekly ${quotas.zai.weekly.usedPercentage}%`,
        };
    }

    if (provider === "synthetic" && !hasQuotaStatus(quotas.synthetic)) {
        return {
            title: `Synthetic.new usage high (${bucket}%)`,
            description: `5h ${Math.max(100 - (quotas.synthetic.rollingFiveHourLimit.percentUsed ?? 0), 0)}% left · weekly ${quotas.synthetic.weeklyTokenLimit.percentRemaining}% left`,
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

function ensureStateRow(provider: ProviderKey, bucket: number): void {
    db.prepare(
        `INSERT INTO quota_alert_state (provider, bucket, is_armed, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(provider, bucket) DO NOTHING`
    ).run(provider, bucket, new Date().toISOString());
}

function getState(provider: ProviderKey, bucket: number): { is_armed: number } {
    const state = db
        .prepare("SELECT is_armed FROM quota_alert_state WHERE provider = ? AND bucket = ?")
        .get(provider, bucket) as { is_armed?: number } | undefined;

    return {
        is_armed: state?.is_armed ?? 1,
    };
}

function setState(provider: ProviderKey, bucket: number, isArmed: number): void {
    db.prepare(
        `UPDATE quota_alert_state
         SET is_armed = ?, updated_at = ?
         WHERE provider = ? AND bucket = ?`
    ).run(isArmed, new Date().toISOString(), provider, bucket);
}

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

let running = false;

export async function runQuotaNotificationCheck(): Promise<void> {
    if (running) {
        return;
    }

    running = true;

    try {
        const quotas = await fetchCachedQuotas();
        const occurredAt = new Date(quotas.checkedAt).toISOString();
        const providers: ProviderKey[] = ["openrouter", "elevenlabs", "zai", "synthetic", "openai"];

        for (const provider of providers) {
            const percent = getProviderPercent(provider, quotas);
            if (percent === null) {
                continue;
            }

            for (const bucket of THRESHOLDS) {
                const payload = getNotificationPayload(provider, bucket, quotas);
                if (!payload) {
                    continue;
                }

                ensureStateRow(provider, bucket);
                const state = getState(provider, bucket);

                let isArmed = state.is_armed;

                if (isArmed === 1 && percent >= bucket) {
                    insertNotification(provider, bucket, percent, occurredAt, payload.title, payload.description);
                    isArmed = 0;
                } else if (percent < bucket - HYSTERESIS) {
                    isArmed = 1;
                }

                setState(provider, bucket, isArmed);
            }
        }
    } catch (error) {
        console.error("[QuotaNotifications] check failed", error);
    } finally {
        running = false;
    }
}

export function startQuotaNotificationMonitor(intervalMs = DEFAULT_INTERVAL_MS): void {
    const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 60_000 ? intervalMs : DEFAULT_INTERVAL_MS;

    void runQuotaNotificationCheck();
    setInterval(() => {
        void runQuotaNotificationCheck();
    }, safeInterval).unref();
}
