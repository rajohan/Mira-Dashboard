import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    authPasswordInputSchema,
    authSessionListSchema,
    authSessionSummarySchema,
    authStatusSchema,
    firstUserBootstrapInputSchema,
    passwordChangeInputSchema,
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
                authenticated: true,
                isBootstrapRequired: true,
            })
        ).toThrow();
    });
});
