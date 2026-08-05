import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import type { ProcedureContract } from "./registry.ts";
import {
    authenticationMethodSchema,
    opaqueSelectorSchema,
    securityRecordIdSchema,
    securityUsernameSchema,
} from "./security.ts";
import { emptyInputSchema } from "./system.ts";

const authTimestampSchema = timestampMillisecondsSchema(
    "Authentication timestamp is invalid"
);

export const browserSessionMaximumPerUser = 16;
export const browserSessionUserAgentMaximumLength = 512;
export const authPasswordMinimumLength = 8;
export const authPasswordMaximumLength = 256;

function hasUnicodeCodePointLengthBetween(
    value: string,
    minimum: number,
    maximum: number
): boolean {
    let length = 0;
    for (const _codePoint of value) {
        length += 1;
        if (length > maximum) return false;
    }
    return length >= minimum;
}

/**
 * Named refinement shared with generated JSON Schema for password length parity.
 * @param value Candidate password.
 * @returns Whether the password contains 8–256 Unicode code points.
 */
export function hasValidAuthPasswordLength(value: string): boolean {
    return hasUnicodeCodePointLengthBetween(
        value,
        authPasswordMinimumLength,
        authPasswordMaximumLength
    );
}

/**
 * Named refinement shared by transport, persistence, and generated documentation.
 * @param value Candidate browser user-agent value.
 * @returns Whether the value is bounded, nonblank, and NUL-free.
 */
export function isValidBrowserSessionUserAgent(value: string): boolean {
    return (
        hasUnicodeCodePointLengthBetween(
            value,
            1,
            browserSessionUserAgentMaximumLength
        ) &&
        /\S/u.test(value) &&
        !value.includes("\0")
    );
}

/** Login username normalized before lookup without weakening the storage contract. */
export const authUsernameInputSchema = v.pipe(
    v.string("Username is invalid"),
    v.maxLength(32, "Username is invalid"),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/u, "Username is invalid"),
    v.transform((username) => username.toLowerCase())
);

/** Shared password input budget for bootstrap, login, and password change. */
export const authPasswordInputSchema = v.pipe(
    v.string("Password is invalid"),
    v.minLength(authPasswordMinimumLength, "Password is invalid"),
    v.maxLength(authPasswordMaximumLength * 2, "Password is invalid"),
    v.check(hasValidAuthPasswordLength, "Password is invalid")
);

const gatewayCredentialInputSchema = v.pipe(
    v.string("Gateway credential is invalid"),
    v.minLength(1, "Gateway credential is invalid"),
    v.maxLength(1024, "Gateway credential is invalid"),
    v.regex(/^[\u0021-\u007E]+$/u, "Gateway credential is invalid")
);

const authSessionUserAgentSchema = v.pipe(
    v.string("Session user agent is invalid"),
    v.minLength(1, "Session user agent is invalid"),
    v.maxLength(
        browserSessionUserAgentMaximumLength * 2,
        "Session user agent is invalid"
    ),
    v.check(isValidBrowserSessionUserAgent, "Session user agent is invalid")
);

export const firstUserBootstrapInputSchema = v.strictObject({
    gatewayCredential: gatewayCredentialInputSchema,
    password: authPasswordInputSchema,
    username: authUsernameInputSchema,
});

export const passwordLoginInputSchema = v.strictObject({
    password: authPasswordInputSchema,
    username: authUsernameInputSchema,
});

export const passwordChangeInputSchema = v.strictObject({
    currentPassword: authPasswordInputSchema,
    newPassword: authPasswordInputSchema,
});

export const sessionRevokeInputSchema = v.strictObject({
    sessionId: opaqueSelectorSchema,
});

export const authUserSchema = v.strictObject({
    id: securityRecordIdSchema,
    username: securityUsernameSchema,
});

export const authSessionSummarySchema = v.strictObject({
    authenticatedAtMs: authTimestampSchema,
    authMethod: authenticationMethodSchema,
    createdAtMs: authTimestampSchema,
    expiresAtMs: authTimestampSchema,
    id: opaqueSelectorSchema,
    isCurrent: v.boolean(),
    lastSeenAtMs: authTimestampSchema,
    userAgent: v.optional(authSessionUserAgentSchema),
});

export const authenticatedSessionResultSchema = v.strictObject({
    session: authSessionSummarySchema,
    user: authUserSchema,
});

