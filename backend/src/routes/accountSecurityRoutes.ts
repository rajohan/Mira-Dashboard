import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Server } from "bun";

import {
    type AuthMethod,
    type AuthSession,
    changePasswordAndRotateSession,
    createSession,
    didRevokeUserSession,
    findUserById,
    hasRecentMfaVerification,
    hasRecentPasswordVerification,
    listUserSessions,
    recentAuthenticationTtlMs,
    revokeUserSessions,
    rotateSession,
    verifyPassword,
} from "../auth.ts";
import {
    authSession,
    clearPendingLoginCookie,
    clearSessionCookie,
    HttpError,
    json,
    readJson,
    sessionCookie,
    sessionIdFromCookie,
    withCookies,
} from "../http.ts";
import { currentRequestAuditContext } from "../requestAuditContext.ts";
import { writeAuditEvent } from "../services/auditEvents.ts";
import {
    authenticationThrottleResponse,
    parseAuthenticationResponse,
} from "../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../services/authenticationThrottle.ts";
import { secretEncryptionKeyBytes } from "../services/mfaCrypto.ts";
import {
    confirmTotpEnrollment,
    createTotpEnrollment,
    didRemoveTotpFactor,
    disableMultiFactor,
    getMultiFactorSummary,
    normalizeFactorId,
    normalizeFactorLabel,
    rotateRecoveryCodes,
    verifyRecoveryCodeForUser,
    verifyTotpForUser,
} from "../services/multiFactorAuth.ts";
import {
    createWebAuthnAuthenticationOptions,
    createWebAuthnRegistrationOptions,
    didRemoveWebAuthnCredential,
    verifyWebAuthnAuthentication,
    verifyWebAuthnRegistration,
    webAuthnConfig,
} from "../services/webAuthn.ts";

type ParametersRequest<T extends string> = Request & {
    params: Record<T, string>;
};

interface SecurityBody {
    code?: unknown;
    currentPassword?: unknown;
    factorId?: unknown;
    label?: unknown;
    newPassword?: unknown;
    password?: unknown;
    response?: unknown;
}

interface SecurityRequestContext {
    session: AuthSession;
    sessionToken: string;
}

interface AccountSecurityWebAuthnDependencies {
    createAuthenticationOptions: typeof createWebAuthnAuthenticationOptions;
    createRegistrationOptions: typeof createWebAuthnRegistrationOptions;
    verifyAuthentication: typeof verifyWebAuthnAuthentication;
    verifyRegistration: typeof verifyWebAuthnRegistration;
}

const defaultWebAuthnDependencies: AccountSecurityWebAuthnDependencies = {
    createAuthenticationOptions: createWebAuthnAuthenticationOptions,
    createRegistrationOptions: createWebAuthnRegistrationOptions,
    verifyAuthentication: verifyWebAuthnAuthentication,
    verifyRegistration: verifyWebAuthnRegistration,
};

const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/u;

async function readSecurityBody(request: Request): Promise<SecurityBody | Response> {
    try {
        const body = await readJson<unknown>(request, {
            maxBytes: 256 * 1024,
        });
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return json({ error: "Invalid request body" }, { status: 400 });
        }
        return body as SecurityBody;
    } catch (error) {
        return error instanceof HttpError
            ? json({ error: error.message }, { status: error.statusCode })
            : json({ error: "Invalid request body" }, { status: 400 });
    }
}

function requestContext(request: Request): SecurityRequestContext | Response {
    const sessionToken = sessionIdFromCookie(request);
    const session = sessionToken ? authSession(request) : undefined;
    return sessionToken && session
        ? { session, sessionToken }
        : json({ error: "Unauthorized" }, { status: 401 });
}

function normalizedCode(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

function normalizedPassword(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= 256
        ? value
        : undefined;
}

function registrationResponse(value: unknown): RegistrationResponseJSON | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Partial<RegistrationResponseJSON>;
    return typeof candidate.id === "string" &&
        typeof candidate.rawId === "string" &&
        candidate.type === "public-key" &&
        candidate.response &&
        typeof candidate.response === "object"
        ? (candidate as RegistrationResponseJSON)
        : undefined;
}

