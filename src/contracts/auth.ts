import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { hasUniqueArrayItems } from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";
import {
    authenticationMethodSchema,
    type MultiFactorAuthenticationMethod,
    multiFactorAuthenticationMethodSchema,
    multiFactorAuthenticationMethods,
    opaqueSelectorSchema,
    securityRecordIdSchema,
    securityUsernameSchema,
} from "./security.ts";
import { emptyInputSchema } from "./system.ts";
import {
    webAuthnAuthenticationInputSchema,
    webAuthnAuthenticationOptionsSchema,
} from "./webauthn.ts";

const authTimestampSchema = timestampMillisecondsSchema(
    "Authentication timestamp is invalid"
);

export const browserSessionMaximumPerUser = 16;
export const browserSessionUserAgentMaximumLength = 512;
export const authPasswordMinimumLength = 8;
export const authPasswordMaximumLength = 256;
export const recoveryCodeLength = 65;
export const authEmailMaximumLength = 254;

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
    v.string("Enter a username."),
    v.minLength(1, "Enter a username."),
    v.maxLength(
        32,
        "Use 3–32 letters, numbers, periods, underscores, or hyphens. Start with a letter or number."
    ),
    v.regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/u,
        "Use 3–32 letters, numbers, periods, underscores, or hyphens. Start with a letter or number."
    ),
    v.transform((username) => username.toLowerCase())
);

/** Canonical account email used only for security notifications and recovery. */
/**
 * @param email Validated account email.
 * @returns Canonical lowercase account email.
 */
export function canonicalizeAuthEmail(email: string): string {
    return email.toLowerCase();
}

export const authEmailInputSchema = v.pipe(
    v.string("Enter an email address."),
    v.maxLength(authEmailMaximumLength, "Enter a valid email address."),
    v.email("Enter a valid email address."),
    v.transform(canonicalizeAuthEmail)
);

/** Shared password input budget for bootstrap, login, and password change. */
export const authPasswordInputSchema = v.pipe(
    v.string("Enter a password."),
    v.minLength(1, "Enter a password."),
    v.maxLength(authPasswordMaximumLength * 2, "Password must contain 8–256 characters."),
    v.check(hasValidAuthPasswordLength, "Password must contain 8–256 characters.")
);

/** Exact six-digit authenticator-app proof. */
export const totpCodeInputSchema = v.pipe(
    v.string("Enter the 6-digit code from your authenticator app."),
    v.length(6, "Enter the 6-digit code from your authenticator app."),
    v.regex(/^\d{6}$/u, "Enter the 6-digit code from your authenticator app.")
);

/** Canonical one-time recovery code returned only at generation time. */
export const recoveryCodeSchema = v.pipe(
    v.string("Recovery code is invalid"),
    v.length(recoveryCodeLength, "Recovery code is invalid"),
    v.regex(/^[0-9a-f]{32}-[0-9a-f]{32}$/u, "Recovery code is invalid")
);

/** Recovery proof normalized only after its exact shape has been validated. */
export const recoveryCodeInputSchema = v.pipe(
    v.string(
        "Enter the full recovery code, including the hyphen between both 32-character parts."
    ),
    v.maxLength(
        128,
        "Enter the full recovery code, including the hyphen between both 32-character parts."
    ),
    v.regex(
        /^\s*[0-9A-Fa-f]{32}-[0-9A-Fa-f]{32}\s*$/u,
        "Enter the full recovery code, including the hyphen between both 32-character parts."
    ),
    v.transform((code) => code.trim().toLowerCase())
);

const gatewayCredentialInputSchema = v.pipe(
    v.string("Enter the OpenClaw Gateway credential."),
    v.minLength(1, "Enter the OpenClaw Gateway credential."),
    v.maxLength(1024, "Use 1–1,024 printable characters with no spaces."),
    v.regex(/^[\u0021-\u007E]+$/u, "Use 1–1,024 printable characters with no spaces.")
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
    email: authEmailInputSchema,
    gatewayCredential: gatewayCredentialInputSchema,
    password: authPasswordInputSchema,
    username: authUsernameInputSchema,
});

export const passwordLoginInputSchema = v.strictObject({
    password: authPasswordInputSchema,
    username: authUsernameInputSchema,
});

export const totpLoginInputSchema = v.strictObject({
    code: totpCodeInputSchema,
});

