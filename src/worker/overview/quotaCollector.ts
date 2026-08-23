import { Redacted } from "effect";
import * as v from "valibot";

import {
    type QuotaCachePayload,
    type QuotaProviderProjection,
    quotaCachePayloadSchema,
    quotaProviderProjectionSchema,
} from "../../contracts/quota.ts";
import { fetchBoundedJson } from "./boundedJsonFetch.ts";
import {
    collectCodexQuota,
    type CodexQuotaCollectorOptions,
} from "./codexQuotaCollector.ts";

const nonnegativeFiniteSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const boundedCurrencySchema = v.union([
    nonnegativeFiniteSchema,
    v.pipe(v.string(), v.maxLength(64)),
]);
const openRouterKeySchema = v.object({
    data: v.object({
        limit: v.nullable(nonnegativeFiniteSchema),
        limit_remaining: v.nullable(nonnegativeFiniteSchema),
        usage: nonnegativeFiniteSchema,
        usage_monthly: v.optional(nonnegativeFiniteSchema),
    }),
});
const openRouterCreditsSchema = v.object({
    data: v.object({ total_credits: nonnegativeFiniteSchema }),
});
const elevenLabsSchema = v.object({
    subscription: v.object({
        character_count: nonnegativeFiniteSchema,
        character_limit: nonnegativeFiniteSchema,
        next_character_count_reset_unix: v.optional(nonnegativeFiniteSchema),
        next_character_count_reset_unix_ms: v.optional(nonnegativeFiniteSchema),
    }),
});
const syntheticSchema = v.object({
    rollingFiveHourLimit: v.object({
        max: nonnegativeFiniteSchema,
        nextTickAt: v.optional(v.string()),
        remaining: nonnegativeFiniteSchema,
        tickPercent: v.optional(nonnegativeFiniteSchema),
    }),
    weeklyTokenLimit: v.optional(
        v.object({
            maxCredits: v.optional(boundedCurrencySchema),
            nextRegenAt: v.optional(v.string()),
            nextRegenCredits: v.optional(boundedCurrencySchema),
            nextRegenPercent: v.optional(nonnegativeFiniteSchema),
            percentRemaining: nonnegativeFiniteSchema,
        })
    ),
});

