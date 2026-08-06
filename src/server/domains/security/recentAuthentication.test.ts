import { describe, expect, test } from "bun:test";

import { addMilliseconds, addMinutes, parseISO, subMilliseconds } from "date-fns";

import {
    evaluateRecentAuthentication,
    recentAuthenticationWindowDefaultMs,
    recentAuthenticationWindowMaximumMs,
    recentAuthenticationWindowMinimumMs,
} from "./recentAuthentication.ts";

const enabledAt = parseISO("2026-08-05T10:00:00.000Z");
const checkedAt = addMinutes(enabledAt, 12);

describe("recent authentication evaluation", () => {
    test("classifies persisted password and MFA proofs relative to server time", () => {
        const passwordVerifiedAt = addMinutes(enabledAt, 5);
        const mfaVerifiedAt = addMinutes(enabledAt, 4);

        expect(
            evaluateRecentAuthentication({
                checkedAt,
                mfaEnabledAt: enabledAt,
                mfaVerifiedAt,
                passwordVerifiedAt,
            })
        ).toEqual({
            mfa: {
                expiresAtMs:
                    mfaVerifiedAt.getTime() + recentAuthenticationWindowDefaultMs,
                recent: true,
                remainingMs: 2 * 60 * 1000,
                verifiedAtMs: mfaVerifiedAt.getTime(),
            },
            password: {
                expiresAtMs:
                    passwordVerifiedAt.getTime() + recentAuthenticationWindowDefaultMs,
                recent: true,
                remainingMs: 3 * 60 * 1000,
                verifiedAtMs: passwordVerifiedAt.getTime(),
            },
        });
    });

    test("fails closed at expiry and for absent, future, or pre-enablement proof", () => {
        expect(
            evaluateRecentAuthentication({
                checkedAt,
                mfaEnabledAt: enabledAt,
                mfaVerifiedAt: null,
                passwordVerifiedAt: addMinutes(enabledAt, 2),
            })
        ).toEqual({ mfa: { recent: false }, password: { recent: false } });

        expect(
            evaluateRecentAuthentication({
                checkedAt,
                mfaEnabledAt: null,
                mfaVerifiedAt: checkedAt,
                passwordVerifiedAt: checkedAt,
            })
        ).toMatchObject({ mfa: { recent: false }, password: { recent: true } });

        const shortlyAfterEnablement = addMinutes(enabledAt, 1);
        expect(
            evaluateRecentAuthentication({
                checkedAt: shortlyAfterEnablement,
                mfaEnabledAt: enabledAt,
                mfaVerifiedAt: subMilliseconds(enabledAt, 1),
                passwordVerifiedAt: enabledAt,
            })
        ).toMatchObject({ mfa: { recent: false }, password: { recent: true } });

        expect(
            evaluateRecentAuthentication({
                checkedAt,
                mfaEnabledAt: enabledAt,
                mfaVerifiedAt: addMilliseconds(checkedAt, 1),
                passwordVerifiedAt: addMilliseconds(checkedAt, 1),
            })
        ).toEqual({ mfa: { recent: false }, password: { recent: false } });
    });

    test("accepts the inclusive one-to-sixty-minute configuration bounds", () => {
        for (const windowMs of [
            recentAuthenticationWindowMinimumMs,
            recentAuthenticationWindowMaximumMs,
        ]) {
            const result = evaluateRecentAuthentication({
                checkedAt,
                mfaEnabledAt: enabledAt,
                mfaVerifiedAt: checkedAt,
                passwordVerifiedAt: checkedAt,
                windowMs,
            });
            expect(result.mfa).toMatchObject({ recent: true, remainingMs: windowMs });
            expect(result.password).toMatchObject({
                recent: true,
                remainingMs: windowMs,
            });
        }
    });

    test.each([
        recentAuthenticationWindowMinimumMs - 1,
        recentAuthenticationWindowMaximumMs + 1,
        90_000.5,
    ])("rejects invalid recent-auth window %s", (windowMs) => {
        expect(() =>
            evaluateRecentAuthentication({
                checkedAt,
                mfaEnabledAt: enabledAt,
                mfaVerifiedAt: checkedAt,
                passwordVerifiedAt: checkedAt,
                windowMs,
            })
        ).toThrow("Recent-auth window is invalid");
    });
});
