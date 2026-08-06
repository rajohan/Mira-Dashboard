import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import type { AccountSecuritySummary } from "../../../../contracts/accountSecurity.ts";
import { generateOpaqueToken } from "../../../shared/opaqueToken.ts";
import { captureFailure } from "../../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestMfaAccountLifecycleService,
    createTestRequestContext,
    createTestSessionAuthentication,
    testSessionSelector,
} from "../../../test/support/requestContext.ts";
import { appRouter } from "../../../trpc/appRouter.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycle.ts";
import { createWebAuthnAdapter } from "./webauthn/adapter.ts";
import { createWebAuthnRelyingPartyConfiguration } from "./webauthn/relyingPartyConfiguration.ts";
import {
    ceremonyFixtureCredentialId,
    ceremonyFixtureOrigin,
    ceremonyFixtureRpId,
    createAuthenticationFixture,
    createRegistrationFixture,
} from "./webauthn/testSupport/ceremonyFixture.ts";

const verifiedAtMs = 1_800_000_000_000;
const authSession = Object.freeze({
    authenticatedAtMs: verifiedAtMs,
    authMethod: "totp" as const,
    createdAtMs: verifiedAtMs,
    expiresAtMs: 1_802_592_000_000,
    id: testSessionSelector,
    isCurrent: true,
    lastSeenAtMs: verifiedAtMs,
});
const disabledSummary: AccountSecuritySummary = {
    checkedAtMs: verifiedAtMs,
    mfa: {
        enabled: false,
        methods: [],
        recoveryCodesRemaining: 0,
        totpFactors: [],
        webAuthnCredentials: [],
    },
    recentAuth: {
        mfa: { recent: false },
        password: {
            expiresAtMs: verifiedAtMs + 60_000,
            recent: true,
            remainingMs: 60_000,
            verifiedAtMs,
        },
    },
    webAuthn: { available: false },
};