function currencyNumber(value: string | number | undefined): number | undefined {
    if (typeof value === "number") return value;
    if (value === undefined) return undefined;
    const parsed = Number(value.replaceAll(/[,$\s]/gu, ""));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function timestampMilliseconds(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizedRegenerationPercent(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    return Math.min(100, value > 0 && value <= 1 ? value * 100 : value);
}

function syntheticWindows(
    quota: v.InferOutput<typeof syntheticSchema>,
    fiveHourUsedPercent: number
): QuotaProviderProjection["windows"] {
    const windows = [];
    const fiveHourResetAtMs = timestampMilliseconds(
        quota.rollingFiveHourLimit.nextTickAt
    );
    if (fiveHourResetAtMs !== undefined) {
        windows.push({
            regenerationPercent: normalizedRegenerationPercent(
                quota.rollingFiveHourLimit.tickPercent
            ),
            resetsAtMs: fiveHourResetAtMs,
            usedPercent: fiveHourUsedPercent,
            windowDurationMinutes: 300,
        });
    }
    const weeklyResetAtMs = timestampMilliseconds(quota.weeklyTokenLimit?.nextRegenAt);
    if (weeklyResetAtMs !== undefined && quota.weeklyTokenLimit !== undefined) {
        const maximumCredits = currencyNumber(quota.weeklyTokenLimit.maxCredits);
        const regenerationCredits = currencyNumber(
            quota.weeklyTokenLimit.nextRegenCredits
        );
        const regenerationPercent =
            quota.weeklyTokenLimit.nextRegenPercent ??
            (maximumCredits === undefined ||
            maximumCredits <= 0 ||
            regenerationCredits === undefined
                ? undefined
                : (regenerationCredits / maximumCredits) * 100);
        windows.push({
            regenerationPercent: normalizedRegenerationPercent(regenerationPercent),
            resetsAtMs: weeklyResetAtMs,
            usedPercent: Math.max(
                0,
                Math.min(100, 100 - quota.weeklyTokenLimit.percentRemaining)
            ),
            windowDurationMinutes: 10_080,
        });
    }
    return windows.length === 0 ? undefined : windows;
}

export interface QuotaCollectorCredentials {
    readonly elevenLabs?: Redacted.Redacted<string>;
    readonly openRouter?: Redacted.Redacted<string>;
    readonly synthetic?: Redacted.Redacted<string>;
}

export interface QuotaCollectorOptions {
    readonly codex?: CodexQuotaCollectorOptions;
    readonly fetch?: typeof globalThis.fetch;
    readonly nowMs?: () => number;
}

function percentage(numerator: number, denominator: number): number | undefined {
    if (denominator <= 0) return undefined;
    return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

function missingProvider(
    id: QuotaProviderProjection["id"],
    label: string
): QuotaProviderProjection {
    return v.parse(quotaProviderProjectionSchema, {
        id,
        label,
        status: "not-configured",
    });
}

function unavailableProvider(
    id: QuotaProviderProjection["id"],
    label: string
): QuotaProviderProjection {
    return v.parse(quotaProviderProjectionSchema, {
        id,
        label,
        status: "unavailable",
    });
}

async function collectOpenRouter(
    token: Redacted.Redacted<string> | undefined,
    fetchImplementation: typeof globalThis.fetch | undefined,
    signal: AbortSignal | undefined
): Promise<QuotaProviderProjection> {
    if (token === undefined) return missingProvider("openrouter", "OpenRouter");
    try {
        const headers = { Authorization: `Bearer ${Redacted.value(token)}` };
        const [key, credits] = await Promise.all([
            fetchBoundedJson({
                fetch: fetchImplementation,
                headers,
                signal,
                url: new URL("https://openrouter.ai/api/v1/key"),
            }),
            fetchBoundedJson({
                fetch: fetchImplementation,
                headers,
                signal,
                url: new URL("https://openrouter.ai/api/v1/credits"),
            }),
        ]);
        const keyProjection = v.parse(openRouterKeySchema, key).data;
        const total = v.parse(openRouterCreditsSchema, credits).data.total_credits;
        const limit = keyProjection.limit ?? total;
        const remaining =
            keyProjection.limit_remaining ?? Math.max(total - keyProjection.usage, 0);
        return v.parse(quotaProviderProjectionSchema, {
            balance: Math.max(total - keyProjection.usage, 0),
            id: "openrouter",
            label: "OpenRouter",
            limit,
            remaining,
            remainingPercent: percentage(remaining, limit),
            ...(keyProjection.usage_monthly === undefined
                ? {}
                : { periodUsage: keyProjection.usage_monthly }),
            status: "available",
            unit: "currency-usd",
            used: keyProjection.usage,
            usedPercent: percentage(Math.max(limit - remaining, 0), limit),
        });
    } catch {
        signal?.throwIfAborted();
        return unavailableProvider("openrouter", "OpenRouter");
    }
}

async function collectElevenLabs(
    token: Redacted.Redacted<string> | undefined,
    fetchImplementation: typeof globalThis.fetch | undefined,
    signal: AbortSignal | undefined
): Promise<QuotaProviderProjection> {
    if (token === undefined) return missingProvider("elevenlabs", "ElevenLabs");
    try {
        const subscription = v.parse(
            elevenLabsSchema,
            await fetchBoundedJson({
                fetch: fetchImplementation,
                headers: { "xi-api-key": Redacted.value(token) },
                signal,
                url: new URL("https://api.elevenlabs.io/v1/user"),
            })
        ).subscription;
        const remaining = Math.max(
            subscription.character_limit - subscription.character_count,
            0
        );
        const resetMilliseconds =
            subscription.next_character_count_reset_unix_ms ??
            (subscription.next_character_count_reset_unix === undefined
                ? undefined
                : subscription.next_character_count_reset_unix * 1000);
        return v.parse(quotaProviderProjectionSchema, {
            id: "elevenlabs",
            label: "ElevenLabs",
            limit: subscription.character_limit,
            remaining,
            remainingPercent: percentage(remaining, subscription.character_limit),
            ...(resetMilliseconds === undefined
                ? {}
                : { resetsAtMs: Math.floor(resetMilliseconds) }),
            status: "available",
            unit: "text-characters",
            used: subscription.character_count,
            usedPercent: percentage(
                subscription.character_count,
                subscription.character_limit
            ),
        });
    } catch {
        signal?.throwIfAborted();
        return unavailableProvider("elevenlabs", "ElevenLabs");
    }
}

async function collectSynthetic(
    token: Redacted.Redacted<string> | undefined,
    fetchImplementation: typeof globalThis.fetch | undefined,
    signal: AbortSignal | undefined
): Promise<QuotaProviderProjection> {
    if (token === undefined) return missingProvider("synthetic", "Synthetic.new");
    try {
        const quota = v.parse(
            syntheticSchema,
            await fetchBoundedJson({
                fetch: fetchImplementation,
                headers: { Authorization: `Bearer ${Redacted.value(token)}` },
                signal,
                url: new URL("https://api.synthetic.new/v2/quotas"),
            })
        );
        const remaining = Math.min(
            quota.rollingFiveHourLimit.remaining,
            quota.rollingFiveHourLimit.max
        );
        const used = Math.max(quota.rollingFiveHourLimit.max - remaining, 0);
        const usedPercent = percentage(used, quota.rollingFiveHourLimit.max);
        return v.parse(quotaProviderProjectionSchema, {
            id: "synthetic",
            label: "Synthetic.new",
            limit: quota.rollingFiveHourLimit.max,
            remaining,
            remainingPercent: percentage(remaining, quota.rollingFiveHourLimit.max),
            status: "available",
            unit: "credits",
            used,
            usedPercent,
            ...(usedPercent === undefined
                ? {}
                : { windows: syntheticWindows(quota, usedPercent) }),
        });
    } catch {
        signal?.throwIfAborted();
        return unavailableProvider("synthetic", "Synthetic.new");
    }
}

/**
 * Collects provider-isolated, aggregate-only quota information.
 * @returns The canonical four-provider quota projection.
 */
export async function collectQuotaPayload(
    credentials: QuotaCollectorCredentials,
    signal?: AbortSignal,
    options: QuotaCollectorOptions = {}
): Promise<QuotaCachePayload> {
    signal?.throwIfAborted();
    const [elevenLabs, openAi, openRouter, synthetic] = await Promise.all([
        collectElevenLabs(credentials.elevenLabs, options.fetch, signal),
        (async () => {
            if (options.codex === undefined) {
                return unavailableProvider("openai", "OpenAI / Codex");
            }
            try {
                return v.parse(
                    quotaProviderProjectionSchema,
                    await collectCodexQuota(options.codex, signal)
                );
            } catch {
                signal?.throwIfAborted();
                return unavailableProvider("openai", "OpenAI / Codex");
            }
        })(),
        collectOpenRouter(credentials.openRouter, options.fetch, signal),
        collectSynthetic(credentials.synthetic, options.fetch, signal),
    ]);
    const observedAtMs = (options.nowMs ?? Date.now)();
    signal?.throwIfAborted();
    return v.parse(quotaCachePayloadSchema, {
        observedAtMs,
        providers: [elevenLabs, openAi, openRouter, synthetic],
    });
}
