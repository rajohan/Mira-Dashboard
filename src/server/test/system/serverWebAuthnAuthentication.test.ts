import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    accountSecuritySummarySchema,
    beginWebAuthnEnrollmentResultSchema,
    beginWebAuthnStepUpResultSchema,
    confirmWebAuthnEnrollmentResultSchema,
    removeWebAuthnCredentialResultSchema,
    webAuthnStepUpResultSchema,
} from "../../../contracts/accountSecurity.ts";
import {
    authenticatedSessionResultSchema,
    beginWebAuthnLoginResultSchema,
    okResultSchema,
    passwordLoginResultSchema,
} from "../../../contracts/auth.ts";
import { createWebAuthnUserHandle } from "../../domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import {
    createAuthenticationFixture,
    createRegistrationFixture,
} from "../../domains/security/mfa/webauthn/testSupport/ceremonyFixture.ts";
import {
    dashboardPendingLoginCookieName,
    dashboardSessionCookieName,
} from "../../rawHttp/authenticationCredentials.ts";
import {
    CookieJar,
    getTrpcQuery,
    hasClearedCookie,
    hasSetCookie,
    mfaHttpSystemPassword,
    mfaHttpSystemUsername,
    openEnrolledMfaHttpSystem,
    pendingLoginCount,
    postTrpcMutation,
    sessionCount,
    trpcData,
} from "../support/mfaHttpSystem.ts";

