import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import {
    dashboardPendingLoginCookieName,
    dashboardSessionCookieName,
} from "../../rawHttp/authenticationCredentials.ts";
import { generateOpaqueToken } from "../../shared/opaqueToken.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
    testSecurityUserId,
    testSessionSelector,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import type { AuthenticationLifecycleService } from "./authenticationLifecycle.ts";
import type { MfaLoginLifecycleService } from "./mfa/loginLifecycle.ts";

const authSession = Object.freeze({
    authenticatedAtMs: 1_800_000_000_000,
    authMethod: "password" as const,
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_802_592_000_000,
    id: testSessionSelector,
    isCurrent: true,
    lastSeenAtMs: 1_800_000_000_000,
});
const authUser = Object.freeze({
    email: "operator@example.com",
    id: testSecurityUserId,
    username: "operator",
});

function createTestMfaLoginLifecycleService(
    overrides: Partial<MfaLoginLifecycleService> = {}
): MfaLoginLifecycleService {
    return Object.freeze({
        beginPendingLogin:
            overrides.beginPendingLogin ??
            (() => Promise.resolve({ status: "identity-changed" })),
        beginWebAuthnLogin:
            overrides.beginWebAuthnLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        completeRecoveryLogin:
            overrides.completeRecoveryLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        completeTotpLogin:
            overrides.completeTotpLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        completeWebAuthnLogin:
            overrides.completeWebAuthnLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        pendingLoginSummary:
            overrides.pendingLoginSummary ?? ((): undefined => undefined),
        revokePendingLogin:
            overrides.revokePendingLogin ?? (() => Promise.resolve(false)),
    });
}