const anonymousAuthStatusSchema = v.strictObject({
    authenticated: v.literal(false),
    isBootstrapRequired: v.boolean(),
});
const authenticatedAuthStatusSchema = v.strictObject({
    authenticated: v.literal(true),
    isBootstrapRequired: v.literal(false),
    session: authSessionSummarySchema,
    user: authUserSchema,
});

export const authStatusSchema = v.variant("authenticated", [
    anonymousAuthStatusSchema,
    authenticatedAuthStatusSchema,
]);

export const authSessionListSchema = v.strictObject({
    sessions: v.pipe(
        v.array(authSessionSummarySchema),
        v.maxLength(browserSessionMaximumPerUser)
    ),
});

export const authSessionTouchResultSchema = v.strictObject({
    lastSeenAtMs: authTimestampSchema,
});

export const authSessionRevokeResultSchema = v.strictObject({
    revoked: v.boolean(),
});

export const passwordChangeResultSchema = v.strictObject({
    revokedSessions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    session: authSessionSummarySchema,
});

export const okResultSchema = v.strictObject({ isOk: v.literal(true) });

const publicAccess = { kind: "public" } as const;
const sessionAccess = {
    capabilities: [],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;

/** Implemented browser authentication procedure metadata. */
export const authProcedureContracts = [
    {
        access: publicAccess,
        domain: "auth",
        errors: [],
        input: emptyInputSchema,
        inputSchemaId: "auth.status.input",
        kind: "query",
        name: "auth.status",
        output: authStatusSchema,
        outputSchemaId: "auth.status.output",
        summary: "Returns bootstrap state and the current browser session.",
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: ["CONFLICT", "SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: firstUserBootstrapInputSchema,
        inputSchemaId: "auth.bootstrap.input",
        kind: "mutation",
        name: "auth.bootstrap",
        output: authenticatedSessionResultSchema,
        outputSchemaId: "auth.bootstrap.output",
        summary: "Verifies the Gateway credential and creates the sole first user.",
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: ["CONFLICT", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: passwordLoginInputSchema,
        inputSchemaId: "auth.login.input",
        kind: "mutation",
        name: "auth.login",
        output: authenticatedSessionResultSchema,
        outputSchemaId: "auth.login.output",
        summary: "Creates a browser session after password verification.",
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: [],
        input: emptyInputSchema,
        inputSchemaId: "auth.logout.input",
        kind: "mutation",
        name: "auth.logout",
        output: okResultSchema,
        outputSchemaId: "auth.logout.output",
        summary: "Revokes the current browser session and clears its cookie.",
    },
    {
        access: sessionAccess,
        domain: "auth",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "auth.sessions.input",
        kind: "query",
        name: "auth.sessions",
        output: authSessionListSchema,
        outputSchemaId: "auth.sessions.output",
        summary: "Lists the current user's browser sessions without validators.",
    },
    {
        access: sessionAccess,
        domain: "auth",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "auth.touch.input",
        kind: "mutation",
        name: "auth.touch",
        output: authSessionTouchResultSchema,
        outputSchemaId: "auth.touch.output",
        summary: "Records explicit browser activity for the current session.",
    },
    {
        access: sessionAccess,
        domain: "auth",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: sessionRevokeInputSchema,
        inputSchemaId: "auth.revokeSession.input",
        kind: "mutation",
        name: "auth.revokeSession",
        output: authSessionRevokeResultSchema,
        outputSchemaId: "auth.revokeSession.output",
        summary: "Revokes one browser session owned by the current user.",
    },
    {
        access: sessionAccess,
        domain: "auth",
        errors: ["CONFLICT", "FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: passwordChangeInputSchema,
        inputSchemaId: "auth.changePassword.input",
        kind: "mutation",
        name: "auth.changePassword",
        output: passwordChangeResultSchema,
        outputSchemaId: "auth.changePassword.output",
        summary:
            "Changes the password, rotates the current session, and revokes the rest.",
    },
] as const satisfies readonly ProcedureContract[];

export type AuthSessionSummary = v.InferOutput<typeof authSessionSummarySchema>;
export type AuthUser = v.InferOutput<typeof authUserSchema>;
export type FirstUserBootstrapInput = v.InferOutput<typeof firstUserBootstrapInputSchema>;
export type PasswordChangeInput = v.InferOutput<typeof passwordChangeInputSchema>;
export type PasswordLoginInput = v.InferOutput<typeof passwordLoginInputSchema>;
