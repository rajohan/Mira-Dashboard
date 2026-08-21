import {
    classifyDashboardBrowserFailure,
    type DashboardBrowserFailure,
} from "../api/trpcError.ts";

const systemMetricsFailureMessages: Readonly<Record<DashboardBrowserFailure, string>> = {
    cancelled: "The system usage request was cancelled. You can try again.",
    conflict: "System usage changed while loading. Try again.",
    forbidden: "You do not have permission to view system usage.",
    "invalid-request": "The system usage request was rejected. Reload the page.",
    "mfa-enrollment-required":
        "Multi-factor authentication must be enrolled before this request.",
    "not-found": "System usage is not available in this version.",
    protocol: "The server returned unexpected system data. Reload before retrying.",
    "rate-limited": "Too many system usage requests were made. Wait before retrying.",
    "step-up-required": "Verify your identity again before viewing system usage.",
    unauthorized: "Your session has ended. Sign in again.",
    unavailable: "System usage is temporarily unavailable. Try again shortly.",
    unknown: "The system usage request could not be completed. Try again.",
};

/**
 * @param error - Unknown browser transport failure.
 * @returns Fixed metrics-specific text without untrusted transport details.
 */
export function systemMetricsFailureMessage(error: unknown): string {
    return systemMetricsFailureMessages[classifyDashboardBrowserFailure(error)];
}
