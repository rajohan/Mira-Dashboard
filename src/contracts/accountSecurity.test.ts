import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    accountSecurityProcedureContracts,
    accountSecuritySummarySchema,
    beginTotpEnrollmentResultSchema,
    confirmTotpEnrollmentResultSchema,
    recentVerificationSchema,
    recoveryCodeCount,
    recoveryStepUpInputSchema,
    totpFactorLabelSchema,
    totpFactorMaximumPerUser,
} from "./accountSecurity.ts";

const checkedAtMs = 1_800_000_000_000;
const factorId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const factor = {
    confirmedAtMs: checkedAtMs,
    createdAtMs: checkedAtMs - 60_000,
    id: factorId,
    label: "Primary authenticator",
};
const session = {
    authenticatedAtMs: checkedAtMs - 120_000,
    authMethod: "totp" as const,
    createdAtMs: checkedAtMs,
    expiresAtMs: checkedAtMs + 2_592_000_000,
    id: "a".repeat(32),
    isCurrent: true,
    lastSeenAtMs: checkedAtMs,
};
const recoveryCodes = Array.from({ length: recoveryCodeCount }, (_, index) => {
    const selector = index.toString(16).padStart(32, "0");
    const validator = (index + recoveryCodeCount).toString(16).padStart(32, "0");
    return `${selector}-${validator}`;
});

