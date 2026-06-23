import { getCacheEntry, parseJsonField } from "./cacheStore.ts";

/** Represents open router quota. */
export interface OpenRouterQuota {
    usage: number;
    totalCredits: number;
    remaining: number;
    usageMonthly: number;
    percentUsed: number | undefined;
}

/** Represents eleven labs quota. */
export interface ElevenLabsQuota {
    used: number;
    total: number;
    remaining: number;
    tier: string;
    percentUsed: number | undefined;
    resetAt: string | undefined;
}

/** Represents open ai quota. */
export interface OpenAiQuota {
    account: string | undefined;
    model: string | undefined;
    fiveHourLeftPercent: number;
    weeklyLeftPercent: number;
    fiveHourReset: string | undefined;
    weeklyReset: string | undefined;
    percentUsed: number;
    resetAt: string | undefined;
}

/** Represents synthetic quota. */
export interface SyntheticQuota {
    subscription: {
        limit: number;
        requests: number;
        remaining: number;
        renewsAt: string | undefined;
        percentUsed: number | undefined;
    };
    searchHourly: {
        limit: number;
        requests: number;
        remaining: number;
        renewsAt: string | undefined;
        percentUsed: number | undefined;
    };
    weeklyTokenLimit: {
        percentRemaining: number;
        nextRegenAt: string | undefined;
        maxCredits?: string | undefined;
        remainingCredits?: string | undefined;
        nextRegenCredits?: string | undefined;
        nextRegenPercent?: number | undefined;
    };
    rollingFiveHourLimit: {
        remaining: number;
        max: number;
        limited: boolean;
        nextTickAt: string | undefined;
        tickPercent?: number;
        percentUsed: number | undefined;
    };
}

/** Represents quota error. */
export interface QuotaError {
    status: "not_configured" | "error";
    note?: string;
}

/** Represents the quotas API response. */
export interface QuotasResponse {
    openrouter: OpenRouterQuota | QuotaError;
    elevenlabs: ElevenLabsQuota | QuotaError;
    synthetic: SyntheticQuota | QuotaError;
    openai: OpenAiQuota | QuotaError;
    checkedAt: number;
    cacheAgeMs: number;
}

/** Returns whether quota status is present. */
export function hasQuotaStatus(value: unknown): value is QuotaError {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}

/** Fetches cached quotas. */
export async function fetchCachedQuotas(): Promise<QuotasResponse> {
    const row = await getCacheEntry("quotas.summary");
    if (!row || row.status !== "fresh") {
        throw new Error("Quota cache entry not found or not fresh");
    }

    const data = parseJsonField<QuotasResponse>(row.data);
    if (!data) {
        throw new Error("Quota cache payload is invalid");
    }

    return {
        ...data,
        cacheAgeMs: Math.max(Date.now() - data.checkedAt, 0),
    };
}
