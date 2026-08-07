import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedNonBlankTextSchema,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";
import {
    applicationCapabilityListSchema,
    automationPrincipalIdSchema,
    opaqueSelectorSchema,
    securityRecordIdSchema,
} from "./security.ts";

/** Default number of immutable audit events returned to the operator. */
export const securityAuditPageDefault = 20;

/** Hard response-row budget for the security audit inventory. */
export const securityAuditPageMaximum = 50;

export const securityAuditReasonValues = [
    "gateway_unavailable",
    "identity_changed",
    "invalid_credentials",
    "invalid_current_password",
    "invalid_gateway",
    "recovery_invalid",
    "recovery_pending_invalid",
    "totp_invalid",
    "totp_pending_invalid",
    "webauthn_configuration_mismatch",
    "webauthn_invalid",
    "webauthn_pending_invalid",
] as const;

const securityAuditTimestampSchema = timestampMillisecondsSchema(
    "Security audit timestamp is invalid"
);
const securityAuditNameSchema = v.pipe(
    v.string("Security audit name is invalid"),
    v.minLength(1, "Security audit name is invalid"),
    v.maxLength(128, "Security audit name is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Security audit name is invalid")
);
const securityAuditCountSchema = nonnegativeSafeIntegerSchema(
    "Security audit count is invalid"
);

export const securityAuditPageLimitSchema = v.pipe(
    v.number("Security audit page limit is invalid"),
    v.safeInteger("Security audit page limit is invalid"),
    v.minValue(1, "Security audit page limit is invalid"),
    v.maxValue(
        securityAuditPageMaximum,
        "Security audit page limit is outside its budget"
    )
);

/** Stable newest-first cursor over immutable audit event time and identity. */
export const securityAuditCursorSchema = v.strictObject({
    id: securityRecordIdSchema,
    occurredAtMs: securityAuditTimestampSchema,
});

/** Explicitly redacted metadata fields permitted on public audit summaries. */
export const securityAuditMetadataSchema = v.strictObject({
    addedCapabilities: v.optional(applicationCapabilityListSchema),
    method: v.optional(v.picklist(["password", "recovery", "totp", "webauthn"])),
    pendingMfa: v.optional(v.boolean()),
    predecessorCredentialId: v.optional(securityRecordIdSchema),
    reason: v.optional(v.picklist(securityAuditReasonValues)),
    removedCapabilities: v.optional(applicationCapabilityListSchema),
    replacementCredentialId: v.optional(securityRecordIdSchema),
    revoked: v.optional(v.boolean()),
    revokedCredentials: v.optional(securityAuditCountSchema),
    revokedSessions: v.optional(securityAuditCountSchema),
});

const anonymousAuditActorSchema = v.strictObject({
    id: boundedNonBlankTextSchema(128, "Security audit actor is invalid"),
    kind: v.literal("anonymous"),
});
const automationAuditActorSchema = v.strictObject({
    authenticatorId: securityRecordIdSchema,
    id: automationPrincipalIdSchema,
    kind: v.literal("automation"),
});
const systemAuditActorSchema = v.strictObject({
    id: boundedNonBlankTextSchema(128, "Security audit actor is invalid"),
    kind: v.literal("system"),
});
const userAuditActorSchema = v.strictObject({
    authenticatorId: opaqueSelectorSchema,
    id: securityRecordIdSchema,
    kind: v.literal("user"),
});

export const securityAuditActorSchema = v.variant("kind", [
    anonymousAuditActorSchema,
    automationAuditActorSchema,
    systemAuditActorSchema,
    userAuditActorSchema,
]);

export const securityAuditTargetSchema = v.strictObject({
    id: boundedNonBlankTextSchema(256, "Security audit target is invalid"),
    type: v.pipe(
        securityAuditNameSchema,
        v.maxLength(64, "Security audit target is invalid")
    ),
});

