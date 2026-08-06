import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { recoveryCodeCount } from "../shared/recoveryCodePolicy.ts";
import {
    hasUniqueArrayItems,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";
import {
    authPasswordInputSchema,
    authSessionSummarySchema,
    recoveryCodeInputSchema,
    recoveryCodeSchema,
    totpCodeInputSchema,
} from "./auth.ts";
import type { ProcedureContract } from "./registry.ts";
import {
    isValidSecurityLabel,
    securityLabelMaximumLength,
    securityLabelSchema,
    securityRecordIdSchema,
} from "./security.ts";
import { emptyInputSchema } from "./system.ts";
import {
    webAuthnAuthenticationInputSchema,
    webAuthnAuthenticationOptionsSchema,
    webAuthnRegistrationOptionsSchema,
    webAuthnRegistrationResponseSchema,
    webAuthnRpIdSchema,
    webAuthnTransportListSchema,
} from "./webauthn.ts";

const accountSecurityTimestampSchema = timestampMillisecondsSchema(
    "Account-security timestamp is invalid"
);

export { recoveryCodeCount } from "../shared/recoveryCodePolicy.ts";
export const factorLabelMaximumLength = securityLabelMaximumLength;
export const possessionFactorMaximumPerUser = 4;
export const totpFactorLabelMaximumLength = factorLabelMaximumLength;
export const totpFactorMaximumPerUser = possessionFactorMaximumPerUser;
export const webAuthnCredentialMaximumPerUser = possessionFactorMaximumPerUser;

/**
 * Validates the Unicode code-point and control-safety policy for factor labels.
 * @param value Candidate factor label.
 * @returns Whether the label satisfies the account-security policy.
 */
export const isValidFactorLabel = isValidSecurityLabel;

export const isValidTotpFactorLabel = isValidFactorLabel;

export const factorLabelSchema = securityLabelSchema;

export const totpFactorLabelSchema = factorLabelSchema;

export const totpFactorSummarySchema = v.strictObject({
    confirmedAtMs: accountSecurityTimestampSchema,
    createdAtMs: accountSecurityTimestampSchema,
    id: securityRecordIdSchema,
    label: totpFactorLabelSchema,
});

export const webAuthnCredentialSummarySchema = v.strictObject({
    backedUp: v.boolean(),
    createdAtMs: accountSecurityTimestampSchema,
    deviceType: v.picklist(["multiDevice", "singleDevice"]),
    id: securityRecordIdSchema,
    label: factorLabelSchema,
    lastUsedAtMs: v.optional(accountSecurityTimestampSchema),
    transports: webAuthnTransportListSchema,
    usable: v.boolean(),
});

const staleVerificationSchema = v.strictObject({
    recent: v.literal(false),
});
const recentVerificationDetailsSchema = v.strictObject({
    expiresAtMs: accountSecurityTimestampSchema,
    recent: v.literal(true),
    remainingMs: nonnegativeSafeIntegerSchema("Recent-verification lifetime is invalid"),
    verifiedAtMs: accountSecurityTimestampSchema,
});

export const recentVerificationSchema = v.variant("recent", [
    staleVerificationSchema,
    recentVerificationDetailsSchema,
]);

const totpFactorListSchema = v.pipe(
    v.array(totpFactorSummarySchema, "TOTP factor list is invalid"),
    v.minLength(1, "Enabled MFA requires a TOTP factor"),
    v.maxLength(totpFactorMaximumPerUser, "TOTP factor list is outside its budget")
);

const webAuthnCredentialListSchema = v.pipe(
    v.array(webAuthnCredentialSummarySchema, "WebAuthn credential list is invalid"),
    v.minLength(1, "Enabled MFA requires a WebAuthn credential"),
    v.maxLength(
        webAuthnCredentialMaximumPerUser,
        "WebAuthn credential list is outside its budget"
    )
);

const disabledMfaSummarySchema = v.strictObject({
    enabled: v.literal(false),
    methods: v.strictTuple([]),
    recoveryCodesRemaining: v.literal(0),
    totpFactors: v.strictTuple([]),
    webAuthnCredentials: v.strictTuple([]),
});
const enabledTotpMfaWithoutRecoverySchema = v.strictObject({
    enabled: v.literal(true),
    enabledAtMs: accountSecurityTimestampSchema,
    methods: v.strictTuple([v.literal("totp")]),
    recoveryCodesRemaining: v.literal(0),
    totpFactors: totpFactorListSchema,
    webAuthnCredentials: v.strictTuple([]),
});
const enabledTotpMfaWithRecoverySchema = v.strictObject({
    enabled: v.literal(true),
    enabledAtMs: accountSecurityTimestampSchema,
    methods: v.strictTuple([v.literal("recovery"), v.literal("totp")]),
    recoveryCodesRemaining: v.pipe(
        v.number("Recovery-code count is invalid"),
        v.safeInteger("Recovery-code count is invalid"),
        v.minValue(1, "Recovery-code count is invalid"),
        v.maxValue(recoveryCodeCount, "Recovery-code count is invalid")
    ),
    totpFactors: totpFactorListSchema,
    webAuthnCredentials: v.strictTuple([]),
});

const enabledWebAuthnMfaWithoutRecoverySchema = v.strictObject({
    enabled: v.literal(true),
    enabledAtMs: accountSecurityTimestampSchema,
    methods: v.strictTuple([v.literal("webauthn")]),
    recoveryCodesRemaining: v.literal(0),
    totpFactors: v.strictTuple([]),
    webAuthnCredentials: webAuthnCredentialListSchema,
});

const enabledWebAuthnMfaWithRecoverySchema = v.strictObject({
    enabled: v.literal(true),
    enabledAtMs: accountSecurityTimestampSchema,
    methods: v.strictTuple([v.literal("recovery"), v.literal("webauthn")]),
    recoveryCodesRemaining: v.pipe(
        v.number("Recovery-code count is invalid"),
        v.safeInteger("Recovery-code count is invalid"),
        v.minValue(1, "Recovery-code count is invalid"),
        v.maxValue(recoveryCodeCount, "Recovery-code count is invalid")
    ),
    totpFactors: v.strictTuple([]),
    webAuthnCredentials: webAuthnCredentialListSchema,
});

const enabledMixedMfaWithoutRecoverySchema = v.strictObject({
    enabled: v.literal(true),
    enabledAtMs: accountSecurityTimestampSchema,
    methods: v.strictTuple([v.literal("totp"), v.literal("webauthn")]),
    recoveryCodesRemaining: v.literal(0),
    totpFactors: totpFactorListSchema,
    webAuthnCredentials: webAuthnCredentialListSchema,
});

const enabledMixedMfaWithRecoverySchema = v.strictObject({
    enabled: v.literal(true),
    enabledAtMs: accountSecurityTimestampSchema,
    methods: v.strictTuple([
        v.literal("recovery"),
        v.literal("totp"),
        v.literal("webauthn"),
    ]),
    recoveryCodesRemaining: v.pipe(
        v.number("Recovery-code count is invalid"),
        v.safeInteger("Recovery-code count is invalid"),
        v.minValue(1, "Recovery-code count is invalid"),
        v.maxValue(recoveryCodeCount, "Recovery-code count is invalid")
    ),
    totpFactors: totpFactorListSchema,
    webAuthnCredentials: webAuthnCredentialListSchema,
});

const accountMfaSummaryUnionSchema = v.union([
    disabledMfaSummarySchema,
    enabledTotpMfaWithoutRecoverySchema,
    enabledTotpMfaWithRecoverySchema,
    enabledWebAuthnMfaWithoutRecoverySchema,
    enabledWebAuthnMfaWithRecoverySchema,
    enabledMixedMfaWithoutRecoverySchema,
    enabledMixedMfaWithRecoverySchema,
]);

/**
 * Checks the aggregate factor cap across TOTP and WebAuthn inventories.
 * @param value Structurally valid account MFA summary.
 * @returns Whether the combined possession-factor count is within policy.
 */
export function hasValidPossessionFactorInventory(
    value: v.InferOutput<typeof accountMfaSummaryUnionSchema>
): boolean {
    return (
        value.totpFactors.length + value.webAuthnCredentials.length <=
        possessionFactorMaximumPerUser
    );
}

export const accountMfaSummarySchema = v.pipe(
    accountMfaSummaryUnionSchema,
    v.check(
        hasValidPossessionFactorInventory,
        "Possession factor inventory is outside its budget"
    )
);

export const webAuthnAvailabilitySchema = v.variant("available", [
    v.strictObject({ available: v.literal(false) }),
    v.strictObject({ available: v.literal(true), rpId: webAuthnRpIdSchema }),
]);

export const accountSecuritySummarySchema = v.strictObject({
    checkedAtMs: accountSecurityTimestampSchema,
    mfa: accountMfaSummarySchema,
    recentAuth: v.strictObject({
        mfa: recentVerificationSchema,
        password: recentVerificationSchema,
    }),
    webAuthn: webAuthnAvailabilitySchema,
});

export const passwordReauthenticationInputSchema = v.strictObject({
    password: authPasswordInputSchema,
});

export const passwordReauthenticationResultSchema = v.strictObject({
    session: authSessionSummarySchema,
    verifiedAtMs: accountSecurityTimestampSchema,
});

export const totpStepUpInputSchema = v.strictObject({
    code: totpCodeInputSchema,
});

export const recoveryStepUpInputSchema = v.strictObject({
    code: recoveryCodeInputSchema,
});

export const totpStepUpResultSchema = v.strictObject({
    method: v.literal("totp"),
    session: authSessionSummarySchema,
    verifiedAtMs: accountSecurityTimestampSchema,
});

export const recoveryStepUpResultSchema = v.strictObject({
    method: v.literal("recovery"),
    recoveryCodesRemaining: v.pipe(
        v.number("Recovery-code count is invalid"),
        v.safeInteger("Recovery-code count is invalid"),
        v.minValue(0, "Recovery-code count is invalid"),
        v.maxValue(recoveryCodeCount - 1, "Recovery-code count is invalid")
    ),
    session: authSessionSummarySchema,
    verifiedAtMs: accountSecurityTimestampSchema,
});

export const beginWebAuthnStepUpResultSchema = v.strictObject({
    expiresAtMs: accountSecurityTimestampSchema,
    options: webAuthnAuthenticationOptionsSchema,
});

export const webAuthnStepUpInputSchema = webAuthnAuthenticationInputSchema;

export const webAuthnStepUpResultSchema = v.strictObject({
    method: v.literal("webauthn"),
    session: authSessionSummarySchema,
    verifiedAtMs: accountSecurityTimestampSchema,
});

export const beginTotpEnrollmentInputSchema = v.strictObject({
    label: v.optional(totpFactorLabelSchema),
});

const totpEnrollmentSecretSchema = v.pipe(
    v.string("TOTP enrollment secret is invalid"),
    v.length(32, "TOTP enrollment secret is invalid"),
    v.regex(/^[A-Z2-7]{32}$/u, "TOTP enrollment secret is invalid")
);

const totpEnrollmentUriSchema = v.pipe(
    v.string("TOTP enrollment URI is invalid"),
    v.maxLength(2048, "TOTP enrollment URI is invalid"),
    v.regex(/^otpauth:\/\/totp\/\S+$/u, "TOTP enrollment URI is invalid")
);

export const totpEnrollmentSchema = v.strictObject({
    expiresAtMs: accountSecurityTimestampSchema,
    factorId: securityRecordIdSchema,
    label: totpFactorLabelSchema,
    otpauthUri: totpEnrollmentUriSchema,
    secret: totpEnrollmentSecretSchema,
});

export const beginTotpEnrollmentResultSchema = v.strictObject({
    enrollment: totpEnrollmentSchema,
});

export const confirmTotpEnrollmentInputSchema = v.strictObject({
    code: totpCodeInputSchema,
    factorId: securityRecordIdSchema,
});

const additionalTotpFactorResultSchema = v.strictObject({
    enabledNow: v.literal(false),
    factor: totpFactorSummarySchema,
});

const recoveryCodeSetSchema = v.pipe(
    v.array(recoveryCodeSchema, "Recovery-code set is invalid"),
    v.minLength(recoveryCodeCount, "Recovery-code set is incomplete"),
    v.maxLength(recoveryCodeCount, "Recovery-code set is too large"),
    v.check(hasUniqueArrayItems<string>, "Recovery codes must be unique")
);

const firstTotpFactorResultSchema = v.strictObject({
    enabledNow: v.literal(true),
    factor: totpFactorSummarySchema,
    recoveryCodes: recoveryCodeSetSchema,
    revokedSessions: nonnegativeSafeIntegerSchema("Revoked-session count is invalid"),
    session: authSessionSummarySchema,
});

export const confirmTotpEnrollmentResultSchema = v.variant("enabledNow", [
    additionalTotpFactorResultSchema,
    firstTotpFactorResultSchema,
]);

export const beginWebAuthnEnrollmentResultSchema = v.strictObject({
    expiresAtMs: accountSecurityTimestampSchema,
    options: webAuthnRegistrationOptionsSchema,
});

export const confirmWebAuthnEnrollmentInputSchema = v.strictObject({
    label: v.optional(factorLabelSchema),
    response: webAuthnRegistrationResponseSchema,
});

const additionalWebAuthnCredentialResultSchema = v.strictObject({
    credential: webAuthnCredentialSummarySchema,
    enabledNow: v.literal(false),
});

const firstWebAuthnCredentialResultSchema = v.strictObject({
    credential: webAuthnCredentialSummarySchema,
    enabledNow: v.literal(true),
    recoveryCodes: recoveryCodeSetSchema,
    revokedSessions: nonnegativeSafeIntegerSchema("Revoked-session count is invalid"),
    session: authSessionSummarySchema,
});

export const confirmWebAuthnEnrollmentResultSchema = v.variant("enabledNow", [
    additionalWebAuthnCredentialResultSchema,
    firstWebAuthnCredentialResultSchema,
]);

export const removeTotpFactorInputSchema = v.strictObject({
    factorId: securityRecordIdSchema,
});

export const removeTotpFactorResultSchema = v.strictObject({
    factorId: securityRecordIdSchema,
    removed: v.literal(true),
});

export const removeWebAuthnCredentialInputSchema = v.strictObject({
    credentialId: securityRecordIdSchema,
});

export const removeWebAuthnCredentialResultSchema = v.strictObject({
    credentialId: securityRecordIdSchema,
    removed: v.literal(true),
});

export const rotateRecoveryCodesResultSchema = v.strictObject({
    recoveryCodes: recoveryCodeSetSchema,
});

export const disableMfaInputSchema = v.strictObject({
    password: authPasswordInputSchema,
});

export const disableMfaResultSchema = v.strictObject({
    disabled: v.literal(true),
    revokedSessions: nonnegativeSafeIntegerSchema("Revoked-session count is invalid"),
    session: authSessionSummarySchema,
});

const sessionAccess = {
    capabilities: [],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const factorEnrollmentAccess = {
    kind: "recent-auth",
    whenMfaDisabled: "password",
    whenMfaEnabled: "mfa",
} as const;
const recentMfaAccess = {
    kind: "recent-auth",
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const recentMfaErrorReasons = ["mfa_enrollment_required", "step_up_required"] as const;
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

/** Implemented account-security procedure metadata. */
export const accountSecurityProcedureContracts = [
    {
        access: sessionAccess,
        domain: "account-security",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "accountSecurity.summary.input",
        kind: "query",
        name: "accountSecurity.summary",
        output: accountSecuritySummarySchema,
        outputSchemaId: "accountSecurity.summary.output",
        summary: "Returns MFA inventory and server-relative recent-auth state.",
        transport: authenticationReadTransport,
    },
    {
        access: sessionAccess,
        domain: "account-security",
        errors: ["FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: passwordReauthenticationInputSchema,
        inputSchemaId: "accountSecurity.reauthenticatePassword.input",
        kind: "mutation",
        name: "accountSecurity.reauthenticatePassword",
        output: passwordReauthenticationResultSchema,
        outputSchemaId: "accountSecurity.reauthenticatePassword.output",
        summary: "Rotates the session after refreshing recent password verification.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionAccess,
        domain: "account-security",
        errorReasons: ["mfa_enrollment_required"],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: totpStepUpInputSchema,
        inputSchemaId: "accountSecurity.stepUpTotp.input",
        kind: "mutation",
        name: "accountSecurity.stepUpTotp",
        output: totpStepUpResultSchema,
        outputSchemaId: "accountSecurity.stepUpTotp.output",
        summary: "Rotates the session after a fresh TOTP proof.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionAccess,
        domain: "account-security",
        errorReasons: ["mfa_enrollment_required"],
        errors: ["CONFLICT", "FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: recoveryStepUpInputSchema,
        inputSchemaId: "accountSecurity.stepUpRecovery.input",
        kind: "mutation",
        name: "accountSecurity.stepUpRecovery",
        output: recoveryStepUpResultSchema,
        outputSchemaId: "accountSecurity.stepUpRecovery.output",
        summary: "Consumes a recovery code and rotates the recently verified session.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionAccess,
        domain: "account-security",
        errorReasons: ["mfa_enrollment_required"],
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "accountSecurity.beginWebAuthnStepUp.input",
        kind: "mutation",
        name: "accountSecurity.beginWebAuthnStepUp",
        output: beginWebAuthnStepUpResultSchema,
        outputSchemaId: "accountSecurity.beginWebAuthnStepUp.output",
        summary: "Creates one session-bound WebAuthn step-up challenge.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionAccess,
        domain: "account-security",
        errorReasons: ["mfa_enrollment_required"],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: webAuthnStepUpInputSchema,
        inputSchemaId: "accountSecurity.stepUpWebAuthn.input",
        kind: "mutation",
        name: "accountSecurity.stepUpWebAuthn",
        output: webAuthnStepUpResultSchema,
        outputSchemaId: "accountSecurity.stepUpWebAuthn.output",
        summary: "Consumes a WebAuthn challenge and rotates the verified session.",
        transport: authenticationMutationTransport,
    },
    {
        access: factorEnrollmentAccess,
        domain: "account-security",
        errorReasons: ["step_up_required"],
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: beginTotpEnrollmentInputSchema,
        inputSchemaId: "accountSecurity.beginTotpEnrollment.input",
        kind: "mutation",
        name: "accountSecurity.beginTotpEnrollment",
        output: beginTotpEnrollmentResultSchema,
        outputSchemaId: "accountSecurity.beginTotpEnrollment.output",
        summary: "Creates one expiring encrypted TOTP enrollment.",
        transport: authenticationMutationTransport,
    },
    {
        access: factorEnrollmentAccess,
        domain: "account-security",
        errorReasons: ["step_up_required"],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: confirmTotpEnrollmentInputSchema,
        inputSchemaId: "accountSecurity.confirmTotpEnrollment.input",
        kind: "mutation",
        name: "accountSecurity.confirmTotpEnrollment",
        output: confirmTotpEnrollmentResultSchema,
        outputSchemaId: "accountSecurity.confirmTotpEnrollment.output",
        summary: "Confirms a TOTP factor and atomically enables MFA when it is first.",
        transport: authenticationMutationTransport,
    },
    {
        access: factorEnrollmentAccess,
        domain: "account-security",
        errorReasons: ["step_up_required"],
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "accountSecurity.beginWebAuthnEnrollment.input",
        kind: "mutation",
        name: "accountSecurity.beginWebAuthnEnrollment",
        output: beginWebAuthnEnrollmentResultSchema,
        outputSchemaId: "accountSecurity.beginWebAuthnEnrollment.output",
        summary: "Creates one session-bound roaming-key registration challenge.",
        transport: authenticationMutationTransport,
    },
    {
        access: factorEnrollmentAccess,
        domain: "account-security",
        errorReasons: ["step_up_required"],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: confirmWebAuthnEnrollmentInputSchema,
        inputSchemaId: "accountSecurity.confirmWebAuthnEnrollment.input",
        kind: "mutation",
        name: "accountSecurity.confirmWebAuthnEnrollment",
        output: confirmWebAuthnEnrollmentResultSchema,
        outputSchemaId: "accountSecurity.confirmWebAuthnEnrollment.output",
        summary:
            "Verifies and stores a WebAuthn credential, enabling MFA when it is first.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentMfaAccess,
        domain: "account-security",
        errorReasons: recentMfaErrorReasons,
        errors: ["CONFLICT", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: removeTotpFactorInputSchema,
        inputSchemaId: "accountSecurity.removeTotpFactor.input",
        kind: "mutation",
        name: "accountSecurity.removeTotpFactor",
        output: removeTotpFactorResultSchema,
        outputSchemaId: "accountSecurity.removeTotpFactor.output",
        summary: "Removes a TOTP factor without removing the final possession factor.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentMfaAccess,
        domain: "account-security",
        errorReasons: recentMfaErrorReasons,
        errors: ["CONFLICT", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
        input: removeWebAuthnCredentialInputSchema,
        inputSchemaId: "accountSecurity.removeWebAuthnCredential.input",
        kind: "mutation",
        name: "accountSecurity.removeWebAuthnCredential",
        output: removeWebAuthnCredentialResultSchema,
        outputSchemaId: "accountSecurity.removeWebAuthnCredential.output",
        summary:
            "Removes a WebAuthn credential without removing the final possession factor.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentMfaAccess,
        domain: "account-security",
        errorReasons: recentMfaErrorReasons,
        errors: ["CONFLICT", "FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "accountSecurity.rotateRecoveryCodes.input",
        kind: "mutation",
        name: "accountSecurity.rotateRecoveryCodes",
        output: rotateRecoveryCodesResultSchema,
        outputSchemaId: "accountSecurity.rotateRecoveryCodes.output",
        summary: "Replaces all recovery codes and returns the plaintext set once.",
        transport: authenticationMutationTransport,
    },
    {
        access: recentMfaAccess,
        domain: "account-security",
        errorReasons: recentMfaErrorReasons,
        errors: ["CONFLICT", "FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: disableMfaInputSchema,
        inputSchemaId: "accountSecurity.disableMfa.input",
        kind: "mutation",
        name: "accountSecurity.disableMfa",
        output: disableMfaResultSchema,
        outputSchemaId: "accountSecurity.disableMfa.output",
        summary: "Disables MFA after recent MFA and current-password verification.",
        transport: authenticationMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type AccountSecuritySummary = v.InferOutput<typeof accountSecuritySummarySchema>;
export type BeginWebAuthnEnrollmentResult = v.InferOutput<
    typeof beginWebAuthnEnrollmentResultSchema
>;
export type BeginWebAuthnStepUpResult = v.InferOutput<
    typeof beginWebAuthnStepUpResultSchema
>;
export type BeginTotpEnrollmentInput = v.InferOutput<
    typeof beginTotpEnrollmentInputSchema
>;
export type BeginTotpEnrollmentResult = v.InferOutput<
    typeof beginTotpEnrollmentResultSchema
>;
export type ConfirmTotpEnrollmentInput = v.InferOutput<
    typeof confirmTotpEnrollmentInputSchema
>;
export type ConfirmTotpEnrollmentResult = v.InferOutput<
    typeof confirmTotpEnrollmentResultSchema
>;
export type ConfirmWebAuthnEnrollmentInput = v.InferOutput<
    typeof confirmWebAuthnEnrollmentInputSchema
>;
export type ConfirmWebAuthnEnrollmentResult = v.InferOutput<
    typeof confirmWebAuthnEnrollmentResultSchema
>;
export type DisableMfaInput = v.InferOutput<typeof disableMfaInputSchema>;
export type DisableMfaResult = v.InferOutput<typeof disableMfaResultSchema>;
export type PasswordReauthenticationInput = v.InferOutput<
    typeof passwordReauthenticationInputSchema
>;
export type PasswordReauthenticationResult = v.InferOutput<
    typeof passwordReauthenticationResultSchema
>;
export type RecentVerification = v.InferOutput<typeof recentVerificationSchema>;
export type RecoveryStepUpInput = v.InferOutput<typeof recoveryStepUpInputSchema>;
export type RecoveryStepUpResult = v.InferOutput<typeof recoveryStepUpResultSchema>;
export type RemoveTotpFactorInput = v.InferOutput<typeof removeTotpFactorInputSchema>;
export type RemoveTotpFactorResult = v.InferOutput<typeof removeTotpFactorResultSchema>;
export type RemoveWebAuthnCredentialInput = v.InferOutput<
    typeof removeWebAuthnCredentialInputSchema
>;
export type RemoveWebAuthnCredentialResult = v.InferOutput<
    typeof removeWebAuthnCredentialResultSchema
>;
export type RotateRecoveryCodesResult = v.InferOutput<
    typeof rotateRecoveryCodesResultSchema
>;
export type TotpEnrollment = v.InferOutput<typeof totpEnrollmentSchema>;
export type TotpFactorSummary = v.InferOutput<typeof totpFactorSummarySchema>;
export type TotpStepUpInput = v.InferOutput<typeof totpStepUpInputSchema>;
export type TotpStepUpResult = v.InferOutput<typeof totpStepUpResultSchema>;
export type WebAuthnCredentialSummary = v.InferOutput<
    typeof webAuthnCredentialSummarySchema
>;
export type WebAuthnStepUpInput = v.InferOutput<typeof webAuthnStepUpInputSchema>;
export type WebAuthnStepUpResult = v.InferOutput<typeof webAuthnStepUpResultSchema>;
