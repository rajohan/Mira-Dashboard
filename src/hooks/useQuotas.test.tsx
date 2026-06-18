import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { hasQuotaStatus, useQuotas } from "./useQuotas";

describe("quota hooks", () => {
    it("fetches quotas and unwraps cache entry data", async () => {
        const quotaData = {
            openrouter: {
                usage: 10,
                totalCredits: 100,
                remaining: 90,
                usageMonthly: 50,
                percentUsed: 10,
            },
            elevenlabs: {
                used: 100,
                total: 500,
                remaining: 400,
                tier: "starter",
                percentUsed: 20,
                resetAt: undefined,
            },
            synthetic: {
                subscription: {
                    limit: 1000,
                    requests: 100,
                    remaining: 900,
                    renewsAt: undefined,
                    percentUsed: 10,
                },
                searchHourly: {
                    limit: 50,
                    requests: 5,
                    remaining: 45,
                    renewsAt: undefined,
                    percentUsed: 10,
                },
                weeklyTokenLimit: { percentRemaining: 80, nextRegenAt: undefined },
                rollingFiveHourLimit: {
                    remaining: 100,
                    max: 200,
                    limited: false,
                    nextTickAt: undefined,
                    percentUsed: 50,
                },
            },
            openai: {
                account: "test",
                model: "codex",
                fiveHourLeftPercent: 80,
                weeklyLeftPercent: 90,
                fiveHourReset: undefined,
                weeklyReset: undefined,
                percentUsed: 15,
                resetAt: undefined,
            },
            checkedAt: Date.now(),
            cacheAgeMs: 0,
        };
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                key: "quotas.summary",
                data: quotaData,
                cachedAt: "2026-01-01",
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useQuotas(), {
            wrapper: createQueryWrapper(),
        });
        await waitFor(() =>
            expect(
                (result.current.data?.openrouter as { remaining: number })?.remaining
            ).toBe(90)
        );
    });

    it("hasQuotaStatus identifies error states", () => {
        expect(hasQuotaStatus({ status: "not_configured" })).toBe(true);
        expect(hasQuotaStatus({ status: "error" })).toBe(true);
        expect(hasQuotaStatus({ status: "ok" })).toBe(false);
        expect(hasQuotaStatus({ usage: 10, totalCredits: 100 })).toBe(false);
        expect(hasQuotaStatus(undefined)).toBe(false);
    });
});
