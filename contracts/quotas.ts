export interface QuotaError {
    note?: string;
    status: "not_configured" | "error";
}

export interface OpenRouterQuota {
    limit: number | undefined;
    limitRemaining: number | undefined;
    limitReset: string | undefined;
    percentUsed: number | undefined;
    remaining: number;
    totalCredits: number;
    usage: number;
    usageMonthly: number;
}

export interface ElevenLabsQuota {
    percentUsed: number | undefined;
    remaining: number;
    resetAt: string | undefined;
    tier: string;
    total: number;
    used: number;
}

export interface OpenAiQuota {
    account: string | undefined;
    fiveHourLeftPercent: number | undefined;
    fiveHourReset: string | undefined;
    model: string | undefined;
    percentUsed: number;
    resetAt: string | undefined;
    weeklyLeftPercent: number;
    weeklyReset: string | undefined;
}

export interface SyntheticQuota {
    rollingFiveHourLimit: {
        limited: boolean;
        max: number;
        nextTickAt: string | undefined;
        percentUsed: number | undefined;
        remaining: number;
        tickPercent?: number;
    };
    searchHourly: {
        limit: number;
        percentUsed: number | undefined;
        remaining: number;
        renewsAt: string | undefined;
        requests: number;
    };
    subscription: {
        limit: number;
        percentUsed: number | undefined;
        remaining: number;
        renewsAt: string | undefined;
        requests: number;
    };
    weeklyTokenLimit: {
        maxCredits?: string;
        nextRegenAt: string | undefined;
        nextRegenCredits?: string;
        nextRegenPercent?: number;
        percentRemaining: number;
        remainingCredits?: string;
    };
}

export interface QuotasResponse {
    cacheAgeMs: number;
    checkedAt: number;
    elevenlabs: ElevenLabsQuota | QuotaError;
    openai: OpenAiQuota | QuotaError;
    openrouter: OpenRouterQuota | QuotaError;
    synthetic: SyntheticQuota | QuotaError;
}