function recentVerificationRequired(): Response {
    return json(
        {
            code: "recent_verification_required",
            error: "Recent verification is required",
        },
        { status: 403 }
    );
}

function canManageFactors(session: AuthSession): boolean {
    return session.mfaEnabled
        ? hasRecentMfaVerification(session)
        : hasRecentPasswordVerification(session);
}

function securityEvent(
    action: string,
    targetId: string,
    metadata: Record<string, unknown> = {}
): void {
    const context = currentRequestAuditContext();
    if (!context) return;
    writeAuditEvent({
        actor: context.actor,
        action,
        metadata,
        outcome: "succeeded",
        requestId: context.requestId,
        targetId,
        targetType: "account-security",
    });
}

function credentialAuditTargetId(credentialId: string): string {
    return credentialId.length <= 256
        ? credentialId
        : `sha256:${new Bun.CryptoHasher("sha256").update(credentialId).digest("hex")}`;
}

function recentUntil(timestamp: string | undefined): string | undefined {
    if (!timestamp) return undefined;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed)
        ? new Date(parsed + recentAuthenticationTtlMs()).toISOString()
        : undefined;
}

function securitySummary(context: SecurityRequestContext) {
    const factors = getMultiFactorSummary(context.session.id);
    const totp = (() => {
        try {
            secretEncryptionKeyBytes();
            return { available: true as const };
        } catch {
            return {
                available: false as const,
                reason: "encryption_key_not_configured" as const,
            };
        }
    })();
    const webAuthn = (() => {
        try {
            const config = webAuthnConfig();
            return {
                available: true as const,
                rpId: config.rpId,
            };
        } catch {
            return {
                available: false as const,
                reason: "not_configured" as const,
            };
        }
    })();
    return {
        factors,
        recommendation: {
            minimumSecurityKeys: 2,
            needsBackupSecurityKey:
                factors.webAuthnCredentials.length > 0 &&
                factors.webAuthnCredentials.length < 2,
        },
        recentVerification: {
            mfa: hasRecentMfaVerification(context.session),
            mfaUntil: recentUntil(context.session.mfaVerifiedAt),
            password: hasRecentPasswordVerification(context.session),
            passwordUntil:
                context.session.elevatedMethod === "password"
                    ? recentUntil(context.session.elevatedAt)
                    : undefined,
        },
        sessions: listUserSessions(context.session.id, context.session.sessionId),
        totp,
        webAuthn,
    };
}

function rotateAfterVerification(
    request: Request,
    server: Server<unknown>,
    context: SecurityRequestContext,
    method: Exclude<AuthMethod, "password">
): Response {
    const timestamp = new Date().toISOString();
    const rotated = rotateSession(context.sessionToken, {
        elevatedAt: timestamp,
        elevatedMethod: method,
        mfaVerifiedAt: timestamp,
        userAgent: request.headers.get("user-agent") ?? context.session.userAgent,
    });
    if (!rotated) {
        return json({ error: "Session rotation failed" }, { status: 409 });
    }
    securityEvent("account.step-up", String(context.session.id), { method });
    return withCookies(json({ isOk: true, method, verifiedAt: timestamp }), [
        sessionCookie(request, server, rotated),
    ]);
}

function upgradeAfterFirstFactor(
    request: Request,
    server: Server<unknown>,
    context: SecurityRequestContext,
    method: "totp" | "webauthn",
    responseBody: Record<string, unknown>
): Response {
    const timestamp = new Date().toISOString();
    revokeUserSessions(context.session.id, context.session.sessionId);
    const rotated = rotateSession(context.sessionToken, {
        elevatedAt: timestamp,
        elevatedMethod: method,
        mfaVerifiedAt: timestamp,
        userAgent: request.headers.get("user-agent") ?? context.session.userAgent,
    });
    if (!rotated) {
        revokeUserSessions(context.session.id);
        return withCookies(
            json(
                {
                    error: "MFA was enabled, but the session upgrade failed; sign in again",
                },
                { status: 409 }
            ),
            [clearSessionCookie(request, server)]
        );
    }
    return withCookies(json(responseBody), [sessionCookie(request, server, rotated)]);
}

