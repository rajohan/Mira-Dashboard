import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import * as v from "valibot";

import {
    nonNegativeIntegerSchema,
    parseContract,
    successLiteralSchema,
} from "../runtime";
import { dashboardMfaMethodSchema } from "./methods";
import { webAuthnCredentialSchema } from "./summary";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);

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

export function parseTotpEnrollmentResponse(
    value: unknown,
    path = "totpEnrollmentResponse"
): { enrollment: TotpEnrollment } {
    return parseContract(totpEnrollmentResponseSchema, value, path);
}

export function parsePasswordReauthenticationResponse(
    value: unknown,
    path = "passwordReauthentication"
): PasswordReauthenticationResponse {
    return parseContract(passwordReauthenticationResponseSchema, value, path);
}

export function parseMfaStepUpResponse(
    value: unknown,
    path = "mfaStepUp"
): MfaStepUpResponse {
    return parseContract(mfaStepUpResponseSchema, value, path);
}

export function parseTotpConfirmationResponse(
    value: unknown,
    path = "totpConfirmation"
): TotpConfirmationResponse {
    return parseContract(totpConfirmationResponseSchema, value, path);
}

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
