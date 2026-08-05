import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { recoveryCodeCount } from "../../../contracts/accountSecurity.ts";
import {
    authenticatedSessionResultSchema,
    authStatusSchema,
    okResultSchema,
    passwordLoginResultSchema,
} from "../../../contracts/auth.ts";
import { dashboardTotpPolicy } from "../../domains/security/mfa/totp.ts";
import {
    dashboardPendingLoginCookieName,
    dashboardSessionCookieName,
} from "../../rawHttp/authenticationCredentials.ts";
import {
    CookieJar,
    encryptedTotpSecret,
    generateTotpCode,
    getTrpcQuery,
    hasClearedCookie,
    hasSetCookie,
    type EnrolledMfaHttpSystem,
    mfaHttpSystemPassword,
    mfaHttpSystemUsername,
    openEnrolledMfaHttpSystem,
    pendingLoginCount,
    postTrpcMutation,
    recoveryCodeUsedAt,
    sessionCount,
    sessionExists,
    trpcData,
} from "../support/mfaHttpSystem.ts";

function assertFreshEnrollment(system: EnrolledMfaHttpSystem): void {
    expect(system.bootstrapResponse.response.status).toBe(200);
    expect(system.server.url.hostname).toBe("127.0.0.1");
    expect(system.observedGatewayCredential).toBe("gateway-token");
    expect(system.bootstrap.user.username).toBe(mfaHttpSystemUsername);
    expect(system.bootstrapCookie).toBeDefined();
    expect(system.jar.get(dashboardPendingLoginCookieName)).toBeUndefined();
    expect(sessionCount(system.database)).toBe(1);

    expect(system.enrollmentResponse.response.status).toBe(200);
    expect(system.enrollment.label).toBe("System authenticator");
    expect(system.enrollment.otpauthUri).toContain(system.enrollment.secret);

    expect(system.confirmationResponse.response.status).toBe(200);
    expect(system.confirmation.recoveryCodes).toHaveLength(recoveryCodeCount);
    expect(new Set(system.confirmation.recoveryCodes).size).toBe(recoveryCodeCount);
    expect(system.confirmation.session.id).not.toBe(system.bootstrap.session.id);
    expect(system.jar.get(dashboardSessionCookieName)).toBeDefined();
    expect(system.jar.get(dashboardSessionCookieName)).not.toBe(system.bootstrapCookie);
    expect(
        hasSetCookie(system.confirmationResponse.setCookies, dashboardSessionCookieName)
    ).toBeTrue();
    expect(sessionExists(system.database, system.bootstrap.session.id)).toBeFalse();
    expect(sessionExists(system.database, system.confirmation.session.id)).toBeTrue();
    expect(sessionCount(system.database)).toBe(1);

    const storedSecret = encryptedTotpSecret(system.database, system.enrollment.factorId);
    expect(storedSecret).toBeDefined();
    expect(storedSecret).not.toContain(system.enrollment.secret);
}

async function logoutCurrentSession(system: EnrolledMfaHttpSystem): Promise<void> {
    const logout = await postTrpcMutation(
        system.server.url,
        "auth.logout",
        {},
        {
            jar: system.jar,
        }
    );
    expect(logout.response.status).toBe(200);
    expect(v.parse(okResultSchema, trpcData(logout))).toEqual({ isOk: true });
    expect(hasClearedCookie(logout.setCookies, dashboardSessionCookieName)).toBeTrue();
    expect(system.jar.get(dashboardSessionCookieName)).toBeUndefined();
    expect(sessionCount(system.database)).toBe(0);
}

