import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
} from "../api/trpcError.ts";

/**
 * Maps untrusted terminal transport failures to fixed operator-facing copy.
 * Server messages, socket reasons, paths, and terminal contents are never rendered.
 * @param error Untrusted transport or procedure failure.
 * @returns Stable terminal failure copy.
 */
export function terminalFailureMessage(error: unknown): string {
    switch (classifyDashboardBrowserFailure(error)) {
        case "step-up-required": {
            return "Verify your identity again before opening an interactive terminal.";
        }
        case "mfa-enrollment-required": {
            return "Multi-factor authentication must be enrolled before Terminal can be used.";
        }
        case "conflict": {
            return "The terminal changed in another tab. Refresh its status before trying again.";
        }
        case "not-found": {
            return "The terminal session is no longer available.";
        }
        case "rate-limited": {
            return "Interactive terminal capacity is currently full. Try again shortly.";
        }
        default: {
            return dashboardBrowserFailureMessage(error);
        }
    }
}
