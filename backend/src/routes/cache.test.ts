import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    mapCacheRowForResponse,
    parseJsonFieldOrValue,
    refreshCacheKey,
} from "./cache.js";

const baseRow = {
    key: "quotas.summary",
    data: '{"usage":12}',
    source: "n8n",
    updated_at: "2026-05-10T19:00:00.000Z",
    last_attempt_at: "2026-05-10T19:01:00.000Z",
    expires_at: "2026-05-10T20:00:00.000Z",
    status: "fresh",
    error_code: "",
    error_message: "",
    consecutive_failures: "2",
    meta: '{"job":"quotas"}',
};

describe("cache route mapping helpers", () => {
    it("keeps scalar cache payloads when they are not JSON", () => {
        assert.equal(parseJsonFieldOrValue("plain text"), "plain text");
        assert.deepEqual(parseJsonFieldOrValue("[1,2]"), [1, 2]);
    });

    it("maps cache database rows into API response shape", () => {
        assert.deepEqual(mapCacheRowForResponse(baseRow), {
            key: "quotas.summary",
            source: "n8n",
            status: "fresh",
            updatedAt: "2026-05-10T19:00:00.000Z",
            lastAttemptAt: "2026-05-10T19:01:00.000Z",
            expiresAt: "2026-05-10T20:00:00.000Z",
            errorCode: null,
            errorMessage: null,
            consecutiveFailures: 2,
            data: { usage: 12 },
            meta: { job: "quotas" },
        });
    });

    it("defaults nullable row fields and invalid meta safely", () => {
        const mapped = mapCacheRowForResponse({
            ...baseRow,
            updated_at: "",
            last_attempt_at: "",
            expires_at: "",
            error_code: "E_CACHE",
            error_message: "Refresh failed",
            consecutive_failures: "",
            data: "raw output",
            meta: "not json",
        });

        assert.equal(mapped.updatedAt, null);
        assert.equal(mapped.lastAttemptAt, null);
        assert.equal(mapped.expiresAt, null);
        assert.equal(mapped.errorCode, "E_CACHE");
        assert.equal(mapped.errorMessage, "Refresh failed");
        assert.equal(mapped.consecutiveFailures, 0);
        assert.equal(mapped.data, "raw output");
        assert.deepEqual(mapped.meta, {});
    });

    it("rejects refresh requests for unconfigured cache keys before shelling out", async () => {
        await assert.rejects(() => refreshCacheKey("not.configured"), {
            message: "No refresh command configured for cache key: not.configured",
        });
    });
});
