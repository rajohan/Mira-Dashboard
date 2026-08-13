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
const openRouterKeySchema = v.object({
    data: v.object({
        limit: v.nullable(nonnegativeFiniteSchema),
        limit_remaining: v.nullable(nonnegativeFiniteSchema),
        usage: nonnegativeFiniteSchema,
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
        remaining: nonnegativeFiniteSchema,
    }),
});

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
            id: "openrouter",
            label: "OpenRouter",
            limit,
            remaining,
            remainingPercent: percentage(remaining, limit),
            status: "available",
            unit: "currency-usd",
            used: keyProjection.usage,
            usedPercent: percentage(Math.max(limit - remaining, 0), limit),
        });
    } catch {
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
        return unavailableProvider("elevenlabs", "ElevenLabs");
    }
}

async function collectSynthetic(
    token: Redacted.Redacted<string> | undefined,
    fetchImplementation: typeof globalThis.fetch | undefined,
    signal: AbortSignal | undefined
): Promise<QuotaProviderProjection> {
    if (token === undefined) return missingProvider("synthetic", "Synthetic");
    try {
        const quota = v.parse(
            syntheticSchema,
            await fetchBoundedJson({
                fetch: fetchImplementation,
                headers: { Authorization: `Bearer ${Redacted.value(token)}` },
                signal,
                url: new URL("https://api.synthetic.new/v2/quotas"),
            })
        ).rollingFiveHourLimit;
        const remaining = Math.min(quota.remaining, quota.max);
        const used = Math.max(quota.max - remaining, 0);
        return v.parse(quotaProviderProjectionSchema, {
            id: "synthetic",
            label: "Synthetic",
            limit: quota.max,
            remaining,
            remainingPercent: percentage(remaining, quota.max),
            status: "available",
            unit: "credits",
            used,
            usedPercent: percentage(used, quota.max),
        });
    } catch {
        return unavailableProvider("synthetic", "Synthetic");
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
    const [elevenLabs, openAi, openRouter, synthetic] = await Promise.all([
        collectElevenLabs(credentials.elevenLabs, options.fetch, signal),
        (async () => {
            if (options.codex === undefined) {
                return unavailableProvider("openai", "OpenAI");
            }
            try {
                return v.parse(
                    quotaProviderProjectionSchema,
                    await collectCodexQuota(options.codex, signal)
                );
            } catch {
                return unavailableProvider("openai", "OpenAI");
            }
        })(),
        collectOpenRouter(credentials.openRouter, options.fetch, signal),
        collectSynthetic(credentials.synthetic, options.fetch, signal),
    ]);
    return v.parse(quotaCachePayloadSchema, {
        observedAtMs: (options.nowMs ?? Date.now)(),
        providers: [elevenLabs, openAi, openRouter, synthetic],
    });
}
