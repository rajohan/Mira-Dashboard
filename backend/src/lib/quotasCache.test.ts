import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { clearCacheEntries, insertCacheEntry } from "../testUtils/cacheFixtures.js";
import { fetchCachedQuotas, hasQuotaStatus } from "./quotasCache.js";

function insertQuotas(data: unknown, status = "fresh"): void {
    insertCacheEntry({
        key: "quotas.summary",
        data,
        source: "quotas",
        status,
    });
}

describe("quota cache helpers", () => {
    beforeEach(() => {
        clearCacheEntries();
    });

    it("maps fresh quota summary cache rows and recomputes cache age", async () => {
        insertQuotas({
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
        });

        const quotas = await fetchCachedQuotas();

        assert.deepEqual(quotas.openrouter, {
            usage: 4,
            totalCredits: 10,
            remaining: 6,
            usageMonthly: 4,
            percentUsed: 40,
        });
        assert.deepEqual(quotas.elevenlabs, {
            used: 100,
            total: 1000,
            remaining: 900,
            tier: "creator",
            percentUsed: 10,
            resetAt: "2026-06-01T00:00:00.000Z",
        });
        assert.equal(hasQuotaStatus(quotas.synthetic), true);
        assert.equal(hasQuotaStatus(quotas.openrouter), false);
        assert.ok(quotas.cacheAgeMs >= 0);
    });

    it("rejects missing, stale, and invalid quota cache rows", async () => {
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache entry not found or not fresh",
        });

        insertQuotas({ checkedAt: Date.now() }, "stale");
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache entry not found or not fresh",
        });

        insertQuotas("not-json");
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache payload is invalid",
        });
    });
});
