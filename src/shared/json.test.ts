import { expect, test } from "bun:test";

import * as v from "valibot";

import { jsonObjectSchema, parseJsonText } from "./json.ts";

test("parses valid JSON and contains syntax failures", () => {
    expect(parseJsonText('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonText("null")).toBeNull();
    expect(parseJsonText("not-json")).toBeUndefined();
});

test("accepts plain JSON objects and rejects excessive nesting", () => {
    const tooDeep = parseJsonText(`${'{"nested":'.repeat(14)}null${"}".repeat(14)}`);

    expect(v.safeParse(jsonObjectSchema, { ok: [true, 1, "value"] }).success).toBe(true);
    expect(v.safeParse(jsonObjectSchema, tooDeep).success).toBe(false);
    expect(
        v.safeParse(jsonObjectSchema, { unsafe: Number.MAX_SAFE_INTEGER + 1 }).success
    ).toBe(false);
});