describe("account-security contracts", () => {
    test("models disabled and enabled MFA states without ambiguous optionals", () => {
        expect(
            v.parse(accountSecuritySummarySchema, {
                checkedAtMs,
                mfa: {
                    enabled: false,
                    methods: [],
                    recoveryCodesRemaining: 0,
                    totpFactors: [],
                },
                recentAuth: {
                    mfa: { recent: false },
                    password: { recent: false },
                },
            })
        ).toMatchObject({ mfa: { enabled: false } });

        expect(
            v.parse(accountSecuritySummarySchema, {
                checkedAtMs,
                mfa: {
                    enabled: true,
                    enabledAtMs: checkedAtMs - 60_000,
                    methods: ["recovery", "totp"],
                    recoveryCodesRemaining: 9,
                    totpFactors: [factor],
                },
                recentAuth: {
                    mfa: { recent: false },
                    password: { recent: false },
                },
            })
        ).toMatchObject({ mfa: { enabled: true, recoveryCodesRemaining: 9 } });

        expect(() =>
            v.parse(accountSecuritySummarySchema, {
                checkedAtMs,
                mfa: {
                    enabled: true,
                    enabledAtMs: checkedAtMs,
                    methods: ["totp", "recovery"],
                    recoveryCodesRemaining: 9,
                    totpFactors: [factor],
                },
                recentAuth: {
                    mfa: { recent: false },
                    password: { recent: false },
                },
            })
        ).toThrow();
    });

    test("caps the account summary at four confirmed TOTP factors", () => {
        expect(
            v.parse(accountSecuritySummarySchema, {
                checkedAtMs,
                mfa: {
                    enabled: true,
                    enabledAtMs: checkedAtMs,
                    methods: ["totp"],
                    recoveryCodesRemaining: 0,
                    totpFactors: Array.from(
                        { length: totpFactorMaximumPerUser },
                        (_, index) => ({
                            ...factor,
                            id: `019fc968-1a9b-777${index}-8f1b-d5b863b0e7b4`,
                        })
                    ),
                },
                recentAuth: {
                    mfa: { recent: false },
                    password: { recent: false },
                },
            }).mfa.totpFactors
        ).toHaveLength(totpFactorMaximumPerUser);
        expect(() =>
            v.parse(accountSecuritySummarySchema, {
                checkedAtMs,
                mfa: {
                    enabled: true,
                    enabledAtMs: checkedAtMs,
                    methods: ["totp"],
                    recoveryCodesRemaining: 0,
                    totpFactors: Array.from(
                        { length: totpFactorMaximumPerUser + 1 },
                        () => factor
                    ),
                },
                recentAuth: {
                    mfa: { recent: false },
                    password: { recent: false },
                },
            })
        ).toThrow();
    });

    test("keeps recent-verification deadlines server-relative", () => {
        expect(
            v.parse(recentVerificationSchema, {
                expiresAtMs: checkedAtMs + 300_000,
                recent: true,
                remainingMs: 300_000,
                verifiedAtMs: checkedAtMs,
            })
        ).toEqual({
            expiresAtMs: checkedAtMs + 300_000,
            recent: true,
            remainingMs: 300_000,
            verifiedAtMs: checkedAtMs,
        });
        expect(() =>
            v.parse(recentVerificationSchema, {
                recent: false,
                remainingMs: 0,
            })
        ).toThrow();
    });

    test("bounds labels and one-time TOTP enrollment secrets", () => {
        expect(v.parse(totpFactorLabelSchema, factor.label)).toBe(factor.label);
        expect(v.parse(totpFactorLabelSchema, "😀".repeat(128))).toBe("😀".repeat(128));
        for (const label of [
            "😀".repeat(129),
            "   ",
            "line\nbreak",
            "unsafe\u061Clabel",
            "unsafe\u200Blabel",
            "unsafe\u2060label",
        ]) {
            expect(() => v.parse(totpFactorLabelSchema, label)).toThrow();
        }
        expect(
            v.parse(beginTotpEnrollmentResultSchema, {
                enrollment: {
                    expiresAtMs: checkedAtMs + 300_000,
                    factorId,
                    label: factor.label,
                    otpauthUri: "otpauth://totp/Mira%20Dashboard%3Aoperator?secret=ABC",
                    secret: "A".repeat(32),
                },
            }).enrollment.factorId
        ).toBe(factorId);
    });

    test("requires exactly ten unique canonical recovery codes on activation", () => {
        const parsed = v.parse(confirmTotpEnrollmentResultSchema, {
            enabledNow: true,
            factor,
            recoveryCodes,
            revokedSessions: 2,
            session,
        });
        if (!parsed.enabledNow) {
            throw new Error("Expected first-factor activation output");
        }
        expect(parsed.recoveryCodes).toHaveLength(recoveryCodeCount);
        expect(() =>
            v.parse(confirmTotpEnrollmentResultSchema, {
                enabledNow: true,
                factor,
                recoveryCodes: recoveryCodes.with(1, recoveryCodes[0] ?? ""),
                revokedSessions: 2,
                session,
            })
        ).toThrow();
    });

    test("normalizes recovery step-up input to its canonical representation", () => {
        const firstRecoveryCode = recoveryCodes[0];
        if (firstRecoveryCode === undefined) {
            throw new Error("Recovery-code fixture is empty");
        }
        expect(
            v.parse(recoveryStepUpInputSchema, {
                code: `\t${firstRecoveryCode.toUpperCase()} `,
            })
        ).toEqual({ code: firstRecoveryCode });
    });

    test("documents all nine procedures and their assurance policies", () => {
        expect(accountSecurityProcedureContracts).toHaveLength(9);
        expect(accountSecurityProcedureContracts.map(({ name }) => name)).toEqual([
            "accountSecurity.summary",
            "accountSecurity.reauthenticatePassword",
            "accountSecurity.stepUpTotp",
            "accountSecurity.stepUpRecovery",
            "accountSecurity.beginTotpEnrollment",
            "accountSecurity.confirmTotpEnrollment",
            "accountSecurity.removeTotpFactor",
            "accountSecurity.rotateRecoveryCodes",
            "accountSecurity.disableMfa",
        ]);

        const enrollment = accountSecurityProcedureContracts.find(
            ({ name }) => name === "accountSecurity.beginTotpEnrollment"
        );
        expect(enrollment?.access).toEqual({
            kind: "recent-auth",
            whenMfaDisabled: "password",
            whenMfaEnabled: "mfa",
        });
        const disableMfa = accountSecurityProcedureContracts[8];
        expect(disableMfa.name).toBe("accountSecurity.disableMfa");
        expect(disableMfa.errorReasons).toEqual([
            "mfa_enrollment_required",
            "step_up_required",
        ]);
    });
});
