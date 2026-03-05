import { db } from "../db.js";
import { fetchQuotas, hasQuotaStatus } from "../routes/quotas.js";

type ProviderKey = "openrouter" | "elevenlabs" | "zai" | "openai";

const THRESHOLDS = [80, 90, 95] as const;
const HYSTERESIS = 5;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function getPeriodKey(date = new Date()): string {
    return date.toISOString().slice(0, 10);
}

function getProviderPercent(provider: ProviderKey, quotas: Awaited<ReturnType<typeof fetchQuotas>>): number | null {
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

    return hasQuotaStatus(quotas.openai) ? null : quotas.openai.percentUsed;
}

function getNotificationPayload(provider: ProviderKey, quotas: Awaited<ReturnType<typeof fetchQuotas>>) {
    if (provider === "openrouter" && !hasQuotaStatus(quotas.openrouter)) {
        return {
            title: "OpenRouter usage high",
            description: `${quotas.openrouter.percentUsed}% used ($${quotas.openrouter.remaining.toFixed(2)} remaining)`,
        };
    }

    if (provider === "elevenlabs" && !hasQuotaStatus(quotas.elevenlabs)) {
        return {
            title: "ElevenLabs usage high",
            description: `${quotas.elevenlabs.percentUsed}% used (${quotas.elevenlabs.remaining.toLocaleString()} chars remaining)`,
        };
    }

    if (provider === "zai" && !hasQuotaStatus(quotas.zai)) {
        return {
            title: "Z.ai usage high",
            description: `5h ${quotas.zai.fiveHour.usedPercentage}% · weekly ${quotas.zai.weekly.usedPercentage}%`,
        };
    }

    if (provider === "openai" && !hasQuotaStatus(quotas.openai)) {
        return {
            title: "OpenAI API usage high",
            description: `${quotas.openai.percentUsed}% of hard limit used`,
        };
    }

    return null;
}

function ensureStateRow(provider: ProviderKey, bucket: number, periodKey: string): void {
    db.prepare(
        `INSERT INTO quota_alert_state (provider, bucket, is_armed, period_key, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(provider, bucket) DO NOTHING`
    ).run(provider, bucket, periodKey, new Date().toISOString());
}

function getState(provider: ProviderKey, bucket: number): { is_armed: number; period_key: string | null } {
    const state = db
        .prepare("SELECT is_armed, period_key FROM quota_alert_state WHERE provider = ? AND bucket = ?")
        .get(provider, bucket) as { is_armed?: number; period_key?: string | null } | undefined;

    return {
        is_armed: state?.is_armed ?? 1,
        period_key: state?.period_key ?? null,
    };
}

function setState(provider: ProviderKey, bucket: number, isArmed: number, periodKey: string): void {
    db.prepare(
        `UPDATE quota_alert_state
         SET is_armed = ?, period_key = ?, updated_at = ?
         WHERE provider = ? AND bucket = ?`
    ).run(isArmed, periodKey, new Date().toISOString(), provider, bucket);
}

function insertNotification(
    provider: ProviderKey,
    bucket: number,
    periodKey: string,
    percent: number,
    occurredAt: string,
    title: string,
    description: string
): void {
    const now = new Date().toISOString();
    const dedupeKey = `quota:${provider}:${bucket}:${periodKey}`;

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
        JSON.stringify({ provider, bucket, percent, periodKey }),
        now,
        now,
        occurredAt
    );
}

let running = false;

export async function runQuotaNotificationCheck(): Promise<void> {
    if (running) {
        return;
    }

    running = true;

    try {
        const quotas = await fetchQuotas();
        const periodKey = getPeriodKey();
        const occurredAt = new Date(quotas.checkedAt).toISOString();
        const providers: ProviderKey[] = ["openrouter", "elevenlabs", "zai", "openai"];

        for (const provider of providers) {
            const percent = getProviderPercent(provider, quotas);
            if (percent === null) {
                continue;
            }

            const payload = getNotificationPayload(provider, quotas);
            if (!payload) {
                continue;
            }

            for (const bucket of THRESHOLDS) {
                ensureStateRow(provider, bucket, periodKey);
                const state = getState(provider, bucket);

                let isArmed = state.is_armed;
                if (state.period_key !== periodKey) {
                    isArmed = 1;
                }

                if (isArmed === 1 && percent >= bucket) {
                    insertNotification(
                        provider,
                        bucket,
                        periodKey,
                        percent,
                        occurredAt,
                        payload.title,
                        payload.description
                    );
                    isArmed = 0;
                } else if (percent < bucket - HYSTERESIS) {
                    isArmed = 1;
                }

                setState(provider, bucket, isArmed, periodKey);
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
