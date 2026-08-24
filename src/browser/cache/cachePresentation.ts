import type { CacheEntryStatus } from "../../contracts/cache.ts";
import {
    classifyDashboardBrowserFailure,
    type DashboardBrowserFailure,
} from "../api/trpcError.ts";
export {
    formatByteCount as formatCacheBytes,
    formatUptime as formatCacheUptime,
} from "../lib/formatMeasurements.ts";

/**
 * @param freshness Independently derived cache freshness.
 * @returns The shared badge tone for one independently derived freshness state.
 */
export function cacheFreshnessVariant(
    freshness: CacheEntryStatus["freshness"]
): "default" | "success" | "warning" {
    if (freshness === "fresh") return "success";
    if (freshness === "stale") return "warning";
    return "default";
}

/**
 * @param freshness Stored freshness value.
 * @returns A plain-language label without changing the stored freshness value.
 */
export function cacheFreshnessLabel(freshness: CacheEntryStatus["freshness"]): string {
    if (freshness === "fresh") return "Up to date";
    if (freshness === "stale") return "Out of date";
    return "No saved data";
}

/**
 * @param status Latest refresh attempt outcome.
 * @returns The shared badge tone for the latest refresh attempt outcome.
 */
export function cacheAttemptVariant(
    status: CacheEntryStatus["lastAttemptStatus"]
): "danger" | "success" {
    return status === "succeeded" ? "success" : "danger";
}

/**
 * @param status Stored attempt value.
 * @returns A plain-language label without changing the stored attempt value.
 */
export function cacheAttemptLabel(status: CacheEntryStatus["lastAttemptStatus"]): string {
    return status === "succeeded" ? "Succeeded" : "Failed";
}

/**
 * Formats a nonnegative duration for concise operator metadata.
 * @param milliseconds Validated duration in milliseconds.
 * @returns Compact duration label.
 */
export function formatCacheDuration(milliseconds: number): string {
    if (milliseconds < 1000) return `${milliseconds} ms`;
    const seconds = milliseconds / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

const cacheFailureMessages: Readonly<Record<DashboardBrowserFailure, string>> = {
    cancelled: "The request was cancelled. You can try again.",
    conflict:
        "The refresh changed while this page was updating. Check the background job and try again if needed.",
    forbidden: "You do not have permission to refresh this data.",
    "invalid-request": "The request was rejected. Refresh the page and try again.",
    "mfa-enrollment-required":
        "Multi-factor authentication must be enrolled before this action.",
    "not-found": "The selected data source is no longer available.",
    protocol: "The server returned unexpected saved data. Reload before trying again.",
    "rate-limited": "Too many refresh requests were made. Wait before trying again.",
    "step-up-required": "Verify your identity again before refreshing this data.",
    unauthorized: "Your session has ended. Sign in again.",
    unavailable: "Saved data is temporarily unavailable. Try again shortly.",
    unknown: "The request could not be completed. Try again.",
};

/**
 * Maps untrusted transport failures to fixed cache-specific operator text.
 * @param error Unknown transport rejection.
 * @returns Safe browser-facing cache message.
 */
export function cacheBrowserFailureMessage(error: unknown): string {
    return cacheFailureMessages[classifyDashboardBrowserFailure(error)];
}