export const recoveryLoginInputSchema = v.strictObject({
    code: recoveryCodeInputSchema,
});

export const beginWebAuthnLoginResultSchema = v.strictObject({
    expiresAtMs: authTimestampSchema,
    options: webAuthnAuthenticationOptionsSchema,
});

export const webAuthnLoginInputSchema = webAuthnAuthenticationInputSchema;

export const passwordChangeInputSchema = v.strictObject({
    currentPassword: authPasswordInputSchema,
    newPassword: authPasswordInputSchema,
});

export const emailChangeInputSchema = v.strictObject({
    email: authEmailInputSchema,
});

export const emailChangeResultSchema = v.strictObject({
    email: authEmailInputSchema,
});

export const emailVerificationInputSchema = v.strictObject({
    token: v.pipe(
        v.string("Email-verification link is invalid or expired."),
        v.length(97, "Email-verification link is invalid or expired."),
        v.regex(
            /^[0-9a-f]{32}\.[0-9a-f]{64}$/u,
            "Email-verification link is invalid or expired."
        )
    ),
});

export const emailVerificationResultSchema = v.strictObject({
    email: authEmailInputSchema,
});

const passwordResetTokenSchema = v.pipe(
    v.string("Password-reset link is invalid or expired."),
    v.length(97, "Password-reset link is invalid or expired."),
    v.regex(/^[0-9a-f]{32}\.[0-9a-f]{64}$/u, "Password-reset link is invalid or expired.")
);

export const passwordResetRequestInputSchema = v.strictObject({
    username: authUsernameInputSchema,
});

export const passwordResetInputSchema = v.strictObject({
    password: authPasswordInputSchema,
    token: passwordResetTokenSchema,
});

export const passwordResetResultSchema = v.strictObject({
    reset: v.literal(true),
});

export const sessionRevokeInputSchema = v.strictObject({
    sessionId: opaqueSelectorSchema,
});

