import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";
import {
    applicationCapabilityListSchema,
    automationPrincipalIdSchema,
    opaqueSelectorSchema,
    opaqueTokenSchema,
    securityLabelSchema,
    securityRecordIdSchema,
} from "./security.ts";

/** Maximum number of enabled automation principals. Historical disabled rows remain paginated. */
export const activeAutomationPrincipalMaximum = 32;

/** Maximum number of simultaneously usable credentials for one automation principal. */
export const activeAutomationCredentialMaximumPerPrincipal = 4;

/** Default number of rows returned by automation-security list procedures. */
export const automationSecurityPageDefault = 20;

/** Hard response-row budget for automation-security list procedures. */
export const automationSecurityPageMaximum = 50;

const automationSecurityTimestampSchema = timestampMillisecondsSchema(
    "Automation-security timestamp is invalid"
);

export const automationSecurityPageLimitSchema = v.pipe(
    v.number("Automation-security page limit is invalid"),
    v.safeInteger("Automation-security page limit is invalid"),
    v.minValue(1, "Automation-security page limit is invalid"),
    v.maxValue(
        automationSecurityPageMaximum,
        "Automation-security page limit is outside its budget"
    )
);

/** Stable composite cursor for the principal creation-time order. */
export const automationPrincipalCursorSchema = v.strictObject({
    createdAtMs: automationSecurityTimestampSchema,
    id: automationPrincipalIdSchema,
});

/** Stable composite cursor for the credential creation-time order. */
export const automationCredentialCursorSchema = v.strictObject({
    createdAtMs: automationSecurityTimestampSchema,
    id: securityRecordIdSchema,
});

/** Operator-selected settings for a newly generated automation credential. */
export const automationCredentialSettingsSchema = v.strictObject({
    expiresAtMs: v.optional(automationSecurityTimestampSchema),
    label: securityLabelSchema,
});

/**
 * Checks persisted credential lifecycle timestamps that JSON Schema cannot compare.
 * @param credential Candidate non-secret credential summary.
 * @returns Whether expiry and revocation follow creation.
 */
export function automationCredentialTimesAreOrdered(
    credential: AutomationCredentialSummaryValue
): boolean {
    return (
        (credential.expiresAtMs === undefined ||
            credential.expiresAtMs > credential.createdAtMs) &&
        (credential.revokedAtMs === undefined ||
            credential.revokedAtMs >= credential.createdAtMs)
    );
}

/**
 * Checks that a staged replacement does not point to its own credential ID.
 * @param credential Candidate non-secret credential summary.
 * @returns Whether the predecessor identity differs from the new identity.
 */
export function automationCredentialDoesNotReplaceItself(
    credential: AutomationCredentialSummaryValue
): boolean {
    return credential.replacesCredentialId !== credential.id;
}

const automationCredentialSummaryObjectSchema = v.strictObject({
    createdAtMs: automationSecurityTimestampSchema,
    expiresAtMs: v.optional(automationSecurityTimestampSchema),
    id: securityRecordIdSchema,
    label: securityLabelSchema,
    prefix: opaqueSelectorSchema,
    replacesCredentialId: v.optional(securityRecordIdSchema),
    revokedAtMs: v.optional(automationSecurityTimestampSchema),
});

type AutomationCredentialSummaryValue = v.InferOutput<
    typeof automationCredentialSummaryObjectSchema
>;

/** Non-secret automation credential inventory row. */
export const automationCredentialSummarySchema = v.pipe(
    automationCredentialSummaryObjectSchema,
    v.check(
        automationCredentialTimesAreOrdered,
        "Automation credential timestamps are inconsistent"
    ),
    v.check(
        automationCredentialDoesNotReplaceItself,
        "Automation credential cannot replace itself"
    )
);

const activeCredentialCountSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Active automation credential count is invalid"),
    v.maxValue(
        activeAutomationCredentialMaximumPerPrincipal,
        "Active automation credential count is outside its budget"
    )
);

