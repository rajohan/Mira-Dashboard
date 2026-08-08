import type { CacheEntryStatus } from "../../contracts/cache.ts";
import {
    classifyDashboardBrowserFailure,
    type DashboardBrowserFailure,
} from "../api/trpcError.ts";

const byteUnits = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

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
 * @param status Latest refresh attempt outcome.
 * @returns The shared badge tone for the latest refresh attempt outcome.
 */
export function cacheAttemptVariant(
    status: CacheEntryStatus["lastAttemptStatus"]
): "danger" | "success" {
    return status === "succeeded" ? "success" : "danger";
}

/**
 * Formats a nonnegative byte count without exposing locale- or host-specific state.
 * @param bytes Validated cache byte count.
 * @returns Compact binary-capacity label.
 */
export function formatCacheBytes(bytes: number): string {
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < byteUnits.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${byteUnits[unitIndex]}`;
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

/**
 * Formats validated host uptime without relying on wall-clock state.
 * @param seconds Whole uptime seconds.
 * @returns Human-readable bounded uptime.
 */
export function formatCacheUptime(seconds: number): string {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

const cacheFailureMessages: Readonly<Record<DashboardBrowserFailure, string>> = {
    cancelled: "The cache request was cancelled. You can try again.",
    conflict:
        "The cache refresh state changed. Review the current run and try again if needed.",
    forbidden: "This session is not permitted to access that cache operation.",
    "invalid-request": "The cache request was rejected. Refresh the page and try again.",
    "mfa-enrollment-required":
        "Multi-factor authentication must be enrolled before this action.",
    "not-found": "The selected cache entry is no longer available.",
    protocol:
        "The server returned an invalid cache response. Reload before trying again.",
    "rate-limited": "Too many cache requests were made. Wait before trying again.",
    "step-up-required": "Verify your identity again before refreshing this cache entry.",
    unauthorized: "The credentials or session are no longer valid.",
    unavailable: "Cache data is temporarily unavailable. Try again shortly.",
    unknown: "The cache request could not be completed. Try again.",
};

/**
 * Maps untrusted transport failures to fixed cache-specific operator text.
 * @param error Unknown transport rejection.
 * @returns Safe browser-facing cache message.
 */
export function cacheBrowserFailureMessage(error: unknown): string {
    return cacheFailureMessages[classifyDashboardBrowserFailure(error)];
}
