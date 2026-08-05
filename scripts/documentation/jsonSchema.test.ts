import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    isValidTotpFactorLabel,
    totpFactorLabelMaximumLength,
    totpFactorLabelSchema,
} from "../../src/contracts/accountSecurity.ts";
import {
    authPasswordMaximumLength,
    authPasswordMinimumLength,
    browserSessionUserAgentMaximumLength,
    hasValidAuthPasswordLength,
    isValidBrowserSessionUserAgent,
} from "../../src/contracts/auth.ts";
import { hasUniqueArrayItems } from "../../src/shared/validation.ts";
import { convertContractSchema } from "./jsonSchema.ts";

const parseHexadecimalCodePoint = (value: string): number => Number.parseInt(value, 16);

describe("contract JSON Schema conversion", () => {
    test("documents ASCII-bounded Unicode-mode regular expressions", () => {
        const schema = v.pipe(v.string(), v.regex(/^[a-z]+$/u));

        expect(convertContractSchema(schema, "test.regex", "input")).toMatchObject({
            pattern: "^[a-z]+$",
            type: "string",
        });
    });

    test("documents the named array uniqueness validator", () => {
        const schema = v.pipe(v.array(v.string()), v.check(hasUniqueArrayItems<string>));

        expect(convertContractSchema(schema, "test.unique", "input")).toMatchObject({
            type: "array",
            uniqueItems: true,
        });
    });

    test("documents named Unicode code-point string budgets", () => {
        const passwordSchema = v.pipe(v.string(), v.check(hasValidAuthPasswordLength));
        const passwordDocument = convertContractSchema(
            passwordSchema,
            "test.password",
            "input"
        );
        expect(passwordDocument).toMatchObject({
            maxLength: authPasswordMaximumLength,
            minLength: authPasswordMinimumLength,
            type: "string",
        });
        const userAgentSchema = v.pipe(
            v.string(),
            v.check(isValidBrowserSessionUserAgent)
        );
        const userAgentDocument = convertContractSchema(
            userAgentSchema,
            "test.userAgent",
            "output"
        );
        expect(userAgentDocument).toMatchObject({
            maxLength: browserSessionUserAgentMaximumLength,
            minLength: 1,
            pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]*$",
            type: "string",
        });
    });

    test("documents the exact TOTP factor-label predicate", () => {
        const document = convertContractSchema(
            totpFactorLabelSchema,
            "test.totpFactorLabel",
            "input"
        );
        expect(document).toMatchObject({
            maxLength: totpFactorLabelMaximumLength,
            minLength: 1,
            type: "string",
        });
        if (typeof document.pattern !== "string") {
            throw new TypeError("TOTP factor-label JSON Schema pattern is missing");
        }
        const documentedPattern = new RegExp(document.pattern);
        const documentAccepts = (value: string): boolean => {
            let codePointLength = 0;
            for (const _codePoint of value) codePointLength += 1;
            return (
                codePointLength >= 1 &&
                codePointLength <= totpFactorLabelMaximumLength &&
                documentedPattern.test(value)
            );
        };
        const expectParity = (value: string): void => {
            expect(documentAccepts(value)).toBe(isValidTotpFactorLabel(value));
        };

        for (const value of [
            "Primary authenticator",
            ` ${String.fromCodePoint(parseHexadecimalCodePoint("00A0"))}Authenticator `,
            "😀".repeat(totpFactorLabelMaximumLength),
            "\uD800",
            "",
            " ",
            String.fromCodePoint(
                parseHexadecimalCodePoint("00A0"),
                parseHexadecimalCodePoint("1680"),
                parseHexadecimalCodePoint("2000"),
                parseHexadecimalCodePoint("2028"),
                parseHexadecimalCodePoint("2029"),
                parseHexadecimalCodePoint("202F"),
                parseHexadecimalCodePoint("205F"),
                parseHexadecimalCodePoint("3000")
            ),
            "a".repeat(totpFactorLabelMaximumLength + 1),
            "😀".repeat(totpFactorLabelMaximumLength + 1),
        ]) {
            expectParity(value);
        }

        const controlOrFormatRanges = [
            ["0000", "001F"],
            ["007F", "009F"],
            ["00AD", "00AD"],
            ["0600", "0605"],
            ["061C", "061C"],
            ["06DD", "06DD"],
            ["070F", "070F"],
            ["0890", "0891"],
            ["08E2", "08E2"],
            ["180E", "180E"],
            ["200B", "200F"],
            ["202A", "202E"],
            ["2060", "2064"],
            ["2066", "206F"],
            ["FEFF", "FEFF"],
            ["FFF9", "FFFB"],
            ["110BD", "110BD"],
            ["110CD", "110CD"],
            ["13430", "1343F"],
            ["1BCA0", "1BCA3"],
            ["1D173", "1D17A"],
            ["E0001", "E0001"],
            ["E0020", "E007F"],
        ] as const;
        for (const [start, end] of controlOrFormatRanges) {
            for (
                let codePoint = parseHexadecimalCodePoint(start);
                codePoint <= parseHexadecimalCodePoint(end);
                codePoint += 1
            ) {
                expectParity(`safe${String.fromCodePoint(codePoint)}label`);
            }
        }
    });

    test("still rejects arbitrary checks without an explicit representation", () => {
        const schema = v.pipe(
            v.string(),
            v.check((value) => value !== "undocumented")
        );

        expect(() => convertContractSchema(schema, "test.unknown", "input")).toThrow(
            'The "check" action cannot be converted to JSON Schema.'
        );
    });
});