const totalCredentialCountSchema = nonnegativeSafeIntegerSchema(
    "Total automation credential count is invalid"
);

const activePrincipalCountSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Active automation principal count is invalid"),
    v.maxValue(
        activeAutomationPrincipalMaximum,
        "Active automation principal count is outside its budget"
    )
);

const revokedCredentialCountSchema = nonnegativeSafeIntegerSchema(
    "Revoked automation credential count is invalid"
);

const automationPrincipalSummaryBaseEntries = {
    activeCredentialCount: activeCredentialCountSchema,
    authorizationVersion: positiveSafeIntegerSchema(
        "Automation authorization version is invalid"
    ),
    capabilities: applicationCapabilityListSchema,
    createdAtMs: automationSecurityTimestampSchema,
    id: automationPrincipalIdSchema,
    label: securityLabelSchema,
    totalCredentialCount: totalCredentialCountSchema,
    updatedAtMs: automationSecurityTimestampSchema,
};

const activeAutomationPrincipalSummarySchema = v.strictObject({
    ...automationPrincipalSummaryBaseEntries,
    disabled: v.literal(false),
});

const disabledAutomationPrincipalSummarySchema = v.strictObject({
    ...automationPrincipalSummaryBaseEntries,
    disabled: v.literal(true),
    disabledAtMs: automationSecurityTimestampSchema,
});

type AutomationPrincipalSummaryValue =
    | v.InferOutput<typeof activeAutomationPrincipalSummarySchema>
    | v.InferOutput<typeof disabledAutomationPrincipalSummarySchema>;

/**
 * Checks cross-field principal creation, update, and disable timestamp ordering.
 * @param principal Candidate non-secret principal summary.
 * @returns Whether all principal timestamps are ordered.
 */
export function automationPrincipalTimesAreOrdered(
    principal: AutomationPrincipalSummaryValue
): boolean {
    return (
        principal.updatedAtMs >= principal.createdAtMs &&
        (!principal.disabled ||
            (principal.disabledAtMs !== undefined &&
                principal.disabledAtMs >= principal.createdAtMs &&
                principal.disabledAtMs <= principal.updatedAtMs))
    );
}

/**
 * Checks aggregate credential counts on active and disabled principal summaries.
 * @param principal Candidate non-secret principal summary.
 * @returns Whether active and total credential counts agree with principal state.
 */
export function automationPrincipalCredentialCountsAreConsistent(
    principal: AutomationPrincipalSummaryValue
): boolean {
    return (
        principal.activeCredentialCount <= principal.totalCredentialCount &&
        (!principal.disabled || principal.activeCredentialCount === 0)
    );
}

/** Named automation identity with aggregate credential counts but no secret material. */
export const automationPrincipalSummarySchema = v.pipe(
    v.variant("disabled", [
        activeAutomationPrincipalSummarySchema,
        disabledAutomationPrincipalSummarySchema,
    ]),
    v.check(
        automationPrincipalTimesAreOrdered,
        "Automation principal timestamps are inconsistent"
    ),
    v.check(
        automationPrincipalCredentialCountsAreConsistent,
        "Automation principal credential counts are inconsistent"
    )
);

function keyFollowsInNewestFirstOrder(
    previous: { readonly createdAtMs: number; readonly id: string },
    current: { readonly createdAtMs: number; readonly id: string }
): boolean {
    return (
        current.createdAtMs < previous.createdAtMs ||
        (current.createdAtMs === previous.createdAtMs && current.id < previous.id)
    );
}

