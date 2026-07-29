import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialCreationOptionsJSON,
    RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import * as v from "valibot";

import {
    finiteNumberSchema,
    nonNegativeIntegerSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const DASHBOARD_AUTH_METHODS = [
    "password",
    "recovery",
    "totp",
    "webauthn",
] as const;
export const DASHBOARD_MFA_METHODS = ["recovery", "totp", "webauthn"] as const;

export const dashboardAuthMethodSchema = v.picklist(DASHBOARD_AUTH_METHODS);
export const dashboardMfaMethodSchema = v.picklist(DASHBOARD_MFA_METHODS);

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);

export const accountPasswordRequestSchema = strictJsonObjectSchema({
    password: v.string(),
});

export const passwordChangeRequestSchema = strictJsonObjectSchema({
    currentPassword: v.string(),
    newPassword: v.string(),
});

export const mfaCodeRequestSchema = strictJsonObjectSchema({
    code: v.string(),
});

const webAuthnAuthenticationResponseSchema = v.custom<AuthenticationResponseJSON>(
    (value) => value !== null && typeof value === "object" && !Array.isArray(value)
);

export const webAuthnAuthenticationRequestSchema = strictJsonObjectSchema({
    response: webAuthnAuthenticationResponseSchema,
});

export const totpEnrollmentRequestSchema = strictJsonObjectSchema({
    label: v.optional(v.string()),
});

export const totpConfirmationRequestSchema = strictJsonObjectSchema({
    code: v.string(),
    factorId: v.string(),
});

const webAuthnRegistrationResponseValueSchema = v.custom<RegistrationResponseJSON>(
    (value) => value !== null && typeof value === "object" && !Array.isArray(value)
);

export const webAuthnRegistrationRequestSchema = strictJsonObjectSchema({
    label: v.optional(v.string()),
    response: webAuthnRegistrationResponseValueSchema,
});

export const totpFactorSchema = v.strictObject({
    confirmedAt: trimmedNonEmptyStringSchema,
    createdAt: trimmedNonEmptyStringSchema,
    id: trimmedNonEmptyStringSchema,
    label: v.string(),
});

export const webAuthnCredentialSchema = v.strictObject({
    backedUp: v.boolean(),
    createdAt: trimmedNonEmptyStringSchema,
    deviceType: v.picklist(["multiDevice", "singleDevice"]),
    id: trimmedNonEmptyStringSchema,
    label: v.string(),
    lastUsedAt: v.optional(nonBlankStringSchema),
});

export const dashboardAuthSessionSchema = v.strictObject({
    authMethod: dashboardAuthMethodSchema,
    authenticatedAt: trimmedNonEmptyStringSchema,
    createdAt: trimmedNonEmptyStringSchema,
    elevatedAt: v.optional(nonBlankStringSchema),
    elevatedMethod: v.optional(dashboardAuthMethodSchema),
    expiresAt: trimmedNonEmptyStringSchema,
    isCurrent: v.boolean(),
    lastSeenAt: trimmedNonEmptyStringSchema,
    mfaVerifiedAt: v.optional(nonBlankStringSchema),
    sessionId: trimmedNonEmptyStringSchema,
    userAgent: v.optional(nonBlankStringSchema),
});

const totpAvailabilitySchema = v.variant("available", [
    v.strictObject({ available: v.literal(true) }),
    v.strictObject({
        available: v.literal(false),
        reason: v.literal("encryption_key_not_configured"),
    }),
]);

const webAuthnAvailabilitySchema = v.variant("available", [
    v.strictObject({
        available: v.literal(true),
        rpId: trimmedNonEmptyStringSchema,
    }),
    v.strictObject({
        available: v.literal(false),
        reason: v.literal("not_configured"),
    }),
]);

export const accountSecuritySummarySchema = v.strictObject({
    factors: v.strictObject({
        enabledAt: v.optional(nonBlankStringSchema),
        methods: v.array(dashboardMfaMethodSchema),
        recoveryCodesRemaining: finiteNumberSchema,
        totpFactors: v.array(totpFactorSchema),
        webAuthnCredentials: v.array(webAuthnCredentialSchema),
    }),
    recentVerification: v.strictObject({
        mfa: v.boolean(),
        mfaRemainingMs: v.optional(finiteNumberSchema),
        mfaUntil: v.optional(nonBlankStringSchema),
        password: v.boolean(),
        passwordUntil: v.optional(nonBlankStringSchema),
    }),
    recommendation: v.strictObject({
        minimumSecurityKeys: finiteNumberSchema,
        needsBackupSecurityKey: v.boolean(),
    }),
    sessions: v.array(dashboardAuthSessionSchema),
    totp: totpAvailabilitySchema,
    webAuthn: webAuthnAvailabilitySchema,
});

export const totpEnrollmentSchema = v.strictObject({
    factorId: trimmedNonEmptyStringSchema,
    label: v.string(),
    otpauthUri: trimmedNonEmptyStringSchema,
    secret: trimmedNonEmptyStringSchema,
});

