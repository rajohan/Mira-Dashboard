import { describe, expect, test } from "bun:test";

import {
    dashboardRecoveryCodeCount,
    dashboardRecoveryCodeHashInput,
    generateDashboardRecoveryCodes,
    parseDashboardRecoveryCode,
} from "./recoveryCodes.ts";

const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const otherUserId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";

describe("Dashboard recovery-code material", () => {
    test("generates ten unique 128-bit selectors and validators", () => {
        let randomValue = 1;
        const generated = generateDashboardRecoveryCodes(userId, {
            randomHex: (byteLength) => {
                expect(byteLength).toBe(16);
                const value = randomValue;
                randomValue += 1;
                return value.toString(16).padStart(32, "0");
            },
        });

        expect(generated).toHaveLength(dashboardRecoveryCodeCount);
        expect(new Set(generated.map((code) => code.selector)).size).toBe(
            dashboardRecoveryCodeCount
        );
        expect(generated[0]?.code).toBe(
            "00000000000000000000000000000001-00000000000000000000000000000002"
        );
        for (const material of generated) {
            expect(material.code).toMatch(/^[0-9a-f]{32}-[0-9a-f]{32}$/u);
            expect(material.validatorHashInput).not.toBe(material.code);
            expect(material.validatorHashInput).toContain(`user:${userId}:`);
            expect(material.validatorHashInput).toContain(
                `selector:${material.selector}:`
            );
        }
    });

    test("normalizes only outer whitespace and ASCII letter case", () => {
        const canonical =
            "abcdefabcdefabcdefabcdefabcdefab-0123456789abcdef0123456789abcdef";

        expect(parseDashboardRecoveryCode(` \t${canonical.toUpperCase()}\n`)).toEqual({
            selector: "abcdefabcdefabcdefabcdefabcdefab",
            validator: "0123456789abcdef0123456789abcdef",
        });
        for (const malformed of [
            canonical.replace("-", " "),
            canonical.replace("-", "--"),
            canonical.replace("a", "g"),
            canonical.slice(1),
            `${canonical}\0`,
            "x".repeat(129),
            undefined,
        ]) {
            expect(parseDashboardRecoveryCode(malformed)).toBeUndefined();
        }
    });

    test("domain-binds the Argon2id preimage to user and selector", () => {
        const parsed = parseDashboardRecoveryCode(
            "abcdefabcdefabcdefabcdefabcdefab-0123456789abcdef0123456789abcdef"
        );
        expect(parsed).toBeDefined();
        if (parsed === undefined) throw new Error("Recovery-code fixture is invalid");

        const first = dashboardRecoveryCodeHashInput(userId, parsed);
        const otherUser = dashboardRecoveryCodeHashInput(otherUserId, parsed);
        const otherSelector = dashboardRecoveryCodeHashInput(userId, {
            ...parsed,
            selector: "11111111111111111111111111111111",
        });

        expect(first).toBe(
            `mira-dashboard:recovery-code:v1:user:${userId}:selector:abcdefabcdefabcdefabcdefabcdefab:validator:0123456789abcdef0123456789abcdef`
        );
        expect(otherUser).not.toBe(first);
        expect(otherSelector).not.toBe(first);
    });

    test("fails closed for invalid context and random-source output", () => {
        expect(() =>
            generateDashboardRecoveryCodes("not-a-user", {
                randomHex: () => "0".repeat(32),
            })
        ).toThrow("Recovery code user is invalid");
        expect(() =>
            generateDashboardRecoveryCodes(userId, {
                randomHex: () => "not-random-hex",
            })
        ).toThrow("Recovery code randomness is invalid");
        expect(() =>
            dashboardRecoveryCodeHashInput(userId, {
                selector: "short",
                validator: "0".repeat(32),
            })
        ).toThrow("Recovery code hash context is invalid");
    });

    test("bounds repeated selector collisions", () => {
        expect(() =>
            generateDashboardRecoveryCodes(userId, {
                randomHex: () => "0".repeat(32),
            })
        ).toThrow("Recovery code selectors could not be generated uniquely");
    });
});
