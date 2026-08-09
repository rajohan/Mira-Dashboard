import { describe, expect, test } from "bun:test";

import { DashboardProtocolError } from "../api/trpcClient.ts";
import {
    cacheAttemptLabel,
    cacheAttemptVariant,
    cacheBrowserFailureMessage,
    cacheFreshnessLabel,
    cacheFreshnessVariant,
    formatCacheBytes,
    formatCacheDuration,
    formatCacheUptime,
} from "./cachePresentation.ts";

describe("cache presentation", () => {
    test("keeps freshness and attempt outcomes visually independent", () => {
        expect(cacheFreshnessVariant("fresh")).toBe("success");
        expect(cacheFreshnessVariant("stale")).toBe("warning");
        expect(cacheFreshnessVariant("missing")).toBe("default");
        expect(cacheAttemptVariant("succeeded")).toBe("success");
        expect(cacheAttemptVariant("failed")).toBe("danger");
        expect(cacheFreshnessLabel("fresh")).toBe("Up to date");
        expect(cacheFreshnessLabel("stale")).toBe("Out of date");
        expect(cacheFreshnessLabel("missing")).toBe("No saved data");
        expect(cacheAttemptLabel("succeeded")).toBe("Succeeded");
        expect(cacheAttemptLabel("failed")).toBe("Failed");
    });

    test("formats bounded capacity, attempt duration, and uptime", () => {
        expect(formatCacheBytes(0)).toBe("0 B");
        expect(formatCacheBytes(1536)).toBe("1.5 KiB");
        expect(formatCacheBytes(10 * 1024 ** 3)).toBe("10 GiB");
        expect(formatCacheDuration(950)).toBe("950 ms");
        expect(formatCacheDuration(1500)).toBe("1.5 s");
        expect(formatCacheDuration(12_400)).toBe("12 s");
        expect(formatCacheUptime(59)).toBe("0m");
        expect(formatCacheUptime(7380)).toBe("2h 3m");
        expect(formatCacheUptime(183_600)).toBe("2d 3h");
    });

    test("never renders an untrusted transport message", () => {
        const secret = "do-not-render-this-secret";
        expect(cacheBrowserFailureMessage(new TypeError(secret))).toBe(
            "The request could not be completed. Try again."
        );
        expect(cacheBrowserFailureMessage(new DashboardProtocolError())).toBe(
            "The server returned unexpected saved data. Reload before trying again."
        );
        expect(cacheBrowserFailureMessage({ data: { code: "NOT_FOUND" } })).toBe(
            "The selected data source is no longer available."
        );
    });
});
