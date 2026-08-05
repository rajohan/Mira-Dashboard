import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { hasUniqueArrayItems } from "../../src/shared/validation.ts";
import { convertContractSchema } from "./jsonSchema.ts";

describe("contract JSON Schema conversion", () => {
    test("documents the named array uniqueness validator", () => {
        const schema = v.pipe(v.array(v.string()), v.check(hasUniqueArrayItems<string>));

        expect(convertContractSchema(schema, "test.unique", "input")).toMatchObject({
            type: "array",
            uniqueItems: true,
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