export const authUserSchema = v.strictObject({
    email: authEmailInputSchema,
    emailVerified: v.optional(v.boolean()),
    id: securityRecordIdSchema,
    pendingEmail: v.optional(authEmailInputSchema),
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

const pendingLoginMethodsSchema = v.pipe(
    v.array(multiFactorAuthenticationMethodSchema, "Pending login methods are invalid"),
    v.minLength(1, "Pending login requires at least one method"),
    v.maxLength(
        multiFactorAuthenticationMethods.length,
        "Pending login has too many methods"
    ),
    v.check(
        hasUniqueArrayItems<MultiFactorAuthenticationMethod>,
        "Pending login methods must be unique"
    )
);

export const pendingLoginSummarySchema = v.strictObject({
    expiresAtMs: authTimestampSchema,
    methods: pendingLoginMethodsSchema,
    username: securityUsernameSchema,
});

const authenticatedPasswordLoginResultSchema = v.strictObject({
    session: authSessionSummarySchema,
    status: v.literal("authenticated"),
    user: authUserSchema,
});
const pendingPasswordLoginResultSchema = v.strictObject({
    pendingLogin: pendingLoginSummarySchema,
    status: v.literal("mfa-required"),
});

export const passwordLoginResultSchema = v.variant("status", [
    authenticatedPasswordLoginResultSchema,
    pendingPasswordLoginResultSchema,
]);

const bootstrapRequiredAuthStatusSchema = v.strictObject({
    state: v.literal("bootstrap-required"),
});
const anonymousAuthStatusSchema = v.strictObject({
    state: v.literal("anonymous"),
});
const pendingAuthStatusSchema = v.strictObject({
    pendingLogin: pendingLoginSummarySchema,
    state: v.literal("pending-mfa"),
});
const authenticatedAuthStatusSchema = v.strictObject({
    pendingLogin: v.optional(pendingLoginSummarySchema),
    session: authSessionSummarySchema,
    state: v.literal("authenticated"),
    user: authUserSchema,
});

export const authStatusSchema = v.variant("state", [
    bootstrapRequiredAuthStatusSchema,
    anonymousAuthStatusSchema,
    pendingAuthStatusSchema,
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

export const authSessionsRevokeResultSchema = v.strictObject({
    revokedSessions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export const passwordChangeResultSchema = v.strictObject({
    revokedSessions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    session: authSessionSummarySchema,
});

export const okResultSchema = v.strictObject({ isOk: v.literal(true) });

const publicAccess = { kind: "public" } as const;
const pendingLoginAccess = { kind: "pending-login" } as const;
const sessionAccess = {
    capabilities: [],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const passwordChangeAccess = {
    kind: "recent-auth",
    whenMfaDisabled: "session",
    whenMfaEnabled: "mfa",
} as const;
const sessionMutationAccess = {
    kind: "recent-auth",
    whenMfaDisabled: "password",
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
const webAuthnAuthenticationMutationTransport = {
    ...authenticationMutationTransport,
    requestBody: "webauthn",
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
        summary: "Returns bootstrap, pending MFA, and current browser-session state.",
        transport: authenticationReadTransport,
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
        transport: authenticationMutationTransport,
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: ["CONFLICT", "SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: passwordLoginInputSchema,
        inputSchemaId: "auth.login.input",
        kind: "mutation",
        name: "auth.login",
        output: passwordLoginResultSchema,
        outputSchemaId: "auth.login.output",
        summary:
            "Creates a session or a five-minute pending MFA login after password verification.",
        transport: authenticationMutationTransport,
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: ["CONFLICT", "UNAUTHORIZED"],
        input: emailVerificationInputSchema,
        inputSchemaId: "auth.verifyEmail.input",
        kind: "mutation",
        name: "auth.verifyEmail",
        output: emailVerificationResultSchema,
        outputSchemaId: "auth.verifyEmail.output",
        summary: "Consumes a short-lived link before activating an account email.",
        transport: authenticationMutationTransport,
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS"],
        input: passwordResetRequestInputSchema,
        inputSchemaId: "auth.requestPasswordReset.input",
        kind: "mutation",
        name: "auth.requestPasswordReset",
        output: okResultSchema,
        outputSchemaId: "auth.requestPasswordReset.output",
        summary: "Requests one generic, rate-limited account recovery email.",
        transport: authenticationMutationTransport,
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: ["TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: passwordResetInputSchema,
        inputSchemaId: "auth.resetPassword.input",
        kind: "mutation",
        name: "auth.resetPassword",
        output: passwordResetResultSchema,
        outputSchemaId: "auth.resetPassword.output",
        summary: "Consumes one short-lived recovery token and revokes every session.",
        transport: authenticationMutationTransport,
    },
    {
        access: pendingLoginAccess,
        domain: "auth",
        errors: ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: totpLoginInputSchema,
        inputSchemaId: "auth.loginTotp.input",
        kind: "mutation",
        name: "auth.loginTotp",
        output: authenticatedSessionResultSchema,
        outputSchemaId: "auth.loginTotp.output",
        summary:
            "Consumes a pending login with a TOTP proof and creates the browser session.",
        transport: authenticationMutationTransport,
    },
    {
        access: pendingLoginAccess,
        domain: "auth",
        errors: ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: recoveryLoginInputSchema,
        inputSchemaId: "auth.loginRecovery.input",
        kind: "mutation",
        name: "auth.loginRecovery",
        output: authenticatedSessionResultSchema,
        outputSchemaId: "auth.loginRecovery.output",
        summary:
            "Consumes a pending login and one recovery code to create the browser session.",
        transport: authenticationMutationTransport,
    },
    {
        access: pendingLoginAccess,
        domain: "auth",
        errors: ["CONFLICT", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "auth.beginWebAuthnLogin.input",
        kind: "mutation",
        name: "auth.beginWebAuthnLogin",
        output: beginWebAuthnLoginResultSchema,
        outputSchemaId: "auth.beginWebAuthnLogin.output",
        summary: "Creates one pending-login-bound WebAuthn assertion challenge.",
        transport: authenticationMutationTransport,
    },
    {
        access: pendingLoginAccess,
        domain: "auth",
        errors: ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
        input: webAuthnLoginInputSchema,
        inputSchemaId: "auth.loginWebAuthn.input",
        kind: "mutation",
        name: "auth.loginWebAuthn",
        output: authenticatedSessionResultSchema,
        outputSchemaId: "auth.loginWebAuthn.output",
        summary:
            "Consumes a pending login and WebAuthn challenge to create the browser session.",
        transport: webAuthnAuthenticationMutationTransport,
    },
    {
        access: publicAccess,
        domain: "auth",
        errors: ["SERVICE_UNAVAILABLE"],
        input: emptyInputSchema,
        inputSchemaId: "auth.logout.input",
        kind: "mutation",
        name: "auth.logout",
        output: okResultSchema,
        outputSchemaId: "auth.logout.output",
        summary:
            "Revokes current session and pending-login state and clears both cookies.",
        transport: authenticationMutationTransport,
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
        transport: authenticationReadTransport,
    },
    {
        access: sessionAccess,
        domain: "auth",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "auth.touch.input",
        kind: "mutation",
        name: "auth.touch",
        output: authSessionTouchResultSchema,
        outputSchemaId: "auth.touch.output",
        summary: "Records explicit browser activity for the current session.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionMutationAccess,
        domain: "auth",
        errorReasons: ["step_up_required"],
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: sessionRevokeInputSchema,
        inputSchemaId: "auth.revokeSession.input",
        kind: "mutation",
        name: "auth.revokeSession",
        output: authSessionRevokeResultSchema,
        outputSchemaId: "auth.revokeSession.output",
        summary: "Revokes one browser session owned by the current user.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionMutationAccess,
        domain: "auth",
        errorReasons: ["step_up_required"],
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "auth.revokeOtherSessions.input",
        kind: "mutation",
        name: "auth.revokeOtherSessions",
        output: authSessionsRevokeResultSchema,
        outputSchemaId: "auth.revokeOtherSessions.output",
        summary: "Revokes every browser session except the current session.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionMutationAccess,
        domain: "auth",
        errorReasons: ["step_up_required"],
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "auth.revokeAllSessions.input",
        kind: "mutation",
        name: "auth.revokeAllSessions",
        output: authSessionsRevokeResultSchema,
        outputSchemaId: "auth.revokeAllSessions.output",
        summary: "Revokes every browser session, including the current session.",
        transport: authenticationMutationTransport,
    },
    {
        access: sessionMutationAccess,
        domain: "auth",
        errorReasons: ["step_up_required"],
        errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emailChangeInputSchema,
        inputSchemaId: "auth.changeEmail.input",
        kind: "mutation",
        name: "auth.changeEmail",
        output: emailChangeResultSchema,
        outputSchemaId: "auth.changeEmail.output",
        summary: "Changes the account email used for password recovery.",
        transport: authenticationMutationTransport,
    },
    {
        access: passwordChangeAccess,
        domain: "auth",
        errorReasons: ["step_up_required"],
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: passwordChangeInputSchema,
        inputSchemaId: "auth.changePassword.input",
        kind: "mutation",
        name: "auth.changePassword",
        output: passwordChangeResultSchema,
        outputSchemaId: "auth.changePassword.output",
        summary:
            "Changes the password, rotates the current session, and revokes the rest.",
        transport: authenticationMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

export type AuthSessionSummary = v.InferOutput<typeof authSessionSummarySchema>;
export type AuthStatus = v.InferOutput<typeof authStatusSchema>;
export type AuthUser = v.InferOutput<typeof authUserSchema>;
export type EmailVerificationInput = v.InferOutput<typeof emailVerificationInputSchema>;
export type EmailChangeInput = v.InferOutput<typeof emailChangeInputSchema>;
export type PasswordResetInput = v.InferOutput<typeof passwordResetInputSchema>;
export type PasswordResetRequestInput = v.InferOutput<
    typeof passwordResetRequestInputSchema
>;
export type BeginWebAuthnLoginResult = v.InferOutput<
    typeof beginWebAuthnLoginResultSchema
>;
export type FirstUserBootstrapInput = v.InferOutput<typeof firstUserBootstrapInputSchema>;
export type PasswordLoginResult = v.InferOutput<typeof passwordLoginResultSchema>;
export type PasswordChangeInput = v.InferOutput<typeof passwordChangeInputSchema>;
export type PasswordLoginInput = v.InferOutput<typeof passwordLoginInputSchema>;
export type PendingLoginSummary = v.InferOutput<typeof pendingLoginSummarySchema>;
export type RecoveryCode = v.InferOutput<typeof recoveryCodeSchema>;
export type RecoveryCodeInput = v.InferOutput<typeof recoveryCodeInputSchema>;
export type RecoveryLoginInput = v.InferOutput<typeof recoveryLoginInputSchema>;
export type TotpLoginInput = v.InferOutput<typeof totpLoginInputSchema>;
export type WebAuthnLoginInput = v.InferOutput<typeof webAuthnLoginInputSchema>;
