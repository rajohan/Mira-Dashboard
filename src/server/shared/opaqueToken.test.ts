import { describe, expect, test } from "bun:test";

import {
    generateOpaqueToken,
    opaqueTokenValidatorVersion,
    parseOpaqueToken,
    verifyOpaqueToken,
} from "./opaqueToken.ts";

describe("opaque token", () => {
    test("generates one parseable token without persisting its validator", () => {
        const generated = generateOpaqueToken("session");
        const parsed = parseOpaqueToken(generated.token, "session");

        expect(generated.prefix).toMatch(/^[0-9a-f]{32}$/u);
        expect(generated.validatorHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(generated.validatorVersion).toBe(opaqueTokenValidatorVersion);
        expect(parsed).toEqual({
            prefix: generated.prefix,
            validatorHash: generated.validatorHash,
        });
        expect(generated.token).not.toContain(generated.validatorHash);
    });

    test.each([
        undefined,
        "",
        `${"a".repeat(31)}.${"b".repeat(64)}`,
        `${"a".repeat(32)}:${"b".repeat(64)}`,
        `${"A".repeat(32)}.${"b".repeat(64)}`,
        `${"a".repeat(32)}.${"b".repeat(65)}`,
    ])("rejects malformed token %#", (candidate) => {
        expect(parseOpaqueToken(candidate, "session")).toBeUndefined();
    });

    test("verifies only the matching validator", () => {
        const expected = generateOpaqueToken("automation");
        const other = generateOpaqueToken("automation");
        const parsed = parseOpaqueToken(expected.token, "automation");

        expect(parsed).toBeDefined();
        if (!parsed) return;
        expect(verifyOpaqueToken(parsed, expected.validatorHash)).toBe(true);
        expect(verifyOpaqueToken(parsed, other.validatorHash)).toBe(false);
        expect(verifyOpaqueToken(parsed, "invalid")).toBe(false);
    });

    test("separates session and automation validator domains", () => {
        const generated = generateOpaqueToken("session");
        const session = parseOpaqueToken(generated.token, "session");
        const automation = parseOpaqueToken(generated.token, "automation");

        expect(session).toBeDefined();
        expect(automation).toBeDefined();
        expect(session?.prefix).toBe(automation?.prefix);
        expect(session?.validatorHash).not.toBe(automation?.validatorHash);
    });
});
