import * as v from "valibot";

import {
    contractAuthenticationErrorReasons,
    contractErrorCodes,
    contractOperationErrorReasons,
    type ContractAuthenticationErrorReason,
    type ContractErrorReason,
} from "../../contracts/registry.ts";

const dashboardClientErrorCodes = [
    ...contractErrorCodes,
    "CLIENT_CLOSED_REQUEST",
    "INTERNAL_SERVER_ERROR",
    "METHOD_NOT_SUPPORTED",
    "PARSE_ERROR",
    "TIMEOUT",
] as const;

export type DashboardClientErrorCode = (typeof dashboardClientErrorCodes)[number];

const dashboardTrpcFailureSchema = v.object({
    data: v.nullish(
        v.object({
            code: v.optional(v.picklist(dashboardClientErrorCodes)),
            reason: v.optional(
                v.picklist([
                    ...contractAuthenticationErrorReasons,
                    ...contractOperationErrorReasons,
                ])
            ),
        })
    ),
});

/** Strict allowlisted portion of one untrusted tRPC client rejection. */
export interface DashboardTrpcFailureData {
    readonly code: DashboardClientErrorCode | undefined;
    readonly reason: ContractErrorReason | undefined;
}

/**
 * Parses only fixed failure metadata used for browser control flow.
 * Server messages, paths, stacks, causes, and response bodies are never returned.
 * @param error Unknown transport rejection.
 * @returns Allowlisted failure metadata, if the rejection matches its schema.
 */
export function dashboardTrpcFailureData(
    error: unknown
): DashboardTrpcFailureData | undefined {
    const parsed = v.safeParse(dashboardTrpcFailureSchema, error);
    if (!parsed.success) return undefined;
    return Object.freeze({
        code: parsed.output.data?.code,
        reason: parsed.output.data?.reason,
    });
}

/**
 * @param error Unknown transport rejection.
 * @returns One exact authentication-policy reason from a genuine 403 failure.
 */
export function dashboardAuthenticationPolicyReason(
    error: unknown
): ContractAuthenticationErrorReason | undefined {
    const failure = dashboardTrpcFailureData(error);
    if (failure?.code !== "FORBIDDEN") return undefined;
    const { reason } = failure;
    return reason === "mfa_enrollment_required" || reason === "step_up_required"
        ? reason
        : undefined;
}
