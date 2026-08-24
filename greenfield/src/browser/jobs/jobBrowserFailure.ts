import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
} from "../api/trpcError.ts";

/**
 * @param error Unknown rejection.
 * @returns Fixed jobs-domain failure text without exposing server-controlled content.
 */
export function jobBrowserFailureMessage(error: unknown): string {
    switch (classifyDashboardBrowserFailure(error)) {
        case "conflict": {
            return "The job state changed. Refresh the page and try again.";
        }
        case "not-found": {
            return "The selected job record no longer exists.";
        }
        default: {
            return dashboardBrowserFailureMessage(error);
        }
    }
}