describe("real HTTP MFA lifecycle", () => {
    test("enrolls TOTP and completes a guarded TOTP login with replay defense", async () => {
        const system = await openEnrolledMfaHttpSystem();

        try {
            assertFreshEnrollment(system);
            system.clock.advance(dashboardTotpPolicy.periodSeconds * 1000);
            await logoutCurrentSession(system);

            const passwordLogin = await postTrpcMutation(
                system.server.url,
                "auth.login",
                {
                    password: mfaHttpSystemPassword,
                    username: mfaHttpSystemUsername,
                },
                { jar: system.jar }
            );
            expect(passwordLogin.response.status).toBe(200);
            const pendingLogin = v.parse(
                passwordLoginResultSchema,
                trpcData(passwordLogin)
            );
            if (pendingLogin.status !== "mfa-required") {
                throw new Error("MFA-enabled password login did not become pending");
            }
            expect(pendingLogin.pendingLogin.methods).toContain("totp");
            expect(pendingLogin.pendingLogin.methods).toContain("recovery");
            const pendingCookie = system.jar.get(dashboardPendingLoginCookieName);
            if (pendingCookie === undefined) {
                throw new Error("Password login did not issue a pending-login cookie");
            }
            expect(system.jar.get(dashboardSessionCookieName)).toBeUndefined();
            expect(pendingLoginCount(system.database)).toBe(1);

            const code = await generateTotpCode(
                system.enrollment.secret,
                system.clock.now()
            );
            const malformedPending = await postTrpcMutation(
                system.server.url,
                "auth.loginTotp",
                { code },
                {
                    cookieHeader: `${dashboardPendingLoginCookieName}=malformed`,
                }
            );
            expect(malformedPending.response.status).toBe(401);
            expect(malformedPending.text).toContain(
                "Pending multi-factor authentication is required"
            );

            const duplicatePending = await postTrpcMutation(
                system.server.url,
                "auth.loginTotp",
                { code },
                {
                    cookieHeader: `${dashboardPendingLoginCookieName}=${pendingCookie}; ${dashboardPendingLoginCookieName}=${pendingCookie}`,
                }
            );
            expect(duplicatePending.response.status).toBe(401);
            expect(duplicatePending.text).toContain(
                "Pending multi-factor authentication is required"
            );
            expect(pendingLoginCount(system.database)).toBe(1);

            const completion = await postTrpcMutation(
                system.server.url,
                "auth.loginTotp",
                { code },
                { jar: system.jar }
            );
            expect(completion.response.status).toBe(200);
            const authentication = v.parse(
                authenticatedSessionResultSchema,
                trpcData(completion)
            );
            expect(authentication.session.authMethod).toBe("totp");
            expect(
                hasSetCookie(completion.setCookies, dashboardSessionCookieName)
            ).toBeTrue();
            expect(
                hasClearedCookie(completion.setCookies, dashboardPendingLoginCookieName)
            ).toBeTrue();
            expect(system.jar.get(dashboardSessionCookieName)).toBeDefined();
            expect(system.jar.get(dashboardPendingLoginCookieName)).toBeUndefined();
            expect(pendingLoginCount(system.database)).toBe(0);
            expect(sessionCount(system.database)).toBe(1);

            const statusResponse = await getTrpcQuery(
                system.server.url,
                "auth.status",
                system.jar
            );
            expect(statusResponse.response.status).toBe(200);
            expect(v.parse(authStatusSchema, trpcData(statusResponse))).toMatchObject({
                session: {
                    authMethod: "totp",
                    id: authentication.session.id,
                },
                state: "authenticated",
                user: { username: mfaHttpSystemUsername },
            });

            const replayJar = new CookieJar();
            replayJar.set(dashboardPendingLoginCookieName, pendingCookie);
            const pendingReplay = await postTrpcMutation(
                system.server.url,
                "auth.loginTotp",
                { code },
                { jar: replayJar }
            );
            expect(pendingReplay.response.status).toBe(401);
            expect(pendingReplay.text).toContain("Authenticator code is invalid");
            expect(
                hasClearedCookie(
                    pendingReplay.setCookies,
                    dashboardPendingLoginCookieName
                )
            ).toBeFalse();
            expect(replayJar.get(dashboardPendingLoginCookieName)).toBe(pendingCookie);
            expect(sessionCount(system.database)).toBe(1);
            expect(pendingLoginCount(system.database)).toBe(0);

            const replayStatus = await getTrpcQuery(
                system.server.url,
                "auth.status",
                replayJar
            );
            expect(replayStatus.response.status).toBe(200);
            expect(v.parse(authStatusSchema, trpcData(replayStatus))).toEqual({
                state: "anonymous",
            });
            expect(replayJar.get(dashboardPendingLoginCookieName)).toBe(pendingCookie);

            await logoutCurrentSession(system);
        } finally {
            await system.close();
        }
    }, 120_000);

    test("consumes recovery codes once and revokes dual-cookie state on logout", async () => {
        const system = await openEnrolledMfaHttpSystem();

        try {
            assertFreshEnrollment(system);
            system.clock.advance(dashboardTotpPolicy.periodSeconds * 1000);
            await logoutCurrentSession(system);

            const passwordLogin = await postTrpcMutation(
                system.server.url,
                "auth.login",
                {
                    password: mfaHttpSystemPassword,
                    username: mfaHttpSystemUsername,
                },
                { jar: system.jar }
            );
            expect(passwordLogin.response.status).toBe(200);
            const pendingLogin = v.parse(
                passwordLoginResultSchema,
                trpcData(passwordLogin)
            );
            if (pendingLogin.status !== "mfa-required") {
                throw new Error("Recovery password login did not become pending");
            }
            const consumedCode = system.confirmation.recoveryCodes[0];
            if (consumedCode === undefined) {
                throw new Error("Enrollment returned no recovery code");
            }
            expect(system.jar.get(dashboardPendingLoginCookieName)).toBeDefined();
            expect(system.jar.get(dashboardSessionCookieName)).toBeUndefined();
            expect(pendingLoginCount(system.database)).toBe(1);

            const completion = await postTrpcMutation(
                system.server.url,
                "auth.loginRecovery",
                { code: consumedCode },
                { jar: system.jar }
            );
            expect(completion.response.status).toBe(200);
            const authentication = v.parse(
                authenticatedSessionResultSchema,
                trpcData(completion)
            );
            expect(authentication.session.authMethod).toBe("recovery");
            expect(
                hasSetCookie(completion.setCookies, dashboardSessionCookieName)
            ).toBeTrue();
            expect(
                hasClearedCookie(completion.setCookies, dashboardPendingLoginCookieName)
            ).toBeTrue();
            expect(pendingLoginCount(system.database)).toBe(0);
            expect(recoveryCodeUsedAt(system.database, consumedCode.slice(0, 32))).toBe(
                system.clock.now().getTime()
            );

            const authenticatedStatus = await getTrpcQuery(
                system.server.url,
                "auth.status",
                system.jar
            );
            expect(authenticatedStatus.response.status).toBe(200);
            expect(
                v.parse(authStatusSchema, trpcData(authenticatedStatus))
            ).toMatchObject({
                session: {
                    authMethod: "recovery",
                    id: authentication.session.id,
                },
                state: "authenticated",
                user: { username: mfaHttpSystemUsername },
            });

            const replayPasswordLogin = await postTrpcMutation(
                system.server.url,
                "auth.login",
                {
                    password: mfaHttpSystemPassword,
                    username: mfaHttpSystemUsername,
                },
                { jar: system.jar }
            );
            expect(replayPasswordLogin.response.status).toBe(200);
            expect(
                v.parse(passwordLoginResultSchema, trpcData(replayPasswordLogin)).status
            ).toBe("mfa-required");
            expect(system.jar.get(dashboardSessionCookieName)).toBeDefined();
            expect(system.jar.get(dashboardPendingLoginCookieName)).toBeDefined();
            expect(sessionCount(system.database)).toBe(1);
            expect(pendingLoginCount(system.database)).toBe(1);

            const consumedCodeReplay = await postTrpcMutation(
                system.server.url,
                "auth.loginRecovery",
                { code: consumedCode },
                { jar: system.jar }
            );
            expect(consumedCodeReplay.response.status).toBe(401);
            expect(consumedCodeReplay.text).toContain("Recovery code is invalid");
            expect(system.jar.get(dashboardSessionCookieName)).toBeDefined();
            expect(system.jar.get(dashboardPendingLoginCookieName)).toBeDefined();
            expect(sessionCount(system.database)).toBe(1);
            expect(pendingLoginCount(system.database)).toBe(1);

            const dualCookieLogout = await postTrpcMutation(
                system.server.url,
                "auth.logout",
                {},
                { jar: system.jar }
            );
            expect(dualCookieLogout.response.status).toBe(200);
            expect(v.parse(okResultSchema, trpcData(dualCookieLogout))).toEqual({
                isOk: true,
            });
            expect(
                hasClearedCookie(dualCookieLogout.setCookies, dashboardSessionCookieName)
            ).toBeTrue();
            expect(
                hasClearedCookie(
                    dualCookieLogout.setCookies,
                    dashboardPendingLoginCookieName
                )
            ).toBeTrue();
            expect(dualCookieLogout.setCookies).toHaveLength(2);
            expect(system.jar.get(dashboardSessionCookieName)).toBeUndefined();
            expect(system.jar.get(dashboardPendingLoginCookieName)).toBeUndefined();
            expect(sessionCount(system.database)).toBe(0);
            expect(pendingLoginCount(system.database)).toBe(0);

            const anonymousStatus = await getTrpcQuery(
                system.server.url,
                "auth.status",
                system.jar
            );
            expect(anonymousStatus.response.status).toBe(200);
            expect(v.parse(authStatusSchema, trpcData(anonymousStatus))).toEqual({
                state: "anonymous",
            });
        } finally {
            await system.close();
        }
    }, 120_000);
});