describe("real HTTP WebAuthn lifecycle", () => {
    test("registers, authenticates, steps up, rejects replays, and removes a mixed-account credential", async () => {
        const system = await openEnrolledMfaHttpSystem();

        try {
            const enrollmentStart = await postTrpcMutation(
                system.server.url,
                "accountSecurity.beginWebAuthnEnrollment",
                {},
                { jar: system.jar }
            );
            expect(enrollmentStart.response.status).toBe(200);
            const enrollment = v.parse(
                beginWebAuthnEnrollmentResultSchema,
                trpcData(enrollmentStart)
            );
            expect(enrollment.options.rp.id).toBe("dashboard.example");
            expect(enrollment.options.attestation).toBe("none");
            expect(enrollment.options.excludeCredentials).toHaveLength(0);

            const enrollmentCompletion = await postTrpcMutation(
                system.server.url,
                "accountSecurity.confirmWebAuthnEnrollment",
                {
                    label: "System security key",
                    response: createRegistrationFixture({
                        challenge: enrollment.options.challenge,
                    }),
                },
                { jar: system.jar }
            );
            expect(enrollmentCompletion.response.status).toBe(200);
            const confirmed = v.parse(
                confirmWebAuthnEnrollmentResultSchema,
                trpcData(enrollmentCompletion)
            );
            expect(confirmed.enabledNow).toBeFalse();
            expect(confirmed.credential.label).toBe("System security key");
            expect(confirmed.credential.transports).toEqual(["usb"]);

            const mixedSummaryResponse = await getTrpcQuery(
                system.server.url,
                "accountSecurity.summary",
                system.jar
            );
            expect(mixedSummaryResponse.response.status).toBe(200);
            const mixedSummary = v.parse(
                accountSecuritySummarySchema,
                trpcData(mixedSummaryResponse)
            );
            expect(mixedSummary.mfa.methods).toEqual(["recovery", "totp", "webauthn"]);
            expect(mixedSummary.mfa.totpFactors).toHaveLength(1);
            expect(mixedSummary.mfa.webAuthnCredentials).toHaveLength(1);

            const logout = await postTrpcMutation(
                system.server.url,
                "auth.logout",
                {},
                { jar: system.jar }
            );
            expect(logout.response.status).toBe(200);
            expect(v.parse(okResultSchema, trpcData(logout))).toEqual({ isOk: true });
            expect(system.jar.get(dashboardSessionCookieName)).toBeUndefined();

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
            const passwordResult = v.parse(
                passwordLoginResultSchema,
                trpcData(passwordLogin)
            );
            if (passwordResult.status !== "mfa-required") {
                throw new Error("WebAuthn account did not create a pending login");
            }
            expect(passwordResult.pendingLogin.methods).toEqual([
                "recovery",
                "totp",
                "webauthn",
            ]);
            const pendingCookie = system.jar.get(dashboardPendingLoginCookieName);
            if (pendingCookie === undefined) {
                throw new Error("Password login did not issue a pending-login cookie");
            }

            const loginStart = await postTrpcMutation(
                system.server.url,
                "auth.beginWebAuthnLogin",
                {},
                { jar: system.jar }
            );
            expect(loginStart.response.status).toBe(200);
            const loginChallenge = v.parse(
                beginWebAuthnLoginResultSchema,
                trpcData(loginStart)
            );
            expect(loginChallenge.options.allowCredentials).toHaveLength(1);

            const loginInput = {
                response: await createAuthenticationFixture({
                    challenge: loginChallenge.options.challenge,
                    counter: 1,
                    userHandle: createWebAuthnUserHandle(system.bootstrap.user.id),
                }),
            };
            const loginCompletion = await postTrpcMutation(
                system.server.url,
                "auth.loginWebAuthn",
                loginInput,
                { jar: system.jar }
            );
            expect(loginCompletion.response.status).toBe(200);
            const authentication = v.parse(
                authenticatedSessionResultSchema,
                trpcData(loginCompletion)
            );
            expect(authentication.session.authMethod).toBe("webauthn");
            expect(
                hasSetCookie(loginCompletion.setCookies, dashboardSessionCookieName)
            ).toBeTrue();
            expect(
                hasClearedCookie(
                    loginCompletion.setCookies,
                    dashboardPendingLoginCookieName
                )
            ).toBeTrue();
            expect(pendingLoginCount(system.database)).toBe(0);
            expect(sessionCount(system.database)).toBe(1);

            const replayJar = new CookieJar();
            replayJar.set(dashboardPendingLoginCookieName, pendingCookie);
            const loginReplay = await postTrpcMutation(
                system.server.url,
                "auth.loginWebAuthn",
                loginInput,
                { jar: replayJar }
            );
            expect(loginReplay.response.status).toBe(401);
            expect(loginReplay.text).toContain("WebAuthn proof is invalid");
            expect(sessionCount(system.database)).toBe(1);

            const stepUpStart = await postTrpcMutation(
                system.server.url,
                "accountSecurity.beginWebAuthnStepUp",
                {},
                { jar: system.jar }
            );
            expect(stepUpStart.response.status).toBe(200);
            const stepUpChallenge = v.parse(
                beginWebAuthnStepUpResultSchema,
                trpcData(stepUpStart)
            );
            const stepUpInput = {
                response: await createAuthenticationFixture({
                    challenge: stepUpChallenge.options.challenge,
                    counter: 2,
                    userHandle: createWebAuthnUserHandle(system.bootstrap.user.id),
                }),
            };
            const sessionCookieBeforeStepUp = system.jar.get(dashboardSessionCookieName);
            const stepUpCompletion = await postTrpcMutation(
                system.server.url,
                "accountSecurity.stepUpWebAuthn",
                stepUpInput,
                { jar: system.jar }
            );
            expect(stepUpCompletion.response.status, stepUpCompletion.text).toBe(200);
            const stepUp = v.parse(
                webAuthnStepUpResultSchema,
                trpcData(stepUpCompletion)
            );
            expect(stepUp.method).toBe("webauthn");
            expect(stepUp.session.id).not.toBe(authentication.session.id);
            expect(system.jar.get(dashboardSessionCookieName)).not.toBe(
                sessionCookieBeforeStepUp
            );

            const stepUpReplay = await postTrpcMutation(
                system.server.url,
                "accountSecurity.stepUpWebAuthn",
                stepUpInput,
                { jar: system.jar }
            );
            expect(stepUpReplay.response.status).toBe(409);
            expect(stepUpReplay.text).toContain("WebAuthn step-up state changed");

            const removal = await postTrpcMutation(
                system.server.url,
                "accountSecurity.removeWebAuthnCredential",
                { credentialId: confirmed.credential.id },
                { jar: system.jar }
            );
            expect(removal.response.status).toBe(200);
            expect(
                v.parse(removeWebAuthnCredentialResultSchema, trpcData(removal))
            ).toEqual({
                credentialId: confirmed.credential.id,
                removed: true,
            });

            const finalSummaryResponse = await getTrpcQuery(
                system.server.url,
                "accountSecurity.summary",
                system.jar
            );
            expect(finalSummaryResponse.response.status).toBe(200);
            const finalSummary = v.parse(
                accountSecuritySummarySchema,
                trpcData(finalSummaryResponse)
            );
            expect(finalSummary.mfa.methods).toEqual(["recovery", "totp"]);
            expect(finalSummary.mfa.totpFactors).toHaveLength(1);
            expect(finalSummary.mfa.webAuthnCredentials).toHaveLength(0);
        } finally {
            await system.close();
        }
    }, 120_000);
});
