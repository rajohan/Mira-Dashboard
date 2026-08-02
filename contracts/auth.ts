import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import * as v from "valibot";

import { DASHBOARD_AUTH_METHODS, DASHBOARD_MFA_METHODS } from "./accountSecurity/methods";
import { mfaCodeRequestSchema } from "./accountSecurity/requests";
import {
    finiteNumberSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);

export const firstUserRegistrationRequestSchema = strictJsonObjectSchema({
    gatewayToken: v.string(),
    password: v.string(),
    username: v.string(),
});

export const loginCredentialsRequestSchema = strictJsonObjectSchema({
    password: v.string(),
    username: v.string(),
});

export const loginMfaCodeRequestSchema = mfaCodeRequestSchema;

const authenticationResponseSchema = v.custom<AuthenticationResponseJSON>(
    (value) => value !== null && typeof value === "object" && !Array.isArray(value)
);

export const loginWebAuthnRequestSchema = strictJsonObjectSchema({
    response: authenticationResponseSchema,
});

export const dashboardUserSchema = v.strictObject({
    id: finiteNumberSchema,
    username: trimmedNonEmptyStringSchema,
});

export const authSessionDetailsSchema = v.strictObject({
    authMethod: v.picklist(DASHBOARD_AUTH_METHODS),
    expiresAt: trimmedNonEmptyStringSchema,
    lastSeenAt: trimmedNonEmptyStringSchema,
    mfaEnabled: v.boolean(),
    mfaVerifiedAt: v.optional(trimmedNonEmptyStringSchema),
    sessionId: trimmedNonEmptyStringSchema,
});

export const authSessionResponseSchema = v.strictObject({
    authenticated: v.boolean(),
    isBootstrapRequired: v.boolean(),
    session: v.optional(authSessionDetailsSchema),
    user: v.optional(dashboardUserSchema),
});

export const authBootstrapResponseSchema = v.strictObject({
    hasGatewayToken: v.boolean(),
    isBootstrapRequired: v.boolean(),
});

export const authLoginUserSchema = v.strictObject({
    id: v.optional(finiteNumberSchema),
    username: trimmedNonEmptyStringSchema,
});

export const authLoginResponseSchema = v.strictObject({
    authenticated: v.boolean(),
    methods: v.optional(v.array(v.picklist(DASHBOARD_MFA_METHODS))),
    mfaRequired: v.optional(v.boolean()),
    user: v.optional(authLoginUserSchema),
});

const webAuthnRequestOptionsSchema = v.custom<PublicKeyCredentialRequestOptionsJSON>(
    (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return false;
        }
        return v.is(nonBlankStringSchema, Reflect.get(value, "challenge"));
    }
);

export const webAuthnOptionsResponseSchema = v.strictObject({
    options: webAuthnRequestOptionsSchema,
});

export const authLogoutResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
});

export type FirstUserRegistrationRequest = v.InferOutput<
    typeof firstUserRegistrationRequestSchema
>;
export type LoginCredentialsRequest = v.InferOutput<typeof loginCredentialsRequestSchema>;
export type LoginMfaCodeRequest = v.InferOutput<typeof loginMfaCodeRequestSchema>;
export type LoginWebAuthnRequest = v.InferOutput<typeof loginWebAuthnRequestSchema>;
export type DashboardUser = v.InferOutput<typeof dashboardUserSchema>;
export type AuthSessionDetails = v.InferOutput<typeof authSessionDetailsSchema>;
export type AuthSessionResponse = v.InferOutput<typeof authSessionResponseSchema>;
export type AuthBootstrapResponse = v.InferOutput<typeof authBootstrapResponseSchema>;
export type AuthLoginUser = v.InferOutput<typeof authLoginUserSchema>;
export type AuthLoginResponse = v.InferOutput<typeof authLoginResponseSchema>;
export type WebAuthnOptionsResponse = v.InferOutput<typeof webAuthnOptionsResponseSchema>;
export type AuthLogoutResponse = v.InferOutput<typeof authLogoutResponseSchema>;

/**
 * Parses the closed first-user registration payload.
 * @param value Value to process.
 * @returns Parsed first-user registration request.
 */
export function parseFirstUserRegistrationRequest(
    value: unknown
): FirstUserRegistrationRequest {
    return parseContract(firstUserRegistrationRequestSchema, value);
}

/**
 * Parses username/password login credentials.
 * @param value Value to process.
 * @returns Parsed login credentials.
 */
export function parseLoginCredentialsRequest(value: unknown): LoginCredentialsRequest {
    return parseContract(loginCredentialsRequestSchema, value);
}

/**
 * Parses a TOTP or recovery-code login request.
 * @param value Value to process.
 * @returns Parsed login MFA-code request.
 */
export function parseLoginMfaCodeRequest(value: unknown): LoginMfaCodeRequest {
    return parseContract(loginMfaCodeRequestSchema, value);
}

/**
 * Parses a WebAuthn login assertion wrapper.
 * @param value Value to process.
 * @returns Parsed WebAuthn login request.
 */
export function parseLoginWebAuthnRequest(value: unknown): LoginWebAuthnRequest {
    return parseContract(loginWebAuthnRequestSchema, value);
}

/**
 * Parses the current Dashboard login session at the browser trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the current Dashboard login session at the browser trust boundary.
 */
export function parseAuthSessionResponse(
    value: unknown,
    path = "authSession"
): AuthSessionResponse {
    return parseContract(authSessionResponseSchema, value, path);
}

/**
 * Parses whether first-user registration is available.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed whether first-user registration is available.
 */
export function parseAuthBootstrapResponse(
    value: unknown,
    path = "authBootstrap"
): AuthBootstrapResponse {
    return parseContract(authBootstrapResponseSchema, value, path);
}

/**
 * Parses a password or second-factor authentication result.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a password or second-factor authentication result.
 */
export function parseAuthLoginResponse(
    value: unknown,
    path = "authLogin"
): AuthLoginResponse {
    return parseContract(authLoginResponseSchema, value, path);
}

/**
 * Parses the wrapper around browser-library-owned WebAuthn options.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the wrapper around browser-library-owned WebAuthn options.
 */
export function parseWebAuthnOptionsResponse(
    value: unknown,
    path = "webAuthnOptions"
): WebAuthnOptionsResponse {
    return parseContract(webAuthnOptionsResponseSchema, value, path);
}

/**
 * Parses the logout acknowledgement.
 * @param value Value to process.
 * @returns Parsed logout response.
 */
export function parseAuthLogoutResponse(value: unknown): AuthLogoutResponse {
    return parseContract(authLogoutResponseSchema, value, "authLogout");
}
