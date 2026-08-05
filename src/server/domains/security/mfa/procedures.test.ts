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
});
