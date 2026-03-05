import express, { type RequestHandler } from "express";

interface OpenRouterQuota {
    usage: number;
    totalCredits: number;
    remaining: number;
    usageMonthly: number;
    percentUsed: number | null;
}

interface ElevenLabsQuota {
    used: number;
    total: number;
    remaining: number;
    tier: string;
    percentUsed: number | null;
}

interface ZaiQuota {
    level: string;
    fiveHour: {
        usedPercentage: number;
        resetAt: string;
    };
    weekly: {
        usedPercentage: number;
        resetAt: string;
    };
}

interface OpenAiQuota {
    monthUsd: number;
    hardLimitUsd: number | null;
    remainingUsd: number | null;
    percentUsed: number | null;
    resetAt: string | null;
}

export interface QuotasResponse {
    openrouter: OpenRouterQuota | { status: "not_configured" | "error"; note?: string };
    elevenlabs: ElevenLabsQuota | { status: "not_configured" | "error"; note?: string };
    zai: ZaiQuota | { status: "not_configured" | "error"; note?: string };
    openai: OpenAiQuota | { status: "not_configured" | "error"; note?: string };
    checkedAt: number;
    cacheAgeMs: number;
}

const CACHE_TTL_MS = 60_000;
let cache: { value: QuotasResponse; fetchedAt: number } | null = null;

function toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toIsoFromUnixSeconds(value: number | null | undefined): string | null {
    if (!value || !Number.isFinite(value) || value <= 0) return null;
    return new Date(value * 1000).toISOString();
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
}

async function checkOpenRouter(): Promise<QuotasResponse["openrouter"]> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return { status: "not_configured" };

    try {
        const [keyInfo, creditsInfo] = await Promise.all([
            fetchJson("https://openrouter.ai/api/v1/key", {
                Authorization: `Bearer ${apiKey}`,
            }) as Promise<{ data?: { usage?: number; usage_monthly?: number } }>,
            fetchJson("https://openrouter.ai/api/v1/credits", {
                Authorization: `Bearer ${apiKey}`,
            }) as Promise<{ data?: { total_credits?: number } }>,
        ]);

        const usage = toNumber(keyInfo?.data?.usage);
        const totalCredits = toNumber(creditsInfo?.data?.total_credits);
        const remaining = Math.max(totalCredits - usage, 0);
        const usageMonthly = toNumber(keyInfo?.data?.usage_monthly);
        const percentUsed = totalCredits > 0 ? Math.round((usage / totalCredits) * 100) : null;

        return {
            usage,
            totalCredits,
            remaining,
            usageMonthly,
            percentUsed,
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

async function checkElevenLabs(): Promise<QuotasResponse["elevenlabs"]> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return { status: "not_configured" };

    try {
        const data = (await fetchJson("https://api.elevenlabs.io/v1/user", {
            "xi-api-key": apiKey,
        })) as {
            subscription?: { character_count?: number; character_limit?: number; tier?: string };
        };

        const used = toNumber(data.subscription?.character_count);
        const total = toNumber(data.subscription?.character_limit);
        const remaining = Math.max(total - used, 0);
        const percentUsed = total > 0 ? Math.round((used / total) * 100) : null;

        return {
            used,
            total,
            remaining,
            tier: data.subscription?.tier || "unknown",
            percentUsed,
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

async function checkZai(): Promise<QuotasResponse["zai"]> {
    const apiKey = process.env.ZAI_API_KEY;
    if (!apiKey) return { status: "not_configured" };

    try {
        const data = (await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
            Authorization: `Bearer ${apiKey}`,
            Refer: "https://z.ai",
        })) as {
            data?: {
                level?: string;
                limits?: Array<{
                    type?: string;
                    unit?: number;
                    number?: number;
                    percentage?: number;
                    nextResetTime?: number;
                }>;
            };
        };

        const limits = (data.data?.limits || []).filter((entry) => entry.type === "TOKENS_LIMIT");
        const fiveHour = limits.find((entry) => entry.unit === 3 && entry.number === 5);
        const weekly = limits.find((entry) => entry.unit === 6 && entry.number === 1);

        return {
            level: data.data?.level || "unknown",
            fiveHour: {
                usedPercentage: toNumber(fiveHour?.percentage),
                resetAt: fiveHour?.nextResetTime
                    ? new Date(fiveHour.nextResetTime).toISOString()
                    : "unknown",
            },
            weekly: {
                usedPercentage: toNumber(weekly?.percentage),
                resetAt: weekly?.nextResetTime ? new Date(weekly.nextResetTime).toISOString() : "unknown",
            },
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

async function checkOpenAi(): Promise<QuotasResponse["openai"]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { status: "not_configured" };

    try {
        const now = new Date();
        const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);

        const [costsData, subscriptionData] = await Promise.all([
            fetchJson(
                `https://api.openai.com/v1/organization/costs?start_time=${monthStart}&bucket_width=1d`,
                {
                    Authorization: `Bearer ${apiKey}`,
                }
            ) as Promise<{
                data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>;
            }>,
            fetchJson("https://api.openai.com/v1/dashboard/billing/subscription", {
                Authorization: `Bearer ${apiKey}`,
            }).catch(() => ({}) as unknown) as Promise<{
                hard_limit_usd?: number;
                access_until?: number;
            }>,
        ]);

        let monthUsd = 0;
        for (const bucket of costsData.data || []) {
            for (const result of bucket.results || []) {
                monthUsd += toNumber(result.amount?.value);
            }
        }

        const hardLimitUsd =
            typeof subscriptionData.hard_limit_usd === "number"
                ? subscriptionData.hard_limit_usd
                : null;
        const remainingUsd = hardLimitUsd === null ? null : Math.max(hardLimitUsd - monthUsd, 0);
        const percentUsed =
            hardLimitUsd && hardLimitUsd > 0 ? Math.round((monthUsd / hardLimitUsd) * 100) : null;

        return {
            monthUsd: Math.round(monthUsd * 100) / 100,
            hardLimitUsd,
            remainingUsd: remainingUsd === null ? null : Math.round(remainingUsd * 100) / 100,
            percentUsed,
            resetAt: toIsoFromUnixSeconds(subscriptionData.access_until),
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

export function hasQuotaStatus(value: unknown): value is { status: "not_configured" | "error"; note?: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}

export async function fetchQuotas(): Promise<QuotasResponse> {
    const [openrouter, elevenlabs, zai, openai] = await Promise.all([
        checkOpenRouter(),
        checkElevenLabs(),
        checkZai(),
        checkOpenAi(),
    ]);

    return {
        openrouter,
        elevenlabs,
        zai,
        openai,
        checkedAt: Date.now(),
        cacheAgeMs: 0,
    };
}

export default function quotasRoutes(app: express.Application): void {
    app.get("/api/quotas", (async (_req, res) => {
        try {
            const now = Date.now();

            if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
                res.json({ ...cache.value, cacheAgeMs: now - cache.fetchedAt } satisfies QuotasResponse);
                return;
            }

            const value = await fetchQuotas();
            cache = { value, fetchedAt: Date.now() };
            res.json(value);
        } catch (error) {
            if (cache) {
                const now = Date.now();
                res.json({ ...cache.value, cacheAgeMs: now - cache.fetchedAt } satisfies QuotasResponse);
                return;
            }

            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
