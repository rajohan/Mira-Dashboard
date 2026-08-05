import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

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
    id: testSecurityUserId,
    username: "operator",
});

describe("authentication procedures", () => {
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
            gatewayCredential: "gateway-token",
            password: "current-password-1",
            username: "operator",
        });

        expect(result).toEqual({ session: authSession, user: authUser });
        expect(JSON.stringify(result)).not.toContain(generated.token);
        expect(responseHeaders.get("set-cookie")).toContain(
            `mira_dashboard_session=${generated.token}`
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
                        revokeSession: () => ({ revoked }),
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
                    revokeSession: (): undefined => {},
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
