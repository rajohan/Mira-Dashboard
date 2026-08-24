import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    authPasswordMaximumLength,
    authPasswordMinimumLength,
    browserSessionUserAgentMaximumLength,
    hasValidAuthPasswordLength,
    isValidBrowserSessionUserAgent,
} from "../../src/contracts/auth.ts";
import { hasUniqueArrayItems } from "../../src/shared/validation.ts";
import { convertContractSchema } from "./jsonSchema.ts";

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