function rowsHaveStableOrder(
    rows: readonly { readonly createdAtMs: number; readonly id: string }[]
): boolean {
    for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1];
        const current = rows[index];
        if (
            previous === undefined ||
            current === undefined ||
            !keyFollowsInNewestFirstOrder(previous, current)
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Checks strict newest-first ordering for one principal result page.
 * @param rows Candidate principal page.
 * @returns Whether every composite key follows its predecessor.
 */
export function automationPrincipalRowsHaveStableOrder(
    rows: AutomationPrincipalSummaryValue[]
): boolean {
    return rowsHaveStableOrder(rows);
}

/**
 * Checks strict newest-first ordering for one credential result page.
 * @param rows Candidate credential page.
 * @returns Whether every composite key follows its predecessor.
 */
export function automationCredentialRowsHaveStableOrder(
    rows: AutomationCredentialSummaryValue[]
): boolean {
    return rowsHaveStableOrder(rows);
}

function nextCursorMatchesLastRow(
    rows: readonly { readonly createdAtMs: number; readonly id: string }[],
    cursor?: { readonly createdAtMs: number; readonly id: string }
): boolean {
    if (cursor === undefined) return true;
    const last = rows.at(-1);
    return (
        last !== undefined &&
        cursor.createdAtMs === last.createdAtMs &&
        cursor.id === last.id
    );
}

/**
 * Checks total counts against the returned principal page.
 * @param result Candidate principal-page result.
 * @returns Whether active and returned counts fit the total.
 */
export function automationPrincipalPageCountsAreConsistent(
    result: ListAutomationPrincipalsResultValue
): boolean {
    return (
        result.activePrincipalCount <= result.totalPrincipalCount &&
        result.principals.length <= result.totalPrincipalCount
    );
}

/**
 * Checks that a principal continuation cursor names the returned last row.
 * @param result Candidate principal-page result.
 * @returns Whether an optional cursor matches the last returned row.
 */
export function automationPrincipalPageCursorIsConsistent(
    result: ListAutomationPrincipalsResultValue
): boolean {
    return nextCursorMatchesLastRow(result.principals, result.nextCursor);
}

/**
 * Checks total counts against the returned credential page.
 * @param result Candidate credential-page result.
 * @returns Whether the returned count fits the total.
 */
export function automationCredentialPageCountIsConsistent(
    result: ListAutomationCredentialsResultValue
): boolean {
    return result.credentials.length <= result.totalCredentialCount;
}

/**
 * Checks that a credential continuation cursor names the returned last row.
 * @param result Candidate credential-page result.
 * @returns Whether an optional cursor matches the last returned row.
 */
export function automationCredentialPageCursorIsConsistent(
    result: ListAutomationCredentialsResultValue
): boolean {
    return nextCursorMatchesLastRow(result.credentials, result.nextCursor);
}

export const listAutomationPrincipalsInputSchema = v.strictObject({
    cursor: v.optional(automationPrincipalCursorSchema),
    limit: v.optional(automationSecurityPageLimitSchema, automationSecurityPageDefault),
});

const automationPrincipalPageSchema = v.pipe(
    v.array(automationPrincipalSummarySchema, "Automation principal page is invalid"),
    v.maxLength(
        automationSecurityPageMaximum,
        "Automation principal page is outside its budget"
    ),
    v.check(
        automationPrincipalRowsHaveStableOrder,
        "Automation principal page order is invalid"
    )
);

const listAutomationPrincipalsResultObjectSchema = v.strictObject({
    activePrincipalCount: activePrincipalCountSchema,
    nextCursor: v.optional(automationPrincipalCursorSchema),
    principals: automationPrincipalPageSchema,
    totalPrincipalCount: nonnegativeSafeIntegerSchema(
        "Total automation principal count is invalid"
    ),
});

type ListAutomationPrincipalsResultValue = v.InferOutput<
    typeof listAutomationPrincipalsResultObjectSchema
>;

export const listAutomationPrincipalsResultSchema = v.pipe(
    listAutomationPrincipalsResultObjectSchema,
    v.check(
        automationPrincipalPageCountsAreConsistent,
        "Automation principal page counts are inconsistent"
    ),
    v.check(
        automationPrincipalPageCursorIsConsistent,
        "Automation principal page cursor is inconsistent"
    )
);

export const listAutomationCredentialsInputSchema = v.strictObject({
    cursor: v.optional(automationCredentialCursorSchema),
    limit: v.optional(automationSecurityPageLimitSchema, automationSecurityPageDefault),
    principalId: automationPrincipalIdSchema,
});

const automationCredentialPageSchema = v.pipe(
    v.array(automationCredentialSummarySchema, "Automation credential page is invalid"),
    v.maxLength(
        automationSecurityPageMaximum,
        "Automation credential page is outside its budget"
    ),
    v.check(
        automationCredentialRowsHaveStableOrder,
        "Automation credential page order is invalid"
    )
);

const listAutomationCredentialsResultObjectSchema = v.strictObject({
    credentials: automationCredentialPageSchema,
    nextCursor: v.optional(automationCredentialCursorSchema),
    principalId: automationPrincipalIdSchema,
    totalCredentialCount: totalCredentialCountSchema,
});

type ListAutomationCredentialsResultValue = v.InferOutput<
    typeof listAutomationCredentialsResultObjectSchema
>;

export const listAutomationCredentialsResultSchema = v.pipe(
    listAutomationCredentialsResultObjectSchema,
    v.check(
        automationCredentialPageCountIsConsistent,
        "Automation credential page count is inconsistent"
    ),
    v.check(
        automationCredentialPageCursorIsConsistent,
        "Automation credential page cursor is inconsistent"
    )
);

export const createAutomationPrincipalInputSchema = v.strictObject({
    capabilities: applicationCapabilityListSchema,
    id: automationPrincipalIdSchema,
    initialCredential: automationCredentialSettingsSchema,
    label: securityLabelSchema,
});

function tokenMatchesCredential(
    token: string,
    credential: { readonly prefix: string }
): boolean {
    return token.slice(0, 32) === credential.prefix;
}

/**
 * Checks the one-time token and initial inventory returned for a new principal.
 * @param result Candidate principal-creation result.
 * @returns Whether the initial credential and token agree with the principal summary.
 */
export function createdAutomationPrincipalResultIsConsistent(
    result: CreateAutomationPrincipalResultValue
): boolean {
    return (
        !result.principal.disabled &&
        result.principal.activeCredentialCount === 1 &&
        result.principal.totalCredentialCount === 1 &&
        result.credential.replacesCredentialId === undefined &&
        result.credential.revokedAtMs === undefined &&
        tokenMatchesCredential(result.token, result.credential)
    );
}

/**
 * Checks a newly created standalone credential and its one-time token.
 * @param result Candidate credential-creation result.
 * @returns Whether the credential is standalone, active, and token-bound.
 */
export function createdAutomationCredentialResultIsConsistent(
    result: GeneratedAutomationCredentialResultValue
): boolean {
    return (
        result.credential.replacesCredentialId === undefined &&
        result.credential.revokedAtMs === undefined &&
        tokenMatchesCredential(result.token, result.credential)
    );
}

/**
 * Checks a staged replacement credential and its one-time token.
 * @param result Candidate staged-rotation result.
 * @returns Whether the credential is linked, active, and token-bound.
 */
export function rotatedAutomationCredentialResultIsConsistent(
    result: GeneratedAutomationCredentialResultValue
): boolean {
    return (
        result.credential.replacesCredentialId !== undefined &&
        result.credential.revokedAtMs === undefined &&
        tokenMatchesCredential(result.token, result.credential)
    );
}

/**
 * Checks that a revoke result always carries the durable revocation timestamp.
 * @param result Candidate credential-revocation result.
 * @returns Whether durable revocation metadata is present.
 */
export function revokedAutomationCredentialResultIsConsistent(
    result: RevokeAutomationCredentialResultValue
): boolean {
    return result.credential.revokedAtMs !== undefined;
}

/**
 * Checks terminal principal state and idempotent disable result counts.
 * @param result Candidate principal-disable result.
 * @returns Whether terminal state and no-op counts agree.
 */
export function disabledAutomationPrincipalResultIsConsistent(
    result: DisableAutomationPrincipalResultValue
): boolean {
    return (
        result.principal.disabled && (result.changed || result.revokedCredentials === 0)
    );
}

const createAutomationPrincipalResultObjectSchema = v.strictObject({
    credential: automationCredentialSummarySchema,
    principal: automationPrincipalSummarySchema,
    token: opaqueTokenSchema,
});

type CreateAutomationPrincipalResultValue = v.InferOutput<
    typeof createAutomationPrincipalResultObjectSchema
>;

export const createAutomationPrincipalResultSchema = v.pipe(
    createAutomationPrincipalResultObjectSchema,
    v.check(
        createdAutomationPrincipalResultIsConsistent,
        "Created automation principal result is inconsistent"
    )
);

const existingPrincipalMutationEntries = {
    expectedAuthorizationVersion: positiveSafeIntegerSchema(
        "Expected automation authorization version is invalid"
    ),
    principalId: automationPrincipalIdSchema,
};

export const createAutomationCredentialInputSchema = v.strictObject({
    ...existingPrincipalMutationEntries,
    credential: automationCredentialSettingsSchema,
});

const generatedAutomationCredentialResultObjectSchema = v.strictObject({
    credential: automationCredentialSummarySchema,
    token: opaqueTokenSchema,
});

type GeneratedAutomationCredentialResultValue = v.InferOutput<
    typeof generatedAutomationCredentialResultObjectSchema
>;

export const createAutomationCredentialResultSchema = v.pipe(
    generatedAutomationCredentialResultObjectSchema,
    v.check(
        createdAutomationCredentialResultIsConsistent,
        "Created automation credential result is inconsistent"
    )
);

export const rotateAutomationCredentialInputSchema = v.strictObject({
    ...existingPrincipalMutationEntries,
    credentialId: securityRecordIdSchema,
    replacement: automationCredentialSettingsSchema,
});

export const rotateAutomationCredentialResultSchema = v.pipe(
    generatedAutomationCredentialResultObjectSchema,
    v.check(
        rotatedAutomationCredentialResultIsConsistent,
        "Rotated automation credential result is inconsistent"
    )
);

export const revokeAutomationCredentialInputSchema = v.strictObject({
    ...existingPrincipalMutationEntries,
    credentialId: securityRecordIdSchema,
});

const revokeAutomationCredentialResultObjectSchema = v.strictObject({
    credential: automationCredentialSummarySchema,
    revoked: v.boolean(),
});

type RevokeAutomationCredentialResultValue = v.InferOutput<
    typeof revokeAutomationCredentialResultObjectSchema
>;

export const revokeAutomationCredentialResultSchema = v.pipe(
    revokeAutomationCredentialResultObjectSchema,
    v.check(
        revokedAutomationCredentialResultIsConsistent,
        "Revoked automation credential result is inconsistent"
    )
);

export const replaceAutomationCapabilitiesInputSchema = v.strictObject({
    ...existingPrincipalMutationEntries,
    capabilities: applicationCapabilityListSchema,
});

export const replaceAutomationCapabilitiesResultSchema = v.strictObject({
    changed: v.boolean(),
    principal: automationPrincipalSummarySchema,
});

export const disableAutomationPrincipalInputSchema = v.strictObject({
    ...existingPrincipalMutationEntries,
});

const disableAutomationPrincipalResultObjectSchema = v.strictObject({
    changed: v.boolean(),
    principal: automationPrincipalSummarySchema,
    revokedCredentials: revokedCredentialCountSchema,
});

type DisableAutomationPrincipalResultValue = v.InferOutput<
    typeof disableAutomationPrincipalResultObjectSchema
>;

export const disableAutomationPrincipalResultSchema = v.pipe(
    disableAutomationPrincipalResultObjectSchema,
    v.check(
        disabledAutomationPrincipalResultIsConsistent,
        "Disabled automation principal result is inconsistent"
    )
);

const sessionAccess = {
    capabilities: [],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const recentSessionAccess = {
    kind: "recent-auth",
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const authenticationReadTransport = {
    batching: "adapter-default",
    handler: "authentication",
    requestBody: "authentication",
} as const;
const authenticationMutationTransport = {
    batching: "forbidden",
    handler: "authentication",
    requestBody: "authentication",
} as const;
const mutationErrorReasons = ["mfa_enrollment_required", "step_up_required"] as const;
const existingPrincipalMutationErrors = [
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "UNAUTHORIZED",
] as const;
const credentialGenerationErrors = [
    "CONFLICT",
    "FORBIDDEN",
    "NOT_FOUND",
    "PRECONDITION_FAILED",
    "SERVICE_UNAVAILABLE",
    "UNAUTHORIZED",
] as const;

/** Implemented browser-managed automation-security procedure metadata. */
export const automationSecurityProcedureContracts = [
    {
        access: sessionAccess,
        domain: "automation-security",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: listAutomationPrincipalsInputSchema,
        inputSchemaId: "automationSecurity.listPrincipals.input",
        kind: "query",
        name: "automationSecurity.listPrincipals",
        output: listAutomationPrincipalsResultSchema,
        outputSchemaId: "automationSecurity.listPrincipals.output",
        summary: "Lists one stable page of automation principals and credential counts.",
        transport: authenticationReadTransport,
    },
    {
        access: sessionAccess,
        domain: "automation-security",
        errors: ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: listAutomationCredentialsInputSchema,
        inputSchemaId: "automationSecurity.listCredentials.input",
        kind: "query",
        name: "automationSecurity.listCredentials",
        output: listAutomationCredentialsResultSchema,
        outputSchemaId: "automationSecurity.listCredentials.output",
        summary: "Lists one stable page of non-secret credential history.",
        transport: authenticationReadTransport,
    },
    {
        access: recentSessionAccess,
        domain: "automation-security",
        errorReasons: mutationErrorReasons,
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "PRECONDITION_FAILED",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: createAutomationPrincipalInputSchema,
        inputSchemaId: "automationSecurity.createPrincipal.input",
        kind: "mutation",
        name: "automationSecurity.createPrincipal",
        output: createAutomationPrincipalResultSchema,
        outputSchemaId: "automationSecurity.createPrincipal.output",
        summary: "Creates one named principal and reveals its initial token once.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentSessionAccess,
        domain: "automation-security",
        errorReasons: mutationErrorReasons,
        errors: credentialGenerationErrors,
        input: createAutomationCredentialInputSchema,
        inputSchemaId: "automationSecurity.createCredential.input",
        kind: "mutation",
        name: "automationSecurity.createCredential",
        output: createAutomationCredentialResultSchema,
        outputSchemaId: "automationSecurity.createCredential.output",
        summary: "Creates one credential and reveals its token once.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentSessionAccess,
        domain: "automation-security",
        errorReasons: mutationErrorReasons,
        errors: credentialGenerationErrors,
        input: rotateAutomationCredentialInputSchema,
        inputSchemaId: "automationSecurity.rotateCredential.input",
        kind: "mutation",
        name: "automationSecurity.rotateCredential",
        output: rotateAutomationCredentialResultSchema,
        outputSchemaId: "automationSecurity.rotateCredential.output",
        summary:
            "Stages a linked replacement credential without revoking its predecessor.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentSessionAccess,
        domain: "automation-security",
        errorReasons: mutationErrorReasons,
        errors: existingPrincipalMutationErrors,
        input: revokeAutomationCredentialInputSchema,
        inputSchemaId: "automationSecurity.revokeCredential.input",
        kind: "mutation",
        name: "automationSecurity.revokeCredential",
        output: revokeAutomationCredentialResultSchema,
        outputSchemaId: "automationSecurity.revokeCredential.output",
        summary: "Explicitly revokes one automation credential after client cutover.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentSessionAccess,
        domain: "automation-security",
        errorReasons: mutationErrorReasons,
        errors: existingPrincipalMutationErrors,
        input: replaceAutomationCapabilitiesInputSchema,
        inputSchemaId: "automationSecurity.replaceCapabilities.input",
        kind: "mutation",
        name: "automationSecurity.replaceCapabilities",
        output: replaceAutomationCapabilitiesResultSchema,
        outputSchemaId: "automationSecurity.replaceCapabilities.output",
        summary: "Atomically replaces a principal's least-privilege capability set.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentSessionAccess,
        domain: "automation-security",
        errorReasons: mutationErrorReasons,
        errors: existingPrincipalMutationErrors,
        input: disableAutomationPrincipalInputSchema,
        inputSchemaId: "automationSecurity.disablePrincipal.input",
        kind: "mutation",
        name: "automationSecurity.disablePrincipal",
        output: disableAutomationPrincipalResultSchema,
        outputSchemaId: "automationSecurity.disablePrincipal.output",
        summary: "Disables one principal and revokes its active credentials.",
        transport: authenticationMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type AutomationCredentialCursor = v.InferOutput<
    typeof automationCredentialCursorSchema
>;
export type AutomationCredentialSettings = v.InferOutput<
    typeof automationCredentialSettingsSchema
>;
export type AutomationCredentialSummary = v.InferOutput<
    typeof automationCredentialSummarySchema
>;
export type AutomationPrincipalCursor = v.InferOutput<
    typeof automationPrincipalCursorSchema
>;
export type AutomationPrincipalSummary = v.InferOutput<
    typeof automationPrincipalSummarySchema
>;
export type CreateAutomationCredentialInput = v.InferOutput<
    typeof createAutomationCredentialInputSchema
>;
export type CreateAutomationCredentialResult = v.InferOutput<
    typeof createAutomationCredentialResultSchema
>;
export type CreateAutomationPrincipalInput = v.InferOutput<
    typeof createAutomationPrincipalInputSchema
>;
export type CreateAutomationPrincipalResult = v.InferOutput<
    typeof createAutomationPrincipalResultSchema
>;
export type DisableAutomationPrincipalInput = v.InferOutput<
    typeof disableAutomationPrincipalInputSchema
>;
export type DisableAutomationPrincipalResult = v.InferOutput<
    typeof disableAutomationPrincipalResultSchema
>;
export type ListAutomationCredentialsInput = v.InferOutput<
    typeof listAutomationCredentialsInputSchema
>;
export type ListAutomationCredentialsResult = v.InferOutput<
    typeof listAutomationCredentialsResultSchema
>;
export type ListAutomationPrincipalsInput = v.InferOutput<
    typeof listAutomationPrincipalsInputSchema
>;
export type ListAutomationPrincipalsResult = v.InferOutput<
    typeof listAutomationPrincipalsResultSchema
>;
export type ReplaceAutomationCapabilitiesInput = v.InferOutput<
    typeof replaceAutomationCapabilitiesInputSchema
>;
export type ReplaceAutomationCapabilitiesResult = v.InferOutput<
    typeof replaceAutomationCapabilitiesResultSchema
>;
export type RevokeAutomationCredentialInput = v.InferOutput<
    typeof revokeAutomationCredentialInputSchema
>;
export type RevokeAutomationCredentialResult = v.InferOutput<
    typeof revokeAutomationCredentialResultSchema
>;
export type RotateAutomationCredentialInput = v.InferOutput<
    typeof rotateAutomationCredentialInputSchema
>;
export type RotateAutomationCredentialResult = v.InferOutput<
    typeof rotateAutomationCredentialResultSchema
>;
