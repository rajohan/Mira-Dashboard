import type {
    AuthenticationResponseJSON,
    RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import * as v from "valibot";

import { parseContract, strictJsonObjectSchema } from "../runtime";

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

export function parseAccountPasswordRequest(value: unknown): AccountPasswordRequest {
    return parseContract(accountPasswordRequestSchema, value);
}

export function parsePasswordChangeRequest(value: unknown): PasswordChangeRequest {
    return parseContract(passwordChangeRequestSchema, value);
}

export function parseMfaCodeRequest(value: unknown): MfaCodeRequest {
    return parseContract(mfaCodeRequestSchema, value);
}

export function parseWebAuthnAuthenticationRequest(
    value: unknown
): WebAuthnAuthenticationRequest {
    return parseContract(webAuthnAuthenticationRequestSchema, value);
}

export function parseTotpEnrollmentRequest(value: unknown): TotpEnrollmentRequest {
    return parseContract(totpEnrollmentRequestSchema, value);
}

export function parseTotpConfirmationRequest(value: unknown): TotpConfirmationRequest {
    return parseContract(totpConfirmationRequestSchema, value);
}

export function parseWebAuthnRegistrationRequest(
    value: unknown
): WebAuthnRegistrationRequest {
    return parseContract(webAuthnRegistrationRequestSchema, value);
}
