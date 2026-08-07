import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    fullCommitShaSchema,
    lowercaseSha256Schema,
    lowercaseUuidV7Schema,
    nonnegativeDecimalSafeIntegerStringSchema,
    nonnegativeSafeIntegerSchema,
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "./validation.ts";

describe("shared scalar validation", () => {
    test("accepts only safe integers in the requested sign range", () => {
        const nonnegative = nonnegativeSafeIntegerSchema();
        const positive = positiveSafeIntegerSchema();

        for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
            expect(v.parse(nonnegative, value)).toBe(value);
        }
        for (const value of [1, Number.MAX_SAFE_INTEGER]) {
            expect(v.parse(positive, value)).toBe(value);
        }
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
            expect(v.safeParse(nonnegative, value).success).toBeFalse();
        }
        for (const value of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
            expect(v.safeParse(positive, value).success).toBeFalse();
        }
    });

    test("parses only canonical nonnegative decimal safe-integer strings", () => {
        const schema = nonnegativeDecimalSafeIntegerStringSchema();

        expect(v.parse(schema, "0")).toBe(0);
        expect(v.parse(schema, String(Number.MAX_SAFE_INTEGER))).toBe(
            Number.MAX_SAFE_INTEGER
        );
        for (const value of [
            "",
            "00",
            "01",
            "-1",
            "1.0",
            "1e1",
            String(Number.MAX_SAFE_INTEGER + 1),
            "9".repeat(17),
        ]) {
            expect(v.safeParse(schema, value).success).toBeFalse();
        }
    });

    test("requires the canonical lowercase UUIDv7 form", () => {
        const schema = lowercaseUuidV7Schema();
        const canonical = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";

        expect(v.parse(schema, canonical)).toBe(canonical);
        expect(v.safeParse(schema, canonical.toUpperCase()).success).toBeFalse();
        expect(v.safeParse(schema, canonical.repeat(300)).success).toBeFalse();
    });

    test("accepts only full lowercase hexadecimal checksums", () => {
        const sha256 = lowercaseSha256Schema();
        const commitSha = fullCommitShaSchema();

        expect(v.parse(sha256, "a".repeat(64))).toBe("a".repeat(64));
        expect(v.parse(commitSha, "b".repeat(40))).toBe("b".repeat(40));

        for (const value of ["a".repeat(63), "A".repeat(64), "g".repeat(64), 1]) {
            expect(v.safeParse(sha256, value).success).toBeFalse();
        }
        for (const value of ["b".repeat(39), "B".repeat(40), "g".repeat(40), 1]) {
            expect(v.safeParse(commitSha, value).success).toBeFalse();
        }
    });

    test("uses a caller-supplied operational error message", () => {
        const validation = v.safeParse(
            nonnegativeSafeIntegerSchema("Domain-specific integer error"),
            -1
        );

        expect(validation.success).toBeFalse();
        if (!validation.success) {
            expect(validation.issues[0]?.message).toBe("Domain-specific integer error");
        }

        expect(() =>
            parseSchemaWithRangeError(
                positiveSafeIntegerSchema("Expected a positive retry count"),
                0
            )
        ).toThrow(new RangeError("Expected a positive retry count"));
    });
});
