import type { Server } from "bun";

import type {
    PasswordReauthenticationResponse,
    TotpConfirmationResponse,
    WebAuthnRegistrationResponse,
} from "../../../contracts/accountSecurity.ts";
import {
    parseAccountPasswordRequest,
    parseMfaCodeRequest,
    parsePasswordChangeRequest,
    parseTotpConfirmationRequest,
    parseTotpEnrollmentRequest,
    parseWebAuthnAuthenticationRequest,
    parseWebAuthnRegistrationRequest,
} from "../../../contracts/accountSecurity.ts";
import {
    changePasswordAndRotateSession,
    createSession,
    didRevokeUserSession,
    hasRecentMfaVerification,
    revokeUserSessions,
    rotateSession,
} from "../auth/sessionService.ts";
import { findUserById, verifyPassword } from "../auth/userRepository.ts";
import {
    clearPendingLoginCookie,
    clearSessionCookie,
    json,
    sessionCookie,
    withCookies,
} from "../http/core.ts";
import { type ParametersRequest, routeFailureResponse } from "../http/routeSupport.ts";
import {
    authenticationThrottleResponse,
    parseAuthenticationResponse,
} from "../services/authenticationRequest.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../services/authenticationThrottle.ts";
import {
    confirmTotpEnrollment,
    createTotpEnrollment,
    didRemoveTotpFactor,
    disableMultiFactor,
    normalizeFactorId,
    normalizeFactorLabel,
    rotateRecoveryCodes,
    verifyRecoveryCodeForUser,
    verifyTotpForUser,
} from "../services/multiFactorAuth/factorService.ts";
import {
    createWebAuthnAuthenticationOptions,
    createWebAuthnRegistrationOptions,
    didRemoveWebAuthnCredential,
    verifyWebAuthnAuthentication,
    verifyWebAuthnRegistration,
} from "../services/webAuthn/service.ts";
import {
    canManageFactors,
    credentialAuditTargetId,
    normalizedCode,
    normalizedPassword,
    readSecurityBody,
    recentVerificationRequired,
    registrationResponse,
    requestContext,
    rotateAfterVerification,
    securityEvent,
    securitySummary,
    upgradeAfterFirstFactor,
} from "./accountSecurity/support.ts";

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
                    request,
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseAccountPasswordRequest);
                if (body instanceof Response) return body;
                const password = normalizedPassword(body.password);
                const user = findUserById(context.session.id);
                if (
                    !password ||
                    !user ||
                    !(await verifyPassword(password, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid current password",
                        status: 400,
                    });
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Session rotation failed",
                        status: 409,
                    });
                }
                securityEvent("account.password-reauth", String(context.session.id));
                return withCookies(
                    json({
                        isOk: true,
                        verifiedAt: timestamp,
                    } satisfies PasswordReauthenticationResponse),
                    [sessionCookie(request, server, rotated)]
                );
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
                    request,
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parsePasswordChangeRequest);
                if (body instanceof Response) return body;
                const currentPassword = normalizedPassword(body.currentPassword);
                const newPassword =
                    typeof body.newPassword === "string" &&
                    body.newPassword.length >= 8 &&
                    body.newPassword.length <= 256
                        ? body.newPassword
                        : undefined;
                if (!newPassword) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "New password must be 8-256 characters",
                        status: 400,
                    });
                }
                const user = findUserById(context.session.id);
                if (
                    !currentPassword ||
                    !user ||
                    !(await verifyPassword(currentPassword, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid current password",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("account-password", context.session.id);
                if (await verifyPassword(newPassword, user.password_hash)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "New password must differ from the current password",
                        status: 400,
                    });
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Session changed; sign in and try again",
                        status: 409,
                    });
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
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizedCode(body.code);
                const factor = code
                    ? await verifyTotpForUser(context.session.id, code)
                    : undefined;
                if (!factor) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid authenticator code",
                        status: 400,
                    });
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
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseMfaCodeRequest);
                if (body instanceof Response) return body;
                const code = normalizedCode(body.code);
                const verified =
                    code && (await verifyRecoveryCodeForUser(context.session.id, code));
                if (!verified) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid recovery code",
                        status: 400,
                    });
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
                    request,
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Security-key verification is unavailable",
                        status: 503,
                    });
                }
            },
        },

        "/api/account/security/step-up/webauthn/verify": {
            POST: async (request: Request, server: Server<unknown>) => {
                const context = requestContext(request);
                if (context instanceof Response) return context;
                const throttled = authenticationThrottleResponse(
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(
                    request,
                    parseWebAuthnAuthenticationRequest
                );
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid security-key response",
                        status: 400,
                    });
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
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseTotpEnrollmentRequest);
                if (body instanceof Response) return body;
                let label: string;
                try {
                    label = normalizeFactorLabel(body.label, "Authenticator app");
                } catch (error) {
                    return routeFailureResponse({
                        context: "account-security",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Invalid factor label",
                        status: 400,
                    });
                }
                const enrollment = createTotpEnrollment(
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
                    request,
                    "second-factor",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(
                    request,
                    parseTotpConfirmationRequest
                );
                if (body instanceof Response) return body;
                let factorId: string;
                try {
                    factorId = normalizeFactorId(body.factorId);
                } catch {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid factor identifier",
                        status: 400,
                    });
                }
                const code = normalizedCode(body.code);
                const confirmation = code
                    ? await confirmTotpEnrollment(context.session.id, factorId, code)
                    : undefined;
                if (!confirmation) {
                    recordAuthenticationFailure("second-factor", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid authenticator code",
                        status: 400,
                    });
                }
                clearAuthenticationFailures("second-factor", context.session.id);
                securityEvent("account.totp-added", factorId);
                const responseBody = {
                    factorId,
                    isOk: true,
                    recoveryCodes: confirmation.recoveryCodes,
                    sessionRotated: confirmation.enabledMfa,
                } satisfies TotpConfirmationResponse;
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid factor identifier",
                        status: 400,
                    });
                }
                if (!didRemoveTotpFactor(context.session.id, factorId)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message:
                            "Factor not found or cannot remove the final second factor",
                        status: 409,
                    });
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Security-key enrollment is unavailable",
                        status: 503,
                    });
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
                const body = await readSecurityBody(
                    request,
                    parseWebAuthnRegistrationRequest
                );
                if (body instanceof Response) return body;
                let label: string;
                try {
                    label = normalizeFactorLabel(body.label, "Security key");
                } catch (error) {
                    return routeFailureResponse({
                        context: "account-security",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Invalid factor label",
                        status: 400,
                    });
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid security-key response",
                        status: 400,
                    });
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
                    sessionRotated: registration.confirmation.enabledMfa,
                } satisfies WebAuthnRegistrationResponse;
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
                    return routeFailureResponse({
                        context: "account-security",
                        message:
                            "Credential not found or cannot remove the final second factor",
                        status: 409,
                    });
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
                    request,
                    "account-password",
                    context.session.id
                );
                if (throttled) return throttled;
                const body = await readSecurityBody(request, parseAccountPasswordRequest);
                if (body instanceof Response) return body;
                const password = normalizedPassword(body.password);
                const user = findUserById(context.session.id);
                if (
                    !password ||
                    !user ||
                    !(await verifyPassword(password, user.password_hash))
                ) {
                    recordAuthenticationFailure("account-password", context.session.id);
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid current password",
                        status: 400,
                    });
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
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Invalid session identifier",
                        status: 400,
                    });
                }
                if (!didRevokeUserSession(context.session.id, sessionId)) {
                    return routeFailureResponse({
                        context: "account-security",
                        message: "Session not found",
                        status: 404,
                    });
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
