import * as v from "valibot";

import { compareStrings, hasUniqueArrayItems } from "../shared/validation.ts";
import {
    jobIdempotencyKeySchema,
    jobRunIdSchema,
    jobRunSummarySchema,
    jobTimestampSchema,
} from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";

/** Fixed privileged operations accepted by the purpose-built service-actions boundary. */
export const serviceActionIds = [
    "dashboard-restart",
    "dashboard-stack-restart",
    "openclaw-cleanup",
    "openclaw-restart",
    "openclaw-update",
    "system-cleanup",
    "system-restart",
    "system-update",
    "worker-restart",
] as const;

export const serviceActionIdSchema = v.picklist(
    serviceActionIds,
    "Service action id is invalid"
);

export const serviceActionAvailabilitySchema = v.picklist(
    ["available", "unavailable"],
    "Service action availability is invalid"
);

const serviceActionStatusSchema = v.strictObject({
    activeRun: v.optional(jobRunSummarySchema),
    availability: serviceActionAvailabilitySchema,
    id: serviceActionIdSchema,
    latestRun: v.optional(jobRunSummarySchema),
});

type ServiceActionStatusValue = v.InferOutput<typeof serviceActionStatusSchema>;

/**
 * @param actions Fixed status rows to validate.
 * @returns Whether the fixed action inventory is complete, unique, and canonical.
 */
export function serviceActionStatusesAreCanonical(
    actions: ServiceActionStatusValue[]
): boolean {
    return (
        actions.length === serviceActionIds.length &&
        hasUniqueArrayItems(actions.map(({ id }) => id)) &&
        actions.every(
            ({ id }, index) =>
                id === serviceActionIds[index] &&
                (index === 0 || compareStrings(actions[index - 1]?.id ?? "", id) < 0)
        )
    );
}

export const getServiceActionsStatusInputSchema = v.strictObject({});

export const getServiceActionsStatusResultSchema = v.strictObject({
    actions: v.pipe(
        v.array(serviceActionStatusSchema, "Service action statuses are invalid"),
        v.maxLength(
            serviceActionIds.length,
            "Service action statuses are outside their budget"
        ),
        v.check(
            serviceActionStatusesAreCanonical,
            "Service action statuses are not canonical"
        )
    ),
    observedAtMs: jobTimestampSchema,
});

const serviceActionRequestBase = {
    idempotencyKey: jobIdempotencyKeySchema,
};

export const requestServiceActionInputSchema = v.variant("actionId", [
    v.strictObject({
        actionId: v.literal("dashboard-restart"),
        confirmation: v.literal(
            "restart-dashboard",
            "Dashboard restart confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("dashboard-stack-restart"),
        confirmation: v.literal(
            "restart-dashboard-stack",
            "Dashboard stack restart confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("openclaw-cleanup"),
        confirmation: v.literal(
            "cleanup-openclaw",
            "OpenClaw cleanup confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("openclaw-restart"),
        confirmation: v.literal(
            "restart-openclaw",
            "OpenClaw restart confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("openclaw-update"),
        confirmation: v.literal(
            "update-openclaw",
            "OpenClaw update confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("system-cleanup"),
        confirmation: v.literal(
            "cleanup-system",
            "System cleanup confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("system-restart"),
        confirmation: v.literal(
            "restart-system",
            "System restart confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("system-update"),
        confirmation: v.literal("update-system", "System update confirmation is invalid"),
        ...serviceActionRequestBase,
    }),
    v.strictObject({
        actionId: v.literal("worker-restart"),
        confirmation: v.literal(
            "restart-worker",
            "Worker restart confirmation is invalid"
        ),
        ...serviceActionRequestBase,
    }),
]);

export const requestServiceActionResultSchema = v.strictObject({
    actionId: serviceActionIdSchema,
    jobRunId: jobRunIdSchema,
    queued: v.literal(true, "Service action queue result is invalid"),
});

export type ServiceActionId = v.InferOutput<typeof serviceActionIdSchema>;
export type ServiceActionStatus = v.InferOutput<typeof serviceActionStatusSchema>;
export type GetServiceActionsStatusResult = v.InferOutput<
    typeof getServiceActionsStatusResultSchema
>;
export type RequestServiceActionInput = v.InferOutput<
    typeof requestServiceActionInputSchema
>;
export type RequestServiceActionResult = v.InferOutput<
    typeof requestServiceActionResultSchema
>;

const readAccess = {
    capabilities: ["service-actions:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const controlAccess = {
    capabilities: ["service-actions:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;

/** Session-only status and recent-MFA fixed-operation request metadata. */
export const serviceActionProcedureContracts = [
    {
        access: readAccess,
        domain: "service-actions",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: getServiceActionsStatusInputSchema,
        inputSchemaId: "serviceActions.getStatus.input",
        kind: "query",
        name: "serviceActions.getStatus",
        output: getServiceActionsStatusResultSchema,
        outputSchemaId: "serviceActions.getStatus.output",
        summary:
            "Returns bounded availability and durable-run observations for fixed privileged service actions.",
        transport: {
            batching: "adapter-default",
            handler: "default",
            requestBody: "default",
        },
    },
    {
        access: controlAccess,
        domain: "service-actions",
        errorReasons: [
            "mfa_enrollment_required",
            "operation_outcome_unknown",
            "step_up_required",
        ],
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: requestServiceActionInputSchema,
        inputSchemaId: "serviceActions.request.input",
        kind: "mutation",
        name: "serviceActions.request",
        output: requestServiceActionResultSchema,
        outputSchemaId: "serviceActions.request.output",
        summary:
            "Queues one exact worker-owned service action after recent-MFA authorization and durable audit admission.",
        transport: {
            batching: "forbidden",
            handler: "default",
            requestBody: "default",
        },
    },
] as const satisfies readonly ProcedureContract[];
