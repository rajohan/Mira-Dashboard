import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    arrayFallback,
    envFallback,
    nonEmptyEnvFallback,
    nullableString,
    objectFallback,
    stringFallback,
} from "./values.js";

describe("value fallback helpers", () => {
    it("returns fallback only when env vars are missing", () => {
        const original = process.env.MIRA_VALUE_HELPER_TEST;
        try {
            delete process.env.MIRA_VALUE_HELPER_TEST;
            assert.equal(envFallback("MIRA_VALUE_HELPER_TEST", "fallback"), "fallback");

            process.env.MIRA_VALUE_HELPER_TEST = "";
            assert.equal(envFallback("MIRA_VALUE_HELPER_TEST", "fallback"), "");

            process.env.MIRA_VALUE_HELPER_TEST = "configured";
            assert.equal(envFallback("MIRA_VALUE_HELPER_TEST", "fallback"), "configured");
        } finally {
            if (original === undefined) {
                delete process.env.MIRA_VALUE_HELPER_TEST;
            } else {
                process.env.MIRA_VALUE_HELPER_TEST = original;
            }
        }
    });

    it("returns fallback when env vars are missing or empty", () => {
        const original = process.env.MIRA_VALUE_HELPER_TEST;
        try {
            delete process.env.MIRA_VALUE_HELPER_TEST;
            assert.equal(
                nonEmptyEnvFallback("MIRA_VALUE_HELPER_TEST", "fallback"),
                "fallback"
            );

            process.env.MIRA_VALUE_HELPER_TEST = "";
            assert.equal(
                nonEmptyEnvFallback("MIRA_VALUE_HELPER_TEST", "fallback"),
                "fallback"
            );

            process.env.MIRA_VALUE_HELPER_TEST = "   ";
            assert.equal(
                nonEmptyEnvFallback("MIRA_VALUE_HELPER_TEST", "fallback"),
                "fallback"
            );

            process.env.MIRA_VALUE_HELPER_TEST = "configured";
            assert.equal(
                nonEmptyEnvFallback("MIRA_VALUE_HELPER_TEST", "fallback"),
                "configured"
            );

            process.env.MIRA_VALUE_HELPER_TEST = " configured ";
            assert.equal(
                nonEmptyEnvFallback("MIRA_VALUE_HELPER_TEST", "fallback"),
                "configured"
            );
        } finally {
            if (original === undefined) {
                delete process.env.MIRA_VALUE_HELPER_TEST;
            } else {
                process.env.MIRA_VALUE_HELPER_TEST = original;
            }
        }
    });

    it("converts values to strings with nullish fallback support", () => {
        assert.equal(stringFallback("value"), "value");
        assert.equal(stringFallback(Buffer.from("value")), "value");
        assert.equal(stringFallback(), "");
        assert.equal(stringFallback(""), "");
        assert.equal(stringFallback(undefined, "fallback"), "fallback");
        assert.equal(stringFallback(null, "fallback"), "fallback");
        assert.equal(stringFallback(0, "fallback"), "0");
        assert.equal(stringFallback(false, "fallback"), "false");
        assert.equal(stringFallback(42, "fallback"), "42");
    });

    it("returns nullable strings for API response fields", () => {
        assert.equal(nullableString("value"), "value");
        assert.equal(nullableString(""), null);
        assert.equal(nullableString(), null);
    });

    it("returns fallback objects for non-object values", () => {
        assert.deepEqual(objectFallback({ ok: true }), { ok: true });
        assert.deepEqual(objectFallback(), {});
        assert.deepEqual(objectFallback("oops" as unknown as object), {});
        assert.deepEqual(objectFallback(true as unknown as object), {});
    });

    it("returns arrays or array fallbacks", () => {
        assert.deepEqual(arrayFallback(["a"]), ["a"]);
        assert.deepEqual(arrayFallback(undefined, ["fallback"]), ["fallback"]);
    });
});