export function createAccountSecurityRoutes(
    webAuthn: AccountSecurityWebAuthnDependencies = defaultWebAuthnDependencies
) {
    return {
        "/api/account/security": {
            GET: (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                return context instanceof Response
                    ? context
                    : json(securitySummary(context));
            },
        },

        "/api/account/security/reauth/password": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                const password = normalizedPassword(body.password);
                const user = findUserById(context.session.id);
                if (
                    !password ||
                    !user ||
                    !(await verifyPassword(password, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return json({ error: "Invalid current password" }, { status: 400 });
                }
                clearAuthenticationFailures("account-password", context.session.id);
                const timestamp = new Date().toISOString();
                const rotated = rotateSession(context.sessionToken, {
                    elevatedAt: timestamp,
                    elevatedMethod: "password",
                    userAgent:
                        request.headers.get("user-agent") ?? context.session.userAgent,
                });
                if (!rotated) {
                    return json({ error: "Session rotation failed" }, { status: 409 });
                }
                securityEvent("account.password-reauth", String(context.session.id));
                return withCookies(json({ isOk: true, verifiedAt: timestamp }), [
                    sessionCookie(request, server, rotated),
                ]);
            },
        },

        "/api/account/security/password/change": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (
                    context.session.mfaEnabled &&
                    !hasRecentMfaVerification(context.session)
                ) {
                    return recentVerificationRequired();
                }
                const throttled = authenticationThrottleResponse(
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                const currentPassword = normalizedPassword(body.currentPassword);
                const newPassword =
                    typeof body.newPassword === "string" &&
                    body.newPassword.length >= 8 &&
                    body.newPassword.length <= 256
                        ? body.newPassword
                        : undefined;
                if (!newPassword) {
                    return json(
                        { error: "New password must be 8-256 characters" },
                        { status: 400 }
                    );
                }
                const user = findUserById(context.session.id);
                if (
                    !currentPassword ||
                    !user ||
                    !(await verifyPassword(currentPassword, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return json({ error: "Invalid current password" }, { status: 400 });
                }
                clearAuthenticationFailures("account-password", context.session.id);
                if (await verifyPassword(newPassword, user.password_hash)) {
                    return json(
                        {
                            error: "New password must differ from the current password",
                        },
                        { status: 400 }
                    );
                }
                const changed = await changePasswordAndRotateSession(
                    context.sessionToken,
                    context.session.id,
                    newPassword,
                    {
                        userAgent:
                            request.headers.get("user-agent") ??
                            context.session.userAgent,
                    }
                );
                if (!changed) {
                    return json(
                        { error: "Session changed; sign in and try again" },
                        { status: 409 }
                    );
                }
                clearAuthenticationFailures("login-password", context.session.username);
                securityEvent("account.password-changed", String(context.session.id), {
                    revokedSessions: changed.revokedSessions,
                });
                return withCookies(
                    json({
                        isOk: true,
                        revokedSessions: changed.revokedSessions,
                    }),
                    [sessionCookie(request, server, changed.sessionToken)]
                );
            },
        },

        "/api/account/security/step-up/totp": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                const code = normalizedCode(body.code);
                const factor = code
                    ? await verifyTotpForUser(context.session.id, code)
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return json({ error: "Invalid authenticator code" }, { status: 400 });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                return rotateAfterVerification(request, server, context, "totp");
            },
        },

        "/api/account/security/step-up/recovery": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                const code = normalizedCode(body.code);
                const verified =
                    code && (await verifyRecoveryCodeForUser(context.session.id, code));
                if (!verified) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return json({ error: "Invalid recovery code" }, { status: 400 });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                return rotateAfterVerification(request, server, context, "recovery");
            },
        },

        "/api/account/security/step-up/webauthn/options": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                try {
                    const options = await webAuthn.createAuthenticationOptions({
                        purpose: "step-up",
                        sessionId: context.session.sessionId,
                        userId: context.session.id,
                    });
                    return json({ options });
                } catch {
                    return json(
                        { error: "Security-key verification is unavailable" },
                        { status: 503 }
                    );
                }
            },
        },

        "/api/account/security/step-up/webauthn/verify": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                const response = parseAuthenticationResponse(body.response);
                const factor = response
                    ? await webAuthn.verifyAuthentication(
                          {
                              purpose: "step-up",
                              sessionId: context.session.sessionId,
                              userId: context.session.id,
                          },
                          response
                      )
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return json(
                        { error: "Invalid security-key response" },
                        { status: 400 }
                    );
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                return rotateAfterVerification(request, server, context, "webauthn");
            },
        },

        "/api/account/security/totp/setup": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const throttled = authenticationThrottleResponse(
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                let label: string;
                try {
                    label = normalizeFactorLabel(body.label, "Authenticator app");
                } catch (error) {
                    return json(
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Invalid factor label",
                        },
                        { status: 400 }
                    );
                }
                const enrollment = await createTotpEnrollment(
                    context.session.id,
                    context.session.username,
                    label
                );
                securityEvent("account.totp-enrollment-started", enrollment.factorId, {
                    label: enrollment.label,
                });
                return json({ enrollment }, { status: 201 });
            },
        },

        "/api/account/security/totp/confirm": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const throttled = authenticationThrottleResponse(
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                let factorId: string;
                try {
                    factorId = normalizeFactorId(body.factorId);
                } catch {
                    return json({ error: "Invalid factor identifier" }, { status: 400 });
                }
                const code = normalizedCode(body.code);
                const confirmation = code
                    ? await confirmTotpEnrollment(context.session.id, factorId, code)
                    : undefined;
                if (!confirmation) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return json({ error: "Invalid authenticator code" }, { status: 400 });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                securityEvent("account.totp-added", factorId);
                const responseBody = {
                    factorId,
                    isOk: true,
                    recoveryCodes: confirmation.recoveryCodes,
                };
                return confirmation.enabledMfa
                    ? upgradeAfterFirstFactor(
                          request,
                          server,
                          context,
                          "totp",
                          responseBody
                      )
                    : json(responseBody);
            },
        },

        "/api/account/security/totp/:factorId": {
            DELETE: (request: ParametersRequest<"factorId">, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!hasRecentMfaVerification(context.session)) {
                    return recentVerificationRequired();
                }
                let factorId: string;
                try {
                    factorId = normalizeFactorId(request.params.factorId);
                } catch {
                    return json({ error: "Invalid factor identifier" }, { status: 400 });
                }
                if (!didRemoveTotpFactor(context.session.id, factorId)) {
                    return json(
                        {
                            error: "Factor not found or cannot remove the final second factor",
                        },
                        { status: 409 }
                    );
                }
                securityEvent("account.totp-removed", factorId);
                return json({ isOk: true });
            },
        },

        "/api/account/security/webauthn/register/options": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                try {
                    const options = await webAuthn.createRegistrationOptions(
                        {
                            purpose: "registration",
                            sessionId: context.session.sessionId,
                            userId: context.session.id,
                        },
                        context.session.username
                    );
                    return json({ options });
                } catch {
                    return json(
                        { error: "Security-key enrollment is unavailable" },
                        { status: 503 }
                    );
                }
            },
        },

        "/api/account/security/webauthn/register/verify": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                let label: string;
                try {
                    label = normalizeFactorLabel(body.label, "Security key");
                } catch (error) {
                    return json(
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Invalid factor label",
                        },
                        { status: 400 }
                    );
                }
                const response = registrationResponse(body.response);
                const registration = response
                    ? await webAuthn.verifyRegistration(
                          {
                              purpose: "registration",
                              sessionId: context.session.sessionId,
                              userId: context.session.id,
                          },
                          response,
                          label
                      )
                    : undefined;
                if (!registration) {
                    return json(
                        { error: "Invalid security-key response" },
                        { status: 400 }
                    );
                }
                securityEvent(
                    "account.security-key-added",
                    credentialAuditTargetId(registration.credential.id),
                    {
                        label: registration.credential.label,
                    }
                );
                const responseBody = {
                    credential: registration.credential,
                    isOk: true,
                    recoveryCodes: registration.confirmation.recoveryCodes,
                };
                return registration.confirmation.enabledMfa
                    ? upgradeAfterFirstFactor(
                          request,
                          server,
                          context,
                          "webauthn",
                          responseBody
                      )
                    : json(responseBody);
            },
        },

        "/api/account/security/webauthn/:credentialId": {
            DELETE: (
                request: ParametersRequest<"credentialId">,
                server: Server<unknown>
            ) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!hasRecentMfaVerification(context.session)) {
                    return recentVerificationRequired();
                }
                const credentialId = request.params.credentialId;
                if (!didRemoveWebAuthnCredential(context.session.id, credentialId)) {
                    return json(
                        {
                            error: "Credential not found or cannot remove the final second factor",
                        },
                        { status: 409 }
                    );
                }
                securityEvent(
                    "account.security-key-removed",
                    credentialAuditTargetId(credentialId)
                );
                return json({ isOk: true });
            },
        },

        "/api/account/security/recovery-codes/rotate": {
            POST: async (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!hasRecentMfaVerification(context.session)) {
                    return recentVerificationRequired();
                }
                const recoveryCodes = await rotateRecoveryCodes(context.session.id);
                securityEvent(
                    "account.recovery-codes-rotated",
                    String(context.session.id),
                    {
                        count: recoveryCodes.length,
                    }
                );
                return json({ recoveryCodes });
            },
        },

        "/api/account/security/mfa/disable": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (
                    !context.session.mfaEnabled ||
                    !hasRecentMfaVerification(context.session)
                ) {
                    return recentVerificationRequired();
                }
                const throttled = authenticationThrottleResponse(
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request);
                if (body instanceof Response) return body;
                const password = normalizedPassword(body.password);
                const user = findUserById(context.session.id);
                if (
                    !password ||
                    !user ||
                    !(await verifyPassword(password, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return json({ error: "Invalid current password" }, { status: 400 });
                }
                clearAuthenticationFailures("account-password", context.session.id);
                disableMultiFactor(context.session.id);
                revokeUserSessions(context.session.id);
                const sessionId = createSession(context.session.id, {
                    authMethod: "password",
                    userAgent:
                        request.headers.get("user-agent") ?? context.session.userAgent,
                });
                securityEvent("account.mfa-disabled", String(context.session.id));
                return withCookies(json({ isOk: true }), [
                    sessionCookie(request, server, sessionId),
                    clearPendingLoginCookie(request, server),
                ]);
            },
        },

        "/api/account/security/sessions/:sessionId": {
            DELETE: (
                request: ParametersRequest<"sessionId">,
                server: Server<unknown>
            ) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const sessionId = request.params.sessionId;
                if (!SESSION_ID_PATTERN.test(sessionId)) {
                    return json({ error: "Invalid session identifier" }, { status: 400 });
                }
                if (!didRevokeUserSession(context.session.id, sessionId)) {
                    return json({ error: "Session not found" }, { status: 404 });
                }
                securityEvent("account.session-revoked", sessionId, {
                    current: sessionId === context.session.sessionId,
                });
                return sessionId === context.session.sessionId
                    ? withCookies(json({ isOk: true, loggedOut: true }), [
                          clearSessionCookie(request, server),
                      ])
                    : json({ isOk: true, loggedOut: false });
            },
        },

        "/api/account/security/sessions/revoke-others": {
            POST: (request: Request, server: Server<unknown>) => {
                void server;
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const revoked = revokeUserSessions(
                    context.session.id,
                    context.session.sessionId
                );
                securityEvent("account.sessions-revoked", String(context.session.id), {
                    currentPreserved: true,
                    revoked,
                });
                return json({ isOk: true, revoked });
            },
        },

        "/api/account/security/sessions/revoke-all": {
            POST: (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                if (!canManageFactors(context.session)) {
                    return recentVerificationRequired();
                }
                const revoked = revokeUserSessions(context.session.id);
                securityEvent("account.sessions-revoked", String(context.session.id), {
                    currentPreserved: false,
                    revoked,
                });
                return withCookies(json({ isOk: true, revoked }), [
                    clearSessionCookie(request, server),
                    clearPendingLoginCookie(request, server),
                ]);
            },
        },
    } as const;
}

export const accountSecurityRoutes = createAccountSecurityRoutes();
