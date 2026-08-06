import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    authPasswordInputSchema,
    authProcedureContracts,
    authSessionListSchema,
    authSessionSummarySchema,
    authStatusSchema,
    firstUserBootstrapInputSchema,
    passwordChangeInputSchema,
    passwordLoginResultSchema,
    recoveryCodeInputSchema,
    totpCodeInputSchema,
    type PendingLoginSummary,
} from "./auth.ts";

describe("authentication contracts", () => {
    const sessionSummary = {
        authenticatedAtMs: 1_800_000_000_000,
        authMethod: "password" as const,
        createdAtMs: 1_800_000_000_000,
        expiresAtMs: 1_802_592_000_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: 1_800_000_000_000,
    };
    const pendingLogin: PendingLoginSummary = {
        expiresAtMs: 1_800_000_300_000,
        methods: ["recovery", "totp"],
        username: "operator",
    };

    test("normalizes username casing without normalizing secrets", () => {
        expect(
            v.parse(firstUserBootstrapInputSchema, {
                gatewayCredential: "gateway-token",
                password: "  correct horse battery staple  ",
                username: "Operator.Name",
            })
        ).toEqual({
            gatewayCredential: "gateway-token",
            password: "  correct horse battery staple  ",
            username: "operator.name",
        });
    });

    test("rejects normalization of Gateway credential material", () => {
        expect(() =>
            v.parse(firstUserBootstrapInputSchema, {
                gatewayCredential: " gateway-token ",
                password: "correct-horse-battery",
                username: "operator",
            })
        ).toThrow();
    });

    test.each([" operator ", "\noperator\n"])("rejects username padding", (username) => {
        expect(() =>
            v.parse(firstUserBootstrapInputSchema, {
                gatewayCredential: "gateway-token",
                password: "correct-horse-battery",
                username,
            })
        ).toThrow();
    });

    test.each(["x".repeat(7), "😀".repeat(4), "x".repeat(257), "😀".repeat(257)])(
        "rejects password outside the shared input budget",
        (password) => {
            expect(() => v.parse(authPasswordInputSchema, password)).toThrow();
        }
    );

    test("counts password length in Unicode code points without composition rules", () => {
        expect(v.parse(authPasswordInputSchema, "😀".repeat(8))).toBe("😀".repeat(8));
        expect(v.parse(authPasswordInputSchema, " ".repeat(8))).toBe(" ".repeat(8));
    });

    test("accepts only exact TOTP and normalized canonical recovery proofs", () => {
        expect(v.parse(totpCodeInputSchema, "012345")).toBe("012345");
        expect(() => v.parse(totpCodeInputSchema, " 012345 ")).toThrow();
        expect(
            v.parse(recoveryCodeInputSchema, `  ${"A".repeat(32)}-${"B".repeat(32)}\n`)
        ).toBe(`${"a".repeat(32)}-${"b".repeat(32)}`);
        expect(() =>
            v.parse(recoveryCodeInputSchema, `${"a".repeat(16)}-${"b".repeat(32)}`)
        ).toThrow();
    });

    test("declares the service outage reachable from both pending MFA methods", () => {
        for (const name of ["auth.loginRecovery", "auth.loginTotp"] as const) {
            expect(
                authProcedureContracts.find((contract) => contract.name === name)?.errors
            ).toContain("SERVICE_UNAVAILABLE");
        }
    });

    test("requires recent proof before revoking a browser session", () => {
        const contract = authProcedureContracts.find(
            ({ name }) => name === "auth.revokeSession"
        );

        expect(contract?.access).toEqual({
            kind: "recent-auth",
            whenMfaDisabled: "password",
            whenMfaEnabled: "mfa",
        });
        expect(
            contract !== undefined && "errorReasons" in contract
                ? contract.errorReasons
                : undefined
        ).toEqual(["step_up_required"]);
    });

    test("enforces the Unicode session user-agent budget", () => {
        expect(
            v.parse(authSessionSummarySchema, {
                ...sessionSummary,
                userAgent: "😀".repeat(512),
            }).userAgent
        ).toBe("😀".repeat(512));
        for (const userAgent of ["😀".repeat(513), "browser\0agent", " ".repeat(8)]) {
            expect(() =>
                v.parse(authSessionSummarySchema, { ...sessionSummary, userAgent })
            ).toThrow();
        }
    });

    test("caps the session-list output at the lifecycle maximum", () => {
        expect(
            v.parse(authSessionListSchema, {
                sessions: Array.from({ length: 16 }, () => sessionSummary),
            }).sessions
        ).toHaveLength(16);
        expect(() =>
            v.parse(authSessionListSchema, {
                sessions: Array.from({ length: 17 }, () => sessionSummary),
            })
        ).toThrow();
    });

    test("rejects unknown input and inconsistent status output", () => {
        expect(() =>
            v.parse(passwordChangeInputSchema, {
                currentPassword: "current-password-long",
                newPassword: "replacement-password",
                unexpected: true,
            })
        ).toThrow();
        expect(() =>
            v.parse(authStatusSchema, {
                pendingLogin: { ...pendingLogin, userId: "not-public" },
                state: "pending-mfa",
            })
        ).toThrow();
    });

    test("represents pending login without exposing user id", () => {
        expect(
            v.parse(passwordLoginResultSchema, {
                pendingLogin,
                status: "mfa-required",
            })
        ).toEqual({ pendingLogin, status: "mfa-required" });
        expect(() =>
            v.parse(passwordLoginResultSchema, {
                pendingLogin: { ...pendingLogin, userId: "not-public" },
                status: "mfa-required",
            })
        ).toThrow();
    });

    test("represents an active session and pending login simultaneously", () => {
        expect(
            v.parse(authStatusSchema, {
                pendingLogin,
                session: sessionSummary,
                state: "authenticated",
                user: {
                    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                    username: "operator",
                },
            })
        ).toMatchObject({ pendingLogin, state: "authenticated" });
    });
});