export const totpEnrollmentResponseSchema = v.strictObject({
    enrollment: totpEnrollmentSchema,
});

export const factorConfirmationSchema = v.strictObject({
    enabledMfa: v.boolean(),
    recoveryCodes: v.optional(v.array(trimmedNonEmptyStringSchema)),
});

export const passwordReauthenticationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    verifiedAt: trimmedNonEmptyStringSchema,
});

export const mfaStepUpResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    method: dashboardMfaMethodSchema,
    verifiedAt: trimmedNonEmptyStringSchema,
});

export const totpConfirmationResponseSchema = v.strictObject({
    factorId: trimmedNonEmptyStringSchema,
    isOk: successLiteralSchema,
    recoveryCodes: v.optional(v.array(trimmedNonEmptyStringSchema)),
    sessionRotated: v.boolean(),
});

export const webAuthnRegistrationResponseSchema = v.strictObject({
    credential: webAuthnCredentialSchema,
    isOk: successLiteralSchema,
    recoveryCodes: v.optional(v.array(trimmedNonEmptyStringSchema)),
    sessionRotated: v.boolean(),
});

export const accountSecurityMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
});

export const passwordChangeResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    revokedSessions: nonNegativeIntegerSchema,
});

const webAuthnRegistrationOptionsSchema =
    v.custom<PublicKeyCredentialCreationOptionsJSON>((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return false;
        }
        return (
            v.is(nonBlankStringSchema, Reflect.get(value, "challenge")) &&
            Array.isArray(Reflect.get(value, "pubKeyCredParams")) &&
            v.is(v.record(v.string(), v.unknown()), Reflect.get(value, "rp")) &&
            v.is(v.record(v.string(), v.unknown()), Reflect.get(value, "user"))
        );
    });

export const webAuthnRegistrationOptionsResponseSchema = v.strictObject({
    options: webAuthnRegistrationOptionsSchema,
});

export const recoveryCodesResponseSchema = v.strictObject({
    recoveryCodes: v.array(nonBlankStringSchema),
});

export const sessionRevocationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    loggedOut: v.boolean(),
});

export const sessionsRevocationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    revoked: nonNegativeIntegerSchema,
});

export type DashboardAuthMethod = v.InferOutput<typeof dashboardAuthMethodSchema>;
export type DashboardMfaMethod = v.InferOutput<typeof dashboardMfaMethodSchema>;
export type AccountPasswordRequest = v.InferOutput<typeof accountPasswordRequestSchema>;
export type PasswordChangeRequest = v.InferOutput<typeof passwordChangeRequestSchema>;
export type MfaCodeRequest = v.InferOutput<typeof mfaCodeRequestSchema>;
export type WebAuthnAuthenticationRequest = v.InferOutput<
    typeof webAuthnAuthenticationRequestSchema
>;
export type TotpEnrollmentRequest = v.InferOutput<typeof totpEnrollmentRequestSchema>;
export type TotpConfirmationRequest = v.InferOutput<typeof totpConfirmationRequestSchema>;
export type WebAuthnRegistrationRequest = v.InferOutput<
    typeof webAuthnRegistrationRequestSchema
>;
export type TotpFactor = v.InferOutput<typeof totpFactorSchema>;
export type WebAuthnCredential = v.InferOutput<typeof webAuthnCredentialSchema>;
export type DashboardAuthSession = v.InferOutput<typeof dashboardAuthSessionSchema>;
export type AccountSecuritySummary = v.InferOutput<typeof accountSecuritySummarySchema>;
export type TotpEnrollment = v.InferOutput<typeof totpEnrollmentSchema>;
export type FactorConfirmation = v.InferOutput<typeof factorConfirmationSchema>;
export type PasswordReauthenticationResponse = v.InferOutput<
    typeof passwordReauthenticationResponseSchema
>;
export type MfaStepUpResponse = v.InferOutput<typeof mfaStepUpResponseSchema>;
export type TotpConfirmationResponse = v.InferOutput<
    typeof totpConfirmationResponseSchema
>;
export type WebAuthnRegistrationResponse = v.InferOutput<
    typeof webAuthnRegistrationResponseSchema
>;
export type AccountSecurityMutationResponse = v.InferOutput<
    typeof accountSecurityMutationResponseSchema
>;
export type PasswordChangeResponse = v.InferOutput<typeof passwordChangeResponseSchema>;
export type WebAuthnRegistrationOptionsResponse = v.InferOutput<
    typeof webAuthnRegistrationOptionsResponseSchema
>;
export type RecoveryCodesResponse = v.InferOutput<typeof recoveryCodesResponseSchema>;
export type SessionRevocationResponse = v.InferOutput<
    typeof sessionRevocationResponseSchema
>;
export type SessionsRevocationResponse = v.InferOutput<
    typeof sessionsRevocationResponseSchema
>;

/**
 * Parses a password-only account-security request.
 * @param value Value to process.
 * @returns Parsed password request.
 */
export function parseAccountPasswordRequest(value: unknown): AccountPasswordRequest {
    return parseContract(accountPasswordRequestSchema, value);
}