describe("account-security procedures", () => {
    test("requires a browser session", async () => {
        for (const testCase of [
            { authentication: undefined, code: "UNAUTHORIZED" },
            {
                authentication: createTestAutomationAuthentication(["reports:read"]),
                code: "FORBIDDEN",
            },
        ] as const) {
            const context = await createTestRequestContext(
                testCase.authentication,
                createTestApplicationRuntime(),
                {
                    mfaAccountLifecycle: createTestMfaAccountLifecycleService(),
                }
            );
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).accountSecurity.summary()
            );

            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
        }
    });

    test("returns the validated account-security summary", async () => {
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    summary: () => ({ status: "found", summary: disabledSummary }),
                }),
            }
        );

        expect(await appRouter.createCaller(context).accountSecurity.summary()).toEqual(
            disabledSummary
        );
    });

    test("emits the allowlisted step-up reason from an account procedure", async () => {
        const response = await fetchRequestHandler({
            createContext: () =>
                createTestRequestContext(
                    createTestSessionAuthentication([]),
                    createTestApplicationRuntime(),
                    {
                        mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                            beginTotpEnrollment: () =>
                                Promise.resolve({ status: "step-up-required" }),
                        }),
                    }
                ),
            endpoint: "/trpc",
            req: new Request(
                "http://localhost/trpc/accountSecurity.beginTotpEnrollment",
                {
                    body: JSON.stringify({ json: {} }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }
            ),
            router: appRouter,
        });
        const text = await response.text();

        expect(response.status).toBe(403);
        expect(text).toContain('"reason":"step_up_required"');
        expect(text).toContain("Recent authentication is required");
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    test("maps account throttling to Retry-After", async () => {
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    stepUpRecovery: () =>
                        Promise.resolve({
                            retryAfterSeconds: 23,
                            status: "rate-limited",
                        }),
                }),
                responseHeaders,
            }
        );
        const failure = await captureFailure(() =>
            appRouter.createCaller(context).accountSecurity.stepUpRecovery({
                code: `${"a".repeat(32)}-${"b".repeat(32)}`,
            })
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("TOO_MANY_REQUESTS");
        expect(responseHeaders.get("retry-after")).toBe("23");
    });

    test("clears the session cookie after a lifecycle race", async () => {
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService(),
                responseHeaders,
            }
        );
        const failure = await captureFailure(() =>
            appRouter.createCaller(context).accountSecurity.summary()
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("UNAUTHORIZED");
        expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
    });

    test("validates rotated output before issuing the session cookie", async () => {
        const generated = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const invalidReauthentication = (() =>
            Promise.resolve({
                session: { ...authSession, id: "invalid-session-selector" },
                status: "verified",
                token: generated.token,
                verifiedAtMs,
            })) as unknown as MfaAccountLifecycleService["reauthenticatePassword"];
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    reauthenticatePassword: invalidReauthentication,
                }),
                responseHeaders,
            }
        );
        const failure = await captureFailure(() =>
            appRouter.createCaller(context).accountSecurity.reauthenticatePassword({
                password: "current-password-1",
            })
        );

        expect(failure).toBeInstanceOf(Error);
        expect(responseHeaders.get("set-cookie")).toBeNull();
    });

    test("sets a hardened cookie without exposing a successful step-up token", async () => {
        const generated = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    stepUpTotp: () =>
                        Promise.resolve({
                            method: "totp",
                            session: authSession,
                            status: "verified",
                            token: generated.token,
                            verifiedAtMs,
                        }),
                }),
                responseHeaders,
            }
        );

        const result = await appRouter
            .createCaller(context)
            .accountSecurity.stepUpTotp({ code: "123456" });

        expect(result).toEqual({
            method: "totp",
            session: authSession,
            verifiedAtMs,
        });
        expect(JSON.stringify(result)).not.toContain(generated.token);
        expect(responseHeaders.get("set-cookie")).toContain(
            `__Host-mira_dashboard_session=${generated.token}`
        );
        expect(responseHeaders.get("set-cookie")).toContain(
            "Secure; HttpOnly; SameSite=Strict"
        );
    });

    test("returns fixed WebAuthn options from the account step-up route", async () => {
        const relyingParty = createWebAuthnRelyingPartyConfiguration({
            allowedOrigins: [ceremonyFixtureOrigin],
            rpId: ceremonyFixtureRpId,
            rpName: "Mira Dashboard",
        });
        const generated = await createWebAuthnAdapter(
            relyingParty
        ).generateAuthenticationOptions({
            allowCredentials: [{ id: ceremonyFixtureCredentialId }],
        });
        if (generated.status !== "generated") {
            throw new Error("Expected WebAuthn authentication options");
        }
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    beginWebAuthnStepUp: () =>
                        Promise.resolve({
                            expiresAtMs: verifiedAtMs + 60_000,
                            options: generated.options,
                            status: "created",
                        }),
                }),
            }
        );

        expect(
            await appRouter.createCaller(context).accountSecurity.beginWebAuthnStepUp({})
        ).toEqual({
            expiresAtMs: verifiedAtMs + 60_000,
            options: generated.options,
        });
    });

    test("validates WebAuthn step-up output before issuing its session cookie", async () => {
        const generated = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const webAuthnSession = { ...authSession, authMethod: "webauthn" as const };
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    stepUpWebAuthn: () =>
                        Promise.resolve({
                            method: "webauthn",
                            session: webAuthnSession,
                            status: "verified",
                            token: generated.token,
                            verifiedAtMs,
                        }),
                }),
                responseHeaders,
            }
        );

        const result = await appRouter
            .createCaller(context)
            .accountSecurity.stepUpWebAuthn({
                response: await createAuthenticationFixture({ counter: 1 }),
            });

        expect(result).toEqual({
            method: "webauthn",
            session: webAuthnSession,
            verifiedAtMs,
        });
        expect(JSON.stringify(result)).not.toContain(generated.token);
        expect(responseHeaders.get("set-cookie")).toContain(
            `__Host-mira_dashboard_session=${generated.token}`
        );
    });

    test("withholds the session cookie for invalid WebAuthn step-up output", async () => {
        const generated = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const invalidStepUp = (() =>
            Promise.resolve({
                method: "webauthn",
                session: { ...authSession, id: "invalid-session-selector" },
                status: "verified",
                token: generated.token,
                verifiedAtMs,
            })) as unknown as MfaAccountLifecycleService["stepUpWebAuthn"];
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    stepUpWebAuthn: invalidStepUp,
                }),
                responseHeaders,
            }
        );

        const response = await createAuthenticationFixture({ counter: 1 });
        const failure = await captureFailure(() =>
            appRouter.createCaller(context).accountSecurity.stepUpWebAuthn({
                response,
            })
        );

        expect(failure).toBeInstanceOf(Error);
        expect(responseHeaders.get("set-cookie")).toBeNull();
    });

    test("withholds the first-factor cookie for invalid WebAuthn confirmation output", async () => {
        const generated = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const invalidConfirmation = (() =>
            Promise.resolve({
                credential: {
                    backedUp: true,
                    createdAtMs: verifiedAtMs,
                    deviceType: "multiDevice",
                    id: "019fc968-1a9b-7778-8f1b-d5b863b0e7b4",
                    label: "Security key",
                    transports: ["usb"],
                    usable: true,
                },
                enabledNow: true,
                recoveryCodes: [],
                revokedSessions: 0,
                session: { ...authSession, id: "invalid-session-selector" },
                status: "confirmed",
                token: generated.token,
            })) as unknown as MfaAccountLifecycleService["confirmWebAuthnEnrollment"];
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                mfaAccountLifecycle: createTestMfaAccountLifecycleService({
                    confirmWebAuthnEnrollment: invalidConfirmation,
                }),
                responseHeaders,
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).accountSecurity.confirmWebAuthnEnrollment({
                response: createRegistrationFixture(),
            })
        );

        expect(failure).toBeInstanceOf(Error);
        expect(responseHeaders.get("set-cookie")).toBeNull();
    });
});
