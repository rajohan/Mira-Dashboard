import { afterEach, describe, expect, it } from "bun:test";

import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialRequestOptionsJSON,
    RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Server } from "bun";
import { generate } from "otplib";

import type { WebAuthnCredential } from "../../contracts/accountSecurity/summary.ts";
import {
    createSession,
    getAuthSessionFromSessionId,
} from "../src/auth/sessionRepository.ts";
import { createUser, findUserById, verifyPassword } from "../src/auth/userRepository.ts";
import { database } from "../src/database/connection.ts";
import { runWithRequestAuditContext } from "../src/http/requestAuditContext.ts";
import { createAccountSecurityRoutes } from "../src/routes/accountSecurityRoutes.ts";
import { createAuthRoutes } from "../src/routes/authRoutes.ts";
import { listAuditEvents } from "../src/services/auditEvents.ts";
import {
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../src/services/authenticationThrottle.ts";
import {
    confirmTotpEnrollment,
    createTotpEnrollment,
} from "../src/services/multiFactorAuth/totpFactorService.ts";
import { type WebAuthnChallengeContext } from "../src/services/webAuthn/service.ts";
import { captureStructuredLogs } from "./support/structuredLogCapture.ts";

const USER_PREFIX = "auth-route-test-";
const originalSecretEncryptionKey = process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY;
const originalRpId = process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID;
const originalOrigins = process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS;

const server = {
    requestIP: () => ({
        address: "203.0.113.80",
        family: "IPv4",
        port: 31_000,
    }),
} as unknown as Server<unknown>;

function encryptionKey(): string {
    return new Uint8Array(32).fill(11).toBase64();
}

function configureSecurity(): void {
    process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY = encryptionKey();
    process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID = "dashboard.example.com";
    process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS = "https://dashboard.example.com";
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function restoreEnvironment(): void {
    restoreEnvironmentVariable(
        "MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY",
        originalSecretEncryptionKey
    );
    restoreEnvironmentVariable("MIRA_DASHBOARD_WEBAUTHN_RP_ID", originalRpId);
    restoreEnvironmentVariable("MIRA_DASHBOARD_WEBAUTHN_ORIGINS", originalOrigins);
}

function request(
    route: string,
    {
        body,
        cookie,
        method = body === undefined ? "GET" : "POST",
        userAgent = "Route test browser",
    }: {
        body?: unknown;
        cookie?: string;
        method?: string;
        userAgent?: string;
    } = {}
): Request {
    return new Request(`https://dashboard.example.com${route}`, {
        ...(body !== undefined && { body: JSON.stringify(body) }),
        headers: {
            ...(cookie && { cookie }),
            ...(body !== undefined && { "Content-Type": "application/json" }),
            "user-agent": userAgent,
        },
        method,
    });
}

function cookie(response: Response, name: string): string {
    const match = response.headers
        .get("set-cookie")
        ?.match(new RegExp(`${name}=([^;,]+)`, "u"));
    if (!match?.[1]) {
        throw new Error(`Response did not set ${name}`);
    }
    return `${name}=${match[1]}`;
}

function sessionCookie(response: Response): string {
    return cookie(response, "mira_dashboard_session");
}

function pendingCookie(response: Response): string {
    return cookie(response, "mira_dashboard_pending_login");
}

function tokenFromCookie(header: string): string {
    return decodeURIComponent(header.split("=", 2)[1] ?? "");
}

function authenticationResponse(id: string): AuthenticationResponseJSON {
    return {
        authenticatorAttachment: "cross-platform",
        clientExtensionResults: {},
        id,
        rawId: id,
        response: {
            authenticatorData: "AA",
            clientDataJSON: "AA",
            signature: "AA",
        },
        type: "public-key",
    };
}

function registrationResponse(id: string): RegistrationResponseJSON {
    return {
        authenticatorAttachment: "cross-platform",
        clientExtensionResults: {},
        id,
        rawId: id,
        response: {
            attestationObject: "AA",
            clientDataJSON: "AA",
            transports: ["usb"],
        },
        type: "public-key",
    };
}

function assertionOptions(): PublicKeyCredentialRequestOptionsJSON {
    return {
        allowCredentials: [],
        challenge: "route-test-challenge",
        rpId: "dashboard.example.com",
        timeout: 60_000,
        userVerification: "required",
    };
}

function credentialSummary(id: string): WebAuthnCredential {
    return {
        backedUp: false,
        createdAt: "2026-07-24T12:00:00.000Z",
        deviceType: "singleDevice",
        id,
        label: "Primary YubiKey",
        lastUsedAt: "2026-07-24T12:01:00.000Z",
    };
}

function insertCredential(userId: number, id: string): void {
    database
        .prepare(
            `INSERT INTO user_webauthn_credentials (
                id,
                user_id,
                public_key,
                counter,
                transports_json,
                device_type,
                backed_up,
                label,
                created_at
             ) VALUES (?, ?, ?, 0, '["usb"]', 'singleDevice', 0, ?, ?)`
        )
        .run(
            id,
            userId,
            new Uint8Array([1, 2, 3]),
            "Primary YubiKey",
            "2026-07-24T12:00:00.000Z"
        );
}

async function enrollTotp(userId: number, username: string) {
    const enrollment = createTotpEnrollment(userId, username, "Authenticator app");
    const code = await generate({
        algorithm: "sha1",
        digits: 6,
        period: 30,
        secret: enrollment.secret,
        strategy: "totp",
    });
    const confirmation = await confirmTotpEnrollment(userId, enrollment.factorId, code);
    if (!confirmation?.recoveryCodes) {
        throw new Error("Could not enroll test TOTP factor");
    }
    database
        .prepare(
            `UPDATE user_totp_factors
             SET last_used_step = NULL
             WHERE id = ?`
        )
        .run(enrollment.factorId);
    return {
        code,
        factorId: enrollment.factorId,
        recoveryCodes: confirmation.recoveryCodes,
    };
}

afterEach(() => {
    database.prepare("DELETE FROM users WHERE username LIKE ?").run(`${USER_PREFIX}%`);
    database.prepare("DELETE FROM auth_rate_limit_buckets").run();
    restoreEnvironment();
});

describe("MFA authentication routes", () => {
    it("completes TOTP and recovery pending logins without issuing an early session", async () => {
        configureSecurity();
        const user = await createUser(`${USER_PREFIX}totp`, "initial-password");
        const enrolled = await enrollTotp(user.id, user.username);
        const routes = createAuthRoutes();

        const firstStep = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "initial-password",
                    username: user.username.toUpperCase(),
                },
            }),
            server
        );
        expect(firstStep.status).toBe(202);
        expect(firstStep.json()).resolves.toMatchObject({
            authenticated: false,
            methods: ["totp", "recovery"],
            mfaRequired: true,
        });
        expect(firstStep.headers.get("set-cookie")).toContain("mira_dashboard_session=;");
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM auth_sessions
                     WHERE user_id = ?`
                )
                .get(user.id)
        ).toEqual({ count: 0 });
        const pending = pendingCookie(firstStep);

        const invalid = await routes["/api/auth/login/totp"].POST(
            request("/api/auth/login/totp", {
                body: { code: "" },
                cookie: pending,
            }),
            server
        );
        expect(invalid.status).toBe(401);

        const totpStep = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "initial-password",
                    username: user.username,
                },
            }),
            server
        );
        const totpPending = pendingCookie(totpStep);
        const completed = await routes["/api/auth/login/totp"].POST(
            request("/api/auth/login/totp", {
                body: { code: enrolled.code },
                cookie: totpPending,
            }),
            server
        );
        expect(completed.status).toBe(200);
        expect(completed.json()).resolves.toMatchObject({
            authenticated: true,
            mfaRequired: false,
            user: { id: user.id, username: user.username },
        });
        const authenticatedToken = tokenFromCookie(sessionCookie(completed));
        expect(getAuthSessionFromSessionId(authenticatedToken)).toMatchObject({
            authMethod: "totp",
            mfaEnabled: true,
        });
        expect(completed.headers.get("set-cookie")).toContain(
            "mira_dashboard_pending_login="
        );

        const recoveryStep = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "initial-password",
                    username: user.username,
                },
            }),
            server
        );
        const recovered = await routes["/api/auth/login/recovery"].POST(
            request("/api/auth/login/recovery", {
                body: { code: enrolled.recoveryCodes[0] },
                cookie: pendingCookie(recoveryStep),
            }),
            server
        );
        expect(recovered.status).toBe(200);
        const recoveredToken = tokenFromCookie(sessionCookie(recovered));
        const recoveredSession = getAuthSessionFromSessionId(recoveredToken);
        expect(recoveredSession?.authMethod).toBe("recovery");
    });

    it("validates credentials, clears replaced sessions, and applies persistent throttles", async () => {
        const user = await createUser(`${USER_PREFIX}password`, "initial-password");
        const routes = createAuthRoutes();

        const invalidShape = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: [],
            }),
            server
        );
        expect(invalidShape.status).toBe(400);

        const missing = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: { password: "short", username: "x" },
            }),
            server
        );
        expect(missing.status).toBe(400);

        const unknown = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "wrong-password",
                    username: `${USER_PREFIX}unknown`,
                },
            }),
            server
        );
        expect(unknown.status).toBe(401);

        recordAuthenticationFailure("login-password", user.username);
        recordAuthenticationFailure("login-password", user.username);
        recordAuthenticationFailure("login-password", user.username);
        const throttled = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "initial-password",
                    username: user.username,
                },
            }),
            server
        );
        expect(throttled.status).toBe(429);
        expect(throttled.headers.get("retry-after")).toBeTruthy();
        clearAuthenticationFailures("login-password", user.username);

        const oldToken = createSession(user.id);
        const loggedIn = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "initial-password",
                    username: user.username,
                },
                cookie: `mira_dashboard_session=${encodeURIComponent(oldToken)}`,
            }),
            server
        );
        expect(loggedIn.status).toBe(200);
        expect(getAuthSessionFromSessionId(oldToken)).toBeUndefined();
        const loggedInToken = tokenFromCookie(sessionCookie(loggedIn));
        expect(getAuthSessionFromSessionId(loggedInToken)).toMatchObject({
            authMethod: "password",
            userAgent: "Route test browser",
        });

        const noAttempt = await routes["/api/auth/login/recovery"].POST(
            request("/api/auth/login/recovery", {
                body: { code: "unused" },
            }),
            server
        );
        expect(noAttempt.status).toBe(401);
        expect(noAttempt.headers.get("set-cookie")).toContain(
            "mira_dashboard_pending_login="
        );
    });

    it("uses user-bound WebAuthn options and assertions for pending login", async () => {
        configureSecurity();
        const user = await createUser(`${USER_PREFIX}webauthn`, "initial-password");
        const timestamp = new Date().toISOString();
        database
            .prepare(
                `UPDATE users
                 SET mfa_enabled_at = ?, updated_at = ?
                 WHERE id = ?`
            )
            .run(timestamp, timestamp, user.id);
        insertCredential(user.id, "credential_route_login");

        const contexts: WebAuthnChallengeContext[] = [];
        const routes = createAuthRoutes({
            createAuthenticationOptions: (context) => {
                return Promise.try(() => {
                    contexts.push(context);
                    return assertionOptions();
                });
            },
            verifyAuthentication: (context, response) => {
                return Promise.try(() => {
                    contexts.push(context);
                    return response.id === "credential_route_login"
                        ? credentialSummary(response.id)
                        : undefined;
                });
            },
        });
        const firstStep = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "initial-password",
                    username: user.username,
                },
            }),
            server
        );
        const pending = pendingCookie(firstStep);
        expect(firstStep.json()).resolves.toMatchObject({
            methods: ["webauthn"],
        });

        const options = await routes["/api/auth/login/webauthn/options"].POST(
            request("/api/auth/login/webauthn/options", {
                cookie: pending,
                method: "POST",
            }),
            server
        );
        expect(options.status).toBe(200);
        expect(options.json()).resolves.toEqual({
            options: assertionOptions(),
        });

        const verified = await routes["/api/auth/login/webauthn/verify"].POST(
            request("/api/auth/login/webauthn/verify", {
                body: {
                    response: authenticationResponse("credential_route_login"),
                },
                cookie: pending,
            }),
            server
        );
        expect(verified.status).toBe(200);
        const verifiedToken = tokenFromCookie(sessionCookie(verified));
        expect(getAuthSessionFromSessionId(verifiedToken)?.authMethod).toBe("webauthn");
        expect(contexts).toHaveLength(2);
        expect(typeof contexts[0]?.pendingLoginId).toBe("string");
        expect(contexts[0]).toMatchObject({
            purpose: "login",
            userId: user.id,
        });

        const unavailableRoutes = createAuthRoutes({
            createAuthenticationOptions: () => {
                return Promise.try(() => {
                    throw new Error("WebAuthn unavailable");
                });
            },
            verifyAuthentication: async () => {},
        });
        const anotherAttempt = await routes["/api/auth/login"].POST(
            request("/api/auth/login", {
                body: {
                    password: "initial-password",
                    username: user.username,
                },
            }),
            server
        );
        const structuredLogs = captureStructuredLogs();
        try {
            const unavailable = await unavailableRoutes[
                "/api/auth/login/webauthn/options"
            ].POST(
                request("/api/auth/login/webauthn/options", {
                    cookie: pendingCookie(anotherAttempt),
                    method: "POST",
                }),
                server
            );
            expect(unavailable.status).toBe(503);
            expect(structuredLogs.entries).toContainEqual(
                expect.objectContaining({
                    component: "auth",
                    error: {
                        message: "WebAuthn unavailable",
                        name: "Error",
                    },
                    event: "auth.webauthn_login_options_failed",
                    level: "error",
                })
            );
        } finally {
            structuredLogs.stop();
        }
    });
});

describe("Account security routes", () => {
    it("reauthenticates, changes passwords, and revokes durable sessions", async () => {
        const user = await createUser(`${USER_PREFIX}account`, "initial-password");
        const routes = createAccountSecurityRoutes();
        let currentToken = createSession(user.id, {
            userAgent: "Current browser",
        });
        const otherToken = createSession(user.id, {
            userAgent: "Other browser",
        });
        let currentCookie = `mira_dashboard_session=${encodeURIComponent(currentToken)}`;

        const unauthorized = routes["/api/account/security"].GET(
            request("/api/account/security"),
            server
        );
        expect(unauthorized.status).toBe(401);

        const summary = routes["/api/account/security"].GET(
            request("/api/account/security", { cookie: currentCookie }),
            server
        );
        expect(summary.status).toBe(200);
        const summaryBody = (await summary.json()) as {
            sessions: unknown[];
        };
        expect(summaryBody).toMatchObject({
            factors: {
                methods: [],
                recoveryCodesRemaining: 0,
            },
            recentVerification: {
                mfa: false,
                password: true,
            },
            webAuthn: { available: false },
        });
        expect(summaryBody.sessions).toHaveLength(2);

        const wrongReauth = await routes["/api/account/security/reauth/password"].POST(
            request("/api/account/security/reauth/password", {
                body: { password: "wrong-password" },
                cookie: currentCookie,
            }),
            server
        );
        expect(wrongReauth.status).toBe(400);

        const reauthenticated = await routes[
            "/api/account/security/reauth/password"
        ].POST(
            request("/api/account/security/reauth/password", {
                body: { password: "initial-password" },
                cookie: currentCookie,
            }),
            server
        );
        expect(reauthenticated.status).toBe(200);
        currentCookie = sessionCookie(reauthenticated);
        currentToken = tokenFromCookie(currentCookie);
        expect(getAuthSessionFromSessionId(currentToken)).toMatchObject({
            elevatedMethod: "password",
        });

        const shortPassword = await routes["/api/account/security/password/change"].POST(
            request("/api/account/security/password/change", {
                body: {
                    currentPassword: "initial-password",
                    newPassword: "short",
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(shortPassword.status).toBe(400);

        const samePassword = await routes["/api/account/security/password/change"].POST(
            request("/api/account/security/password/change", {
                body: {
                    currentPassword: "initial-password",
                    newPassword: "initial-password",
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(samePassword.status).toBe(400);

        const changed = await routes["/api/account/security/password/change"].POST(
            request("/api/account/security/password/change", {
                body: {
                    currentPassword: "initial-password",
                    newPassword: "replacement-password",
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(changed.status).toBe(200);
        expect(changed.json()).resolves.toMatchObject({
            isOk: true,
            revokedSessions: 1,
        });
        expect(getAuthSessionFromSessionId(otherToken)).toBeUndefined();
        const updatedUser = findUserById(user.id);
        expect(updatedUser).toBeDefined();
        expect(
            await verifyPassword("replacement-password", updatedUser!.password_hash)
        ).toBe(true);

        currentCookie = sessionCookie(changed);
        const another = createSession(user.id);
        const anotherSession = getAuthSessionFromSessionId(another);
        expect(anotherSession).toBeDefined();
        const revokeOtherRequest = Object.assign(
            request(`/api/account/security/sessions/${anotherSession!.sessionId}`, {
                cookie: currentCookie,
                method: "DELETE",
            }),
            { params: { sessionId: anotherSession!.sessionId } }
        );
        const revoked = routes["/api/account/security/sessions/:sessionId"].DELETE(
            revokeOtherRequest,
            server
        );
        expect(revoked.status).toBe(200);
        expect(revoked.json()).resolves.toEqual({
            isOk: true,
            loggedOut: false,
        });
    });

    it("maps invalid factor, WebAuthn, password, and session operations", async () => {
        configureSecurity();
        const user = await createUser(`${USER_PREFIX}account-errors`, "initial-password");
        const verifiedAt = new Date().toISOString();
        const sessionToken = createSession(user.id, {
            mfaVerifiedAt: verifiedAt,
        });
        const currentCookie = `mira_dashboard_session=${encodeURIComponent(
            sessionToken
        )}`;
        const routes = createAccountSecurityRoutes({
            createAuthenticationOptions: () =>
                Promise.reject(new Error("WebAuthn verification unavailable")),
            createRegistrationOptions: () =>
                Promise.reject(new Error("WebAuthn enrollment unavailable")),
            verifyAuthentication: () => Promise.resolve(undefined),
            verifyRegistration: () => Promise.resolve(undefined),
        });

        const wrongPasswordChange = await routes[
            "/api/account/security/password/change"
        ].POST(
            request("/api/account/security/password/change", {
                body: {
                    currentPassword: "wrong-password",
                    newPassword: "replacement-password",
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(wrongPasswordChange.status).toBe(400);
        clearAuthenticationFailures("account-password", user.id);

        const invalidTotp = await routes["/api/account/security/step-up/totp"].POST(
            request("/api/account/security/step-up/totp", {
                body: { code: "000000" },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalidTotp.status).toBe(400);
        clearAuthenticationFailures("second-factor", user.id);

        const invalidRecovery = await routes[
            "/api/account/security/step-up/recovery"
        ].POST(
            request("/api/account/security/step-up/recovery", {
                body: { code: "invalid-recovery" },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalidRecovery.status).toBe(400);
        clearAuthenticationFailures("second-factor", user.id);

        const unavailableWebAuthnStepUp = await routes[
            "/api/account/security/step-up/webauthn/options"
        ].POST(
            request("/api/account/security/step-up/webauthn/options", {
                cookie: currentCookie,
                method: "POST",
            }),
            server
        );
        expect(unavailableWebAuthnStepUp.status).toBe(503);

        const invalidWebAuthnStepUp = await routes[
            "/api/account/security/step-up/webauthn/verify"
        ].POST(
            request("/api/account/security/step-up/webauthn/verify", {
                body: {
                    response: authenticationResponse("missing-credential"),
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalidWebAuthnStepUp.status).toBe(400);
        clearAuthenticationFailures("second-factor", user.id);

        const invalidTotpLabel = await routes["/api/account/security/totp/setup"].POST(
            request("/api/account/security/totp/setup", {
                body: { label: "" },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalidTotpLabel.status).toBe(400);

        const invalidFactorConfirmation = await routes[
            "/api/account/security/totp/confirm"
        ].POST(
            request("/api/account/security/totp/confirm", {
                body: { code: "000000", factorId: "invalid" },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalidFactorConfirmation.status).toBe(400);

        const missingFactorConfirmation = await routes[
            "/api/account/security/totp/confirm"
        ].POST(
            request("/api/account/security/totp/confirm", {
                body: {
                    code: "000000",
                    factorId: "00000000-0000-0000-0000-000000000000",
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(missingFactorConfirmation.status).toBe(400);
        clearAuthenticationFailures("second-factor", user.id);

        const invalidFactorRemovalRequest = Object.assign(
            request("/api/account/security/totp/invalid", {
                cookie: currentCookie,
                method: "DELETE",
            }),
            { params: { factorId: "invalid" } }
        );
        const invalidFactorRemoval = routes[
            "/api/account/security/totp/:factorId"
        ].DELETE(invalidFactorRemovalRequest, server);
        expect(invalidFactorRemoval.status).toBe(400);

        const unavailableRegistration = await routes[
            "/api/account/security/webauthn/register/options"
        ].POST(
            request("/api/account/security/webauthn/register/options", {
                cookie: currentCookie,
                method: "POST",
            }),
            server
        );
        expect(unavailableRegistration.status).toBe(503);

        const invalidRegistrationLabel = await routes[
            "/api/account/security/webauthn/register/verify"
        ].POST(
            request("/api/account/security/webauthn/register/verify", {
                body: {
                    label: "",
                    response: registrationResponse("ignored"),
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalidRegistrationLabel.status).toBe(400);

        const invalidRegistration = await routes[
            "/api/account/security/webauthn/register/verify"
        ].POST(
            request("/api/account/security/webauthn/register/verify", {
                body: { response: {} },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalidRegistration.status).toBe(400);

        await enrollTotp(user.id, user.username);
        const mfaSessionToken = createSession(user.id, {
            mfaVerifiedAt: verifiedAt,
        });
        const mfaCookie = `mira_dashboard_session=${encodeURIComponent(mfaSessionToken)}`;

        const missingCredentialRequest = Object.assign(
            request("/api/account/security/webauthn/missing-credential", {
                cookie: mfaCookie,
                method: "DELETE",
            }),
            { params: { credentialId: "missing-credential" } }
        );
        const missingCredential = routes[
            "/api/account/security/webauthn/:credentialId"
        ].DELETE(missingCredentialRequest, server);
        expect(missingCredential.status).toBe(409);

        const wrongDisablePassword = await routes[
            "/api/account/security/mfa/disable"
        ].POST(
            request("/api/account/security/mfa/disable", {
                body: { password: "wrong-password" },
                cookie: mfaCookie,
            }),
            server
        );
        expect(wrongDisablePassword.status).toBe(400);
        clearAuthenticationFailures("account-password", user.id);

        const invalidSessionRequest = Object.assign(
            request("/api/account/security/sessions/invalid", {
                cookie: mfaCookie,
                method: "DELETE",
            }),
            { params: { sessionId: "invalid" } }
        );
        const invalidSession = routes["/api/account/security/sessions/:sessionId"].DELETE(
            invalidSessionRequest,
            server
        );
        expect(invalidSession.status).toBe(400);

        const missingSessionRequest = Object.assign(
            request(`/api/account/security/sessions/${"f".repeat(32)}`, {
                cookie: mfaCookie,
                method: "DELETE",
            }),
            { params: { sessionId: "f".repeat(32) } }
        );
        const missingSession = routes["/api/account/security/sessions/:sessionId"].DELETE(
            missingSessionRequest,
            server
        );
        expect(missingSession.status).toBe(404);
    });

    it("handles WebAuthn step-up and long audit-safe registration identifiers", async () => {
        configureSecurity();
        const user = await createUser(`${USER_PREFIX}account-key`, "initial-password");
        const timestamp = new Date().toISOString();
        database
            .prepare(
                `UPDATE users
                 SET mfa_enabled_at = ?, updated_at = ?
                 WHERE id = ?`
            )
            .run(timestamp, timestamp, user.id);
        insertCredential(user.id, "credential_existing");
        const staleToken = createSession(user.id, {
            authMethod: "webauthn",
            mfaVerifiedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        });
        let currentCookie = `mira_dashboard_session=${encodeURIComponent(staleToken)}`;
        const longCredentialId = `credential_${"a".repeat(400)}`;
        const routes = createAccountSecurityRoutes({
            createAuthenticationOptions: () => Promise.try(() => assertionOptions()),
            createRegistrationOptions: () =>
                Promise.try(
                    () =>
                        ({
                            challenge: "registration-route",
                        }) as Awaited<
                            ReturnType<
                                NonNullable<
                                    Parameters<typeof createAccountSecurityRoutes>[0]
                                >["createRegistrationOptions"]
                            >
                        >
                ),
            verifyAuthentication: (_context, response) =>
                Promise.try(() =>
                    response.id === "credential_existing"
                        ? credentialSummary(response.id)
                        : undefined
                ),
            verifyRegistration: () =>
                Promise.try(() => ({
                    confirmation: { enabledMfa: false },
                    credential: credentialSummary(longCredentialId),
                })),
        });

        const blockedOptions = await routes[
            "/api/account/security/webauthn/register/options"
        ].POST(
            request("/api/account/security/webauthn/register/options", {
                cookie: currentCookie,
                method: "POST",
            }),
            server
        );
        expect(blockedOptions.status).toBe(403);

        const options = await routes[
            "/api/account/security/step-up/webauthn/options"
        ].POST(
            request("/api/account/security/step-up/webauthn/options", {
                cookie: currentCookie,
                method: "POST",
            }),
            server
        );
        expect(options.status).toBe(200);

        const invalid = await routes[
            "/api/account/security/step-up/webauthn/verify"
        ].POST(
            request("/api/account/security/step-up/webauthn/verify", {
                body: { response: {} },
                cookie: currentCookie,
            }),
            server
        );
        expect(invalid.status).toBe(400);

        const verified = await routes[
            "/api/account/security/step-up/webauthn/verify"
        ].POST(
            request("/api/account/security/step-up/webauthn/verify", {
                body: {
                    response: authenticationResponse("credential_existing"),
                },
                cookie: currentCookie,
            }),
            server
        );
        expect(verified.status).toBe(200);
        currentCookie = sessionCookie(verified);

        const freshSummary = routes["/api/account/security"].GET(
            request("/api/account/security", { cookie: currentCookie }),
            server
        );
        const freshSummaryBody = (await freshSummary.json()) as {
            recentVerification: {
                mfa: boolean;
                mfaRemainingMs?: number;
            };
        };
        expect(freshSummaryBody.recentVerification.mfa).toBe(true);
        expect(freshSummaryBody.recentVerification.mfaRemainingMs).toBeGreaterThan(0);

        const registrationOptions = await routes[
            "/api/account/security/webauthn/register/options"
        ].POST(
            request("/api/account/security/webauthn/register/options", {
                cookie: currentCookie,
                method: "POST",
            }),
            server
        );
        expect(registrationOptions.status).toBe(200);

        const registered = await runWithRequestAuditContext(
            {
                actor: {
                    id: `${user.id}:${user.username}`,
                    type: "user",
                },
                requestId: "auth-route-long-credential",
            },
            () =>
                routes["/api/account/security/webauthn/register/verify"].POST(
                    request("/api/account/security/webauthn/register/verify", {
                        body: {
                            label: "Backup YubiKey",
                            response: registrationResponse(longCredentialId),
                        },
                        cookie: currentCookie,
                    }),
                    server
                )
        );
        expect(registered.status).toBe(200);
        const registeredBody = (await registered.json()) as {
            credential: { id: string };
            sessionRotated: boolean;
        };
        expect(registeredBody.credential.id).toBe(longCredentialId);
        expect(registeredBody.sessionRotated).toBe(false);
        const auditEvent = listAuditEvents(10).events.find(
            (event) =>
                event.action === "account.security-key-added" &&
                event.requestId === "auth-route-long-credential"
        );
        expect(auditEvent?.target.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
    });
});
