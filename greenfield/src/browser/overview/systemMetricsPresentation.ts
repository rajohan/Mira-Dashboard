import {
    classifyDashboardBrowserFailure,
    type DashboardBrowserFailure,
} from "../api/trpcError.ts";

const systemMetricsFailureMessages: Readonly<Record<DashboardBrowserFailure, string>> = {
    cancelled: "The system metrics request was cancelled. You can try again.",
    conflict: "System metric state changed. Try the request again.",
    forbidden: "This browser session is not permitted to read system metrics.",
    "invalid-request": "The system metrics request was rejected. Reload the page.",
    "mfa-enrollment-required":
        "Multi-factor authentication must be enrolled before this request.",
    "not-found": "The system metrics procedure is not available in this release.",
    protocol:
        "The server returned an invalid system metrics response. Reload before retrying.",
    "rate-limited": "Too many system metrics requests were made. Wait before retrying.",
    "step-up-required": "Verify your identity again before reading system metrics.",
    unauthorized: "The credentials or browser session are no longer valid.",
    unavailable: "System metrics are temporarily unavailable. Try again shortly.",
    unknown: "The system metrics request could not be completed. Try again.",
};

/**
 * @param error - Unknown browser transport failure.
 * @returns Fixed metrics-specific text without untrusted transport details.
 */
export function systemMetricsFailureMessage(error: unknown): string {
    return systemMetricsFailureMessages[classifyDashboardBrowserFailure(error)];
}