describe("authentication procedures", () => {
    const emailToken = `${"a".repeat(32)}.${"b".repeat(64)}`;

    test("maps email verification outcomes without exposing lifecycle details", async () => {
        const verifiedContext = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    verifyEmail: () =>
                        Promise.resolve({
                            email: "operator@example.com",
                            status: "verified",
                        }),
                }),
            }
        );
        expect(
            await appRouter.createCaller(verifiedContext).auth.verifyEmail({
                token: emailToken,
            })
        ).toEqual({ email: "operator@example.com" });

        for (const testCase of [
            { code: "CONFLICT", status: "conflict" },
            { code: "UNAUTHORIZED", status: "invalid-token" },
        ] as const) {
            const context = await createTestRequestContext(
                undefined,
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        verifyEmail: () => Promise.resolve({ status: testCase.status }),
                    }),
                }
            );
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).auth.verifyEmail({ token: emailToken })
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
        }
    });

    test("maps public password recovery outcomes and preserves generic acceptance", async () => {
        const acceptedContext = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    requestPasswordReset: () => Promise.resolve({ status: "accepted" }),
                }),
            }
        );
        expect(
            await appRouter
                .createCaller(acceptedContext)
                .auth.requestPasswordReset({ username: "operator" })
        ).toEqual({ isOk: true });

        for (const testCase of [
            { code: "SERVICE_UNAVAILABLE", status: "service-unavailable" },
            { code: "TOO_MANY_REQUESTS", status: "rate-limited" },
        ] as const) {
            const responseHeaders = new Headers();
            const context = await createTestRequestContext(
                undefined,
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        requestPasswordReset: () =>
                            Promise.resolve(
                                testCase.status === "rate-limited"
                                    ? { retryAfterSeconds: 30, status: testCase.status }
                                    : { status: testCase.status }
                            ),
                    }),
                    responseHeaders,
                }
            );
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).auth.requestPasswordReset({
                    username: "operator",
                })
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
            if (testCase.status === "rate-limited") {
                expect(responseHeaders.get("retry-after")).toBe("30");
            }
        }

        for (const testCase of [
            { code: undefined, status: "reset" },
            { code: "UNAUTHORIZED", status: "invalid-token" },
            { code: "TOO_MANY_REQUESTS", status: "rate-limited" },
        ] as const) {
            const context = await createTestRequestContext(
                undefined,
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        resetPassword: () =>
                            Promise.resolve(
                                testCase.status === "rate-limited"
                                    ? { retryAfterSeconds: 20, status: testCase.status }
                                    : { status: testCase.status }
                            ),
                    }),
                }
            );
            const operation = () =>
                appRouter.createCaller(context).auth.resetPassword({
                    password: "replacement-password-2",
                    token: emailToken,
                });
            if (testCase.code === undefined) {
                expect(await operation()).toEqual({ reset: true });
            } else {
                const failure = await captureFailure(operation);
                expect(failure).toBeInstanceOf(TRPCError);
                expect((failure as TRPCError).code).toBe(testCase.code);
            }
        }
    });

    test("maps authenticated email change outcomes and clears stale sessions", async () => {
        const changedContext = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    changeEmail: () =>
                        Promise.resolve({
                            email: "replacement@example.com",
                            status: "changed",
                        }),
                }),
            }
        );
        expect(
            await appRouter.createCaller(changedContext).auth.changeEmail({
                email: "replacement@example.com",
            })
        ).toEqual({ email: "replacement@example.com" });

        for (const testCase of [
            { code: "CONFLICT", status: "already-verified" },
            { code: "FORBIDDEN", status: "step-up-required" },
            { code: "SERVICE_UNAVAILABLE", status: "service-unavailable" },
            { code: "UNAUTHORIZED", status: "session-changed" },
        ] as const) {
            const responseHeaders = new Headers();
            const context = await createTestRequestContext(
                createTestSessionAuthentication([]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        changeEmail: () => Promise.resolve({ status: testCase.status }),
                    }),
                    responseHeaders,
                }
            );
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).auth.changeEmail({
                    email: "replacement@example.com",
                })
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
            expect(
                responseHeaders.get("set-cookie")?.includes("Max-Age=0") ?? false
            ).toBe(testCase.status === "session-changed");
        }
    });

    test("sets a hardened cookie while keeping the one-time token out of bootstrap output", async () => {
        const generated = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    bootstrap: () =>
                        Promise.resolve({
                            session: authSession,
                            status: "created",
                            token: generated.token,
                            user: authUser,
                        }),
                }),
                responseHeaders,
            }
        );

        const result = await appRouter.createCaller(context).auth.bootstrap({
            email: "operator@example.com",
            gatewayCredential: "gateway-token",
            password: "current-password-1",
            username: "operator",
        });

        expect(result).toEqual({ session: authSession, user: authUser });
        expect(JSON.stringify(result)).not.toContain(generated.token);
        expect(responseHeaders.get("set-cookie")).toContain(
            `__Host-mira_dashboard_session=${generated.token}`
        );
        expect(responseHeaders.get("set-cookie")).toContain(
            "Secure; HttpOnly; SameSite=Strict"
        );
    });

    test("maps durable throttling to a safe error and Retry-After", async () => {
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    login: () =>
                        Promise.resolve({
                            retryAfterSeconds: 15,
                            status: "rate-limited",
                        }),
                }),
                responseHeaders,
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).auth.login({
                password: "current-password-1",
                username: "operator",
            })
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("TOO_MANY_REQUESTS");
        expect(responseHeaders.get("retry-after")).toBe("15");
    });

    test("does not issue a cookie before successful output validation", async () => {
        const generated = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const invalidLogin = (() =>
            Promise.resolve({
                session: { ...authSession, id: "invalid-session-selector" },
                status: "created",
                token: generated.token,
                user: authUser,
            })) as unknown as AuthenticationLifecycleService["login"];
        const context = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    login: invalidLogin,
                }),
                responseHeaders,
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).auth.login({
                password: "current-password-1",
                username: "operator",
            })
        );

        expect(failure).toBeInstanceOf(Error);
        expect(responseHeaders.get("set-cookie")).toBeNull();
    });

    test("does not issue MFA completion cookies before successful output validation", async () => {
        const pendingLogin = generateOpaqueToken("pending-login");
        const generatedSession = generateOpaqueToken("session");
        const invalidCompletion = {
            session: { ...authSession, id: "invalid-session-selector" },
            status: "authenticated" as const,
            token: generatedSession.token,
            user: authUser,
        };
        const request = new Request("http://localhost/trpc/test", {
            headers: {
                cookie: `${dashboardPendingLoginCookieName}=${pendingLogin.token}`,
            },
        });

        for (const method of ["recovery", "totp"] as const) {
            const responseHeaders = new Headers();
            const context = await createTestRequestContext(
                undefined,
                createTestApplicationRuntime(),
                {
                    mfaLoginLifecycle: createTestMfaLoginLifecycleService(
                        method === "recovery"
                            ? {
                                  completeRecoveryLogin: (() =>
                                      Promise.resolve(
                                          invalidCompletion
                                      )) as unknown as MfaLoginLifecycleService["completeRecoveryLogin"],
                              }
                            : {
                                  completeTotpLogin: (() =>
                                      Promise.resolve(
                                          invalidCompletion
                                      )) as unknown as MfaLoginLifecycleService["completeTotpLogin"],
                              }
                    ),
                    request,
                    responseHeaders,
                }
            );

            const failure = await captureFailure(() =>
                method === "recovery"
                    ? appRouter.createCaller(context).auth.loginRecovery({
                          code: `${"a".repeat(32)}-${"b".repeat(32)}`,
                      })
                    : appRouter.createCaller(context).auth.loginTotp({ code: "123456" })
            );

            expect(failure).toBeInstanceOf(Error);
            expect(responseHeaders.get("set-cookie")).toBeNull();
        }
    });

    test("maps pending MFA service outages without issuing cookies", async () => {
        const pendingLogin = generateOpaqueToken("pending-login");
        const request = new Request("http://localhost/trpc/test", {
            headers: {
                cookie: `${dashboardPendingLoginCookieName}=${pendingLogin.token}`,
            },
        });

        for (const method of ["recovery", "totp"] as const) {
            const responseHeaders = new Headers();
            const context = await createTestRequestContext(
                undefined,
                createTestApplicationRuntime(),
                {
                    mfaLoginLifecycle: createTestMfaLoginLifecycleService(),
                    request,
                    responseHeaders,
                }
            );

            const failure = await captureFailure(() =>
                method === "recovery"
                    ? appRouter.createCaller(context).auth.loginRecovery({
                          code: `${"a".repeat(32)}-${"b".repeat(32)}`,
                      })
                    : appRouter.createCaller(context).auth.loginTotp({ code: "123456" })
            );

            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe("SERVICE_UNAVAILABLE");
            expect(responseHeaders.get("set-cookie")).toBeNull();
        }
    });

    test("enforces browser-session-only procedures", async () => {
        const authenticationCases = [
            { authentication: undefined, code: "UNAUTHORIZED" },
            {
                authentication: createTestAutomationAuthentication(["reports:read"]),
                code: "FORBIDDEN",
            },
        ] as const;

        for (const testCase of authenticationCases) {
            const context = await createTestRequestContext(testCase.authentication);
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).auth.sessions()
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
        }
    });

    test("clears the current-session cookie even when revocation races", async () => {
        for (const revoked of [true, false]) {
            const responseHeaders = new Headers();
            const context = await createTestRequestContext(
                createTestSessionAuthentication([]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        revokeSession: () => Promise.resolve({ revoked }),
                    }),
                    responseHeaders,
                }
            );

            expect(
                await appRouter.createCaller(context).auth.revokeSession({
                    sessionId: testSessionSelector,
                })
            ).toEqual({ revoked });
            expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
        }
    });

    test("preserves the session cookie when revocation requires recent proof", async () => {
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    revokeSession: () => Promise.resolve({ status: "step-up-required" }),
                }),
                responseHeaders,
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).auth.revokeSession({
                sessionId: testSessionSelector,
            })
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("FORBIDDEN");
        expect(responseHeaders.get("set-cookie")).toBeNull();
    });

    test("keeps retained credentials and clears both cookies after valid all-session output", async () => {
        const otherHeaders = new Headers();
        const otherContext = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    revokeOtherSessions: () => Promise.resolve({ revokedSessions: 2 }),
                }),
                responseHeaders: otherHeaders,
            }
        );
        expect(
            await appRouter.createCaller(otherContext).auth.revokeOtherSessions()
        ).toEqual({ revokedSessions: 2 });
        expect(otherHeaders.get("set-cookie")).toBeNull();

        const allHeaders = new Headers();
        const pendingLogin = generateOpaqueToken("pending-login");
        const allContext = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    revokeAllSessions: () => Promise.resolve({ revokedSessions: 3 }),
                }),
                request: new Request("http://localhost/trpc/auth.revokeAllSessions", {
                    headers: {
                        cookie: `${dashboardPendingLoginCookieName}=${pendingLogin.token}`,
                    },
                }),
                responseHeaders: allHeaders,
            }
        );
        expect(await appRouter.createCaller(allContext).auth.revokeAllSessions()).toEqual(
            { revokedSessions: 3 }
        );
        const clearedCookies = allHeaders.getSetCookie();
        expect(clearedCookies).toHaveLength(2);
        expect(clearedCookies).toEqual([
            expect.stringContaining(`${dashboardSessionCookieName}=; Max-Age=0`),
            expect.stringContaining(`${dashboardPendingLoginCookieName}=; Max-Age=0`),
        ]);

        const invalidHeaders = new Headers();
        const invalidRevokeAll = (() =>
            Promise.resolve({
                revokedSessions: -1,
            })) as unknown as AuthenticationLifecycleService["revokeAllSessions"];
        const invalidContext = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    revokeAllSessions: invalidRevokeAll,
                }),
                responseHeaders: invalidHeaders,
            }
        );
        expect(
            await captureFailure(() =>
                appRouter.createCaller(invalidContext).auth.revokeAllSessions()
            )
        ).toBeInstanceOf(Error);
        expect(invalidHeaders.get("set-cookie")).toBeNull();
    });

    test("handles policy and identity races for bulk session revocation", async () => {
        for (const operation of ["all", "others"] as const) {
            const policyHeaders = new Headers();
            const policyContext = await createTestRequestContext(
                createTestSessionAuthentication([]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService(
                        operation === "all"
                            ? {
                                  revokeAllSessions: () =>
                                      Promise.resolve({
                                          status: "step-up-required",
                                      }),
                              }
                            : {
                                  revokeOtherSessions: () =>
                                      Promise.resolve({
                                          status: "step-up-required",
                                      }),
                              }
                    ),
                    responseHeaders: policyHeaders,
                }
            );
            const policyFailure = await captureFailure(() =>
                operation === "all"
                    ? appRouter.createCaller(policyContext).auth.revokeAllSessions()
                    : appRouter.createCaller(policyContext).auth.revokeOtherSessions()
            );
            expect(policyFailure).toBeInstanceOf(TRPCError);
            expect((policyFailure as TRPCError).code).toBe("FORBIDDEN");
            expect(policyHeaders.get("set-cookie")).toBeNull();

            const staleHeaders = new Headers();
            const staleContext = await createTestRequestContext(
                createTestSessionAuthentication([]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService(
                        operation === "all"
                            ? {
                                  revokeAllSessions: () => Promise.resolve(undefined),
                              }
                            : {
                                  revokeOtherSessions: () => Promise.resolve(undefined),
                              }
                    ),
                    responseHeaders: staleHeaders,
                }
            );
            const staleFailure = await captureFailure(() =>
                operation === "all"
                    ? appRouter.createCaller(staleContext).auth.revokeAllSessions()
                    : appRouter.createCaller(staleContext).auth.revokeOtherSessions()
            );
            expect(staleFailure).toBeInstanceOf(TRPCError);
            expect((staleFailure as TRPCError).code).toBe("UNAUTHORIZED");
            expect(staleHeaders.get("set-cookie")).toContain("Max-Age=0");
        }
    });

    test("clears stale authentication after a password-change race", async () => {
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    changePassword: () => Promise.resolve({ status: "session-changed" }),
                }),
                responseHeaders,
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).auth.changePassword({
                currentPassword: "current-password-1",
                newPassword: "replacement-password-2",
            })
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("UNAUTHORIZED");
        expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
    });

    test("preserves the session cookie when password change requires step-up", async () => {
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    changePassword: () => Promise.resolve({ status: "step-up-required" }),
                }),
                responseHeaders,
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).auth.changePassword({
                currentPassword: "current-password-1",
                newPassword: "replacement-password-2",
            })
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("FORBIDDEN");
        expect(responseHeaders.get("set-cookie")).toBeNull();
    });

    test("clears stale authentication after session-list and revoke races", async () => {
        const listHeaders = new Headers();
        const listContext = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    listSessions: (): undefined => {},
                }),
                responseHeaders: listHeaders,
            }
        );
        const listFailure = await captureFailure(() =>
            appRouter.createCaller(listContext).auth.sessions()
        );

        expect(listFailure).toBeInstanceOf(TRPCError);
        expect((listFailure as TRPCError).code).toBe("UNAUTHORIZED");
        expect(listHeaders.get("set-cookie")).toContain("Max-Age=0");

        const revokeHeaders = new Headers();
        const revokeContext = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    revokeSession: () => Promise.resolve(undefined),
                }),
                responseHeaders: revokeHeaders,
            }
        );
        const revokeFailure = await captureFailure(() =>
            appRouter.createCaller(revokeContext).auth.revokeSession({
                sessionId: testSessionSelector,
            })
        );

        expect(revokeFailure).toBeInstanceOf(TRPCError);
        expect((revokeFailure as TRPCError).code).toBe("UNAUTHORIZED");
        expect(revokeHeaders.get("set-cookie")).toContain("Max-Age=0");
    });
});
