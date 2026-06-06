import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearCacheEntries, seedCacheEntry } from "../testUtils/cacheEntries.js";
import { fetchCachedQuotas, hasQuotaStatus } from "./quotasCache.js";

const quotasPayload = {
    openrouter: {
        usage: 4,
        totalCredits: 10,
        remaining: 6,
        usageMonthly: 4,
        percentUsed: 40,
    },
    elevenlabs: {
        used: 100,
        total: 1000,
        remaining: 900,
        tier: "creator",
        percentUsed: 10,
        resetAt: "2026-06-01T00:00:00.000Z",
    },
    synthetic: { status: "error", note: "offline" },
    openai: {
        account: "raymond",
        model: "gpt-5.5",
        fiveHourLeftPercent: 80,
        weeklyLeftPercent: 90,
        fiveHourReset: null,
        weeklyReset: null,
        percentUsed: 20,
        resetAt: null,
    },
    checkedAt: Date.now(),
    cacheAgeMs: 999,
};

describe("quota cache helpers", () => {
    beforeEach(() => {
        clearCacheEntries();
        seedCacheEntry({
            key: "quotas.summary",
            data: quotasPayload,
            source: "quotas",
        });
    });

    it("maps fresh quota summary cache rows and recomputes cache age", async () => {
        const quotas = await fetchCachedQuotas();

        assert.deepEqual(quotas.openrouter, quotasPayload.openrouter);
        assert.deepEqual(quotas.elevenlabs, quotasPayload.elevenlabs);
        assert.equal(hasQuotaStatus(quotas.synthetic), true);
        assert.equal(hasQuotaStatus(quotas.openrouter), false);
        assert.equal(quotas.cacheAgeMs >= 0, true);
    });

    it("rejects missing, stale, and invalid quota cache rows", async () => {
        clearCacheEntries();
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache entry not found or not fresh",
        });

        seedCacheEntry({
            key: "quotas.summary",
            data: quotasPayload,
            source: "quotas",
            status: "stale",
        });
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache entry not found or not fresh",
        });

        seedCacheEntry({
            key: "quotas.summary",
            data: "not-json",
            source: "quotas",
        });
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache payload is invalid",
        });
    });
});