export const securityAuditEventSummarySchema = v.strictObject({
    action: securityAuditNameSchema,
    actor: securityAuditActorSchema,
    id: securityRecordIdSchema,
    metadata: securityAuditMetadataSchema,
    occurredAtMs: securityAuditTimestampSchema,
    outcome: v.picklist([
        "accepted",
        "attempted",
        "cancelled",
        "denied",
        "failed",
        "succeeded",
    ]),
    requestId: v.optional(
        boundedNonBlankTextSchema(128, "Security audit request id is invalid")
    ),
    target: securityAuditTargetSchema,
});

type SecurityAuditEventSummaryValue = v.InferOutput<
    typeof securityAuditEventSummarySchema
>;

function eventFollowsInNewestFirstOrder(
    previous: SecurityAuditEventSummaryValue,
    current: SecurityAuditEventSummaryValue
): boolean {
    return (
        current.occurredAtMs < previous.occurredAtMs ||
        (current.occurredAtMs === previous.occurredAtMs && current.id < previous.id)
    );
}

export function securityAuditEventsHaveStableOrder(
    events: SecurityAuditEventSummaryValue[]
): boolean {
    for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1];
        const current = events[index];
        if (
            previous === undefined ||
            current === undefined ||
            !eventFollowsInNewestFirstOrder(previous, current)
        ) {
            return false;
        }
    }
    return true;
}

const securityAuditEventPageSchema = v.pipe(
    v.array(securityAuditEventSummarySchema, "Security audit event page is invalid"),
    v.maxLength(
        securityAuditPageMaximum,
        "Security audit event page is outside its budget"
    ),
    v.check(
        securityAuditEventsHaveStableOrder,
        "Security audit event page order is invalid"
    )
);

export const listSecurityAuditEventsInputSchema = v.strictObject({
    cursor: v.optional(securityAuditCursorSchema),
    limit: v.optional(securityAuditPageLimitSchema, securityAuditPageDefault),
});

const listSecurityAuditEventsResultObjectSchema = v.strictObject({
    events: securityAuditEventPageSchema,
    nextCursor: v.optional(securityAuditCursorSchema),
});

type ListSecurityAuditEventsResultValue = v.InferOutput<
    typeof listSecurityAuditEventsResultObjectSchema
>;

export function securityAuditPageCursorIsConsistent(
    result: ListSecurityAuditEventsResultValue
): boolean {
    if (result.nextCursor === undefined) return true;
    const last = result.events.at(-1);
    return (
        last !== undefined &&
        result.nextCursor.occurredAtMs === last.occurredAtMs &&
        result.nextCursor.id === last.id
    );
}

export const listSecurityAuditEventsResultSchema = v.pipe(
    listSecurityAuditEventsResultObjectSchema,
    v.check(
        securityAuditPageCursorIsConsistent,
        "Security audit continuation cursor is inconsistent"
    )
);

const sessionAccess = {
    capabilities: [],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const authenticationReadTransport = {
    batching: "adapter-default",
    handler: "authentication",
    requestBody: "authentication",
} as const;

/** Browser-session-only immutable security audit procedure metadata. */
export const securityAuditProcedureContracts = [
    {
        access: sessionAccess,
        domain: "securityAudit",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listSecurityAuditEventsInputSchema,
        inputSchemaId: "securityAudit.listEvents.input",
        kind: "query",
        name: "securityAudit.listEvents",
        output: listSecurityAuditEventsResultSchema,
        outputSchemaId: "securityAudit.listEvents.output",
        summary: "Lists redacted immutable security events in stable newest-first order.",
        transport: authenticationReadTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type ListSecurityAuditEventsInput = v.InferOutput<
    typeof listSecurityAuditEventsInputSchema
>;
export type ListSecurityAuditEventsResult = v.InferOutput<
    typeof listSecurityAuditEventsResultSchema
>;
export type SecurityAuditEventSummary = v.InferOutput<
    typeof securityAuditEventSummarySchema
>;
export type SecurityAuditMetadata = v.InferOutput<typeof securityAuditMetadataSchema>;