/**
 * Parses a password-change request.
 * @param value Value to process.
 * @returns Parsed password-change request.
 */
export function parsePasswordChangeRequest(value: unknown): PasswordChangeRequest {
    return parseContract(passwordChangeRequestSchema, value);
}

/**
 * Parses an authenticator or recovery-code request.
 * @param value Value to process.
 * @returns Parsed MFA-code request.
 */
export function parseMfaCodeRequest(value: unknown): MfaCodeRequest {
    return parseContract(mfaCodeRequestSchema, value);
}

/**
 * Parses a WebAuthn authentication assertion wrapper.
 * @param value Value to process.
 * @returns Parsed WebAuthn authentication request.
 */
export function parseWebAuthnAuthenticationRequest(
    value: unknown
): WebAuthnAuthenticationRequest {
    return parseContract(webAuthnAuthenticationRequestSchema, value);
}

/**
 * Parses a TOTP enrollment request.
 * @param value Value to process.
 * @returns Parsed TOTP enrollment request.
 */
export function parseTotpEnrollmentRequest(value: unknown): TotpEnrollmentRequest {
    return parseContract(totpEnrollmentRequestSchema, value);
}

/**
 * Parses a TOTP confirmation request.
 * @param value Value to process.
 * @returns Parsed TOTP confirmation request.
 */
export function parseTotpConfirmationRequest(value: unknown): TotpConfirmationRequest {
    return parseContract(totpConfirmationRequestSchema, value);
}

/**
 * Parses a WebAuthn registration response wrapper.
 * @param value Value to process.
 * @returns Parsed WebAuthn registration request.
 */
export function parseWebAuthnRegistrationRequest(
    value: unknown
): WebAuthnRegistrationRequest {
    return parseContract(webAuthnRegistrationRequestSchema, value);
}

/**
 * Parses the account-security summary at the browser HTTP trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the account-security summary at the browser HTTP trust boundary.
 */
export function parseAccountSecuritySummary(
    value: unknown,
    path = "accountSecurity"
): AccountSecuritySummary {
    return parseContract(accountSecuritySummarySchema, value, path);
}

/**
 * Parses a newly created TOTP enrollment response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a newly created TOTP enrollment response.
 */
export function parseTotpEnrollmentResponse(
    value: unknown,
    path = "totpEnrollmentResponse"
): { enrollment: TotpEnrollment } {
    return parseContract(totpEnrollmentResponseSchema, value, path);
}

/**
 * Parses a password reauthentication response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed password reauthentication response.
 */
export function parsePasswordReauthenticationResponse(
    value: unknown,
    path = "passwordReauthentication"
): PasswordReauthenticationResponse {
    return parseContract(passwordReauthenticationResponseSchema, value, path);
}

/**
 * Parses a successful MFA step-up response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed MFA step-up response.
 */
export function parseMfaStepUpResponse(
    value: unknown,
    path = "mfaStepUp"
): MfaStepUpResponse {
    return parseContract(mfaStepUpResponseSchema, value, path);
}

/**
 * Parses a confirmed TOTP enrollment response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed TOTP confirmation response.
 */
export function parseTotpConfirmationResponse(
    value: unknown,
    path = "totpConfirmation"
): TotpConfirmationResponse {
    return parseContract(totpConfirmationResponseSchema, value, path);
}

/**
 * Parses a completed WebAuthn registration response.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed WebAuthn registration response.
 */
export function parseWebAuthnRegistrationResponse(
    value: unknown,
    path = "webAuthnRegistration"
): WebAuthnRegistrationResponse {
    return parseContract(webAuthnRegistrationResponseSchema, value, path);
}

export function parseAccountSecurityMutationResponse(
    value: unknown,
    path = "accountSecurityMutation"
): AccountSecurityMutationResponse {
    return parseContract(accountSecurityMutationResponseSchema, value, path);
}

export function parsePasswordChangeResponse(
    value: unknown,
    path = "passwordChange"
): PasswordChangeResponse {
    return parseContract(passwordChangeResponseSchema, value, path);
}

/**
 * Parses browser-library-owned WebAuthn registration options.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed browser-library-owned WebAuthn registration options.
 */
export function parseWebAuthnRegistrationOptionsResponse(
    value: unknown,
    path = "webAuthnRegistrationOptions"
): WebAuthnRegistrationOptionsResponse {
    return parseContract(webAuthnRegistrationOptionsResponseSchema, value, path);
}

export function parseRecoveryCodesResponse(
    value: unknown,
    path = "recoveryCodes"
): RecoveryCodesResponse {
    return parseContract(recoveryCodesResponseSchema, value, path);
}

export function parseSessionRevocationResponse(
    value: unknown,
    path = "sessionRevocation"
): SessionRevocationResponse {
    return parseContract(sessionRevocationResponseSchema, value, path);
}

export function parseSessionsRevocationResponse(
    value: unknown,
    path = "sessionsRevocation"
): SessionsRevocationResponse {
    return parseContract(sessionsRevocationResponseSchema, value, path);
}
