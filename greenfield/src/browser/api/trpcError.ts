import * as v from "valibot";

import {
    contractAuthenticationErrorReasons,
    contractErrorCodes,
    contractOperationErrorReasons,
} from "../../contracts/registry.ts";
import { DashboardProtocolError } from "./trpcClient.ts";

const clientErrorCodeSchema = v.picklist([
    ...contractErrorCodes,
    "CLIENT_CLOSED_REQUEST",
    "INTERNAL_SERVER_ERROR",
    "METHOD_NOT_SUPPORTED",
    "PARSE_ERROR",
    "TIMEOUT",
]);

const clientErrorSchema = v.object({
    data: v.nullish(
        v.object({
            code: v.optional(clientErrorCodeSchema),
            reason: v.optional(
                v.picklist([
                    ...contractAuthenticationErrorReasons,
                    ...contractOperationErrorReasons,
                ])
            ),
        })
    ),
});

/** Fixed browser-facing failure categories; no server message is rendered. */
export type DashboardBrowserFailure =
    | "cancelled"
    | "conflict"
    | "forbidden"
    | "invalid-request"
    | "mfa-enrollment-required"
    | "not-found"
    | "protocol"
    | "rate-limited"
    | "step-up-required"
    | "unauthorized"
    | "unavailable"
    | "unknown";

function isCancelledBrowserCeremony(error: unknown): boolean {
    return (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "NotAllowedError")
    );
}

/**
 * Classifies an untrusted transport or browser-ceremony failure without retaining
 * its message, response body, path, stack, or cause.
 * @param error Unknown rejection.
 * @returns One fixed browser failure category.
 */
export function classifyDashboardBrowserFailure(error: unknown): DashboardBrowserFailure {
    if (error instanceof DashboardProtocolError) return "protocol";
    if (isCancelledBrowserCeremony(error)) return "cancelled";

    const parsed = v.safeParse(clientErrorSchema, error);
    if (!parsed.success) return "unknown";
    const reason = parsed.output.data?.reason;
    if (reason === "mfa_enrollment_required") return "mfa-enrollment-required";
    if (reason === "step_up_required") return "step-up-required";

    switch (parsed.output.data?.code) {
        case "BAD_REQUEST":
        case "PARSE_ERROR": {
            return "invalid-request";
        }
        case "CLIENT_CLOSED_REQUEST": {
            return "cancelled";
        }
        case "CONFLICT":
        case "PRECONDITION_FAILED": {
            return "conflict";
        }
        case "FORBIDDEN": {
            return "forbidden";
        }
        case "NOT_FOUND": {
            return "not-found";
        }
        case "TOO_MANY_REQUESTS": {
            return "rate-limited";
        }
        case "UNAUTHORIZED": {
            return "unauthorized";
        }
        case "INTERNAL_SERVER_ERROR":
        case "METHOD_NOT_SUPPORTED":
        case "SERVICE_UNAVAILABLE":
        case "TIMEOUT": {
            return "unavailable";
        }
        case undefined: {
            return "unknown";
        }
    }
}

const browserFailureMessages: Readonly<Record<DashboardBrowserFailure, string>> = {
    cancelled: "The security prompt was cancelled. You can try again.",
    conflict: "The security state changed. Refresh the page and try again.",
    forbidden: "This session is not permitted to perform that action.",
    "invalid-request": "Check the entered values and try again.",
    "mfa-enrollment-required":
        "Multi-factor authentication must be enrolled before this action.",
    "not-found": "The selected security record no longer exists.",
    protocol: "The server returned an invalid response. Reload before trying again.",
    "rate-limited": "Too many attempts were made. Wait before trying again.",
    "step-up-required": "Verify your identity again before continuing.",
    unauthorized: "The credentials or session are no longer valid.",
    unavailable: "The Dashboard is temporarily unavailable. Try again shortly.",
    unknown: "The request could not be completed. Try again.",
};

/**
 * Detects the single allowlisted operation-outcome reason without exposing a
 * server-controlled message or broadening shared failure classifications.
 * @param error Unknown rejection.
 * @returns Whether the server explicitly reported an indeterminate operation outcome.
 */
export function isDashboardOperationOutcomeUnknown(error: unknown): boolean {
    const parsed = v.safeParse(clientErrorSchema, error);
    return parsed.success
        ? parsed.output.data?.reason === "operation_outcome_unknown"
        : false;
}

/** Maximum transient read failures tolerated while the shared Gateway reconnects. */
export const dashboardUnavailableReadRetryMaximum = 6;

/**
 * Retries only safe reads whose fixed browser classification is transiently unavailable.
 * Authentication, validation, protocol, and application conflicts remain fail-fast.
 * @param failureCount Number of failures already observed for this read.
 * @param error Unknown rejection.
 * @returns Whether TanStack Query may retry the read.
 */
export function retryDashboardUnavailableRead(
    failureCount: number,
    error: unknown
): boolean {
    return (
        failureCount < dashboardUnavailableReadRetryMaximum &&
        classifyDashboardBrowserFailure(error) === "unavailable"
    );
}

/**
 * Calculates a bounded reconnect-aware delay for safe read retries.
 * @param attemptIndex Zero-based retry index.
 * @returns Delay in milliseconds before the next attempt.
 */
export function dashboardUnavailableReadRetryDelay(attemptIndex: number): number {
    return Math.min(1000 * 2 ** Math.max(0, attemptIndex), 5000);
}

/**
 * Formats one fixed, non-sensitive browser message.
 * @param error Unknown rejection.
 * @returns Safe text suitable for an alert.
 */
export function dashboardBrowserFailureMessage(error: unknown): string {
    return browserFailureMessages[classifyDashboardBrowserFailure(error)];
}
