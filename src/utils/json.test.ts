import { describe, expect, it } from "vitest";

import { validateJsonString } from "./json";

describe("json utils", () => {
    it("validates strict JSON", () => {
        expect(validateJsonString('{"ok":true}')).toEqual({ valid: true, error: null });

        const result = validateJsonString("{ok:true}");
        expect(result.valid).toBe(false);
        expect(result.error).toEqual(expect.any(String));
    });

    it("validates JSON5 when requested", () => {
        expect(validateJsonString("{ok:true, trailing: 'yes'}", "json5")).toEqual({
            valid: true,
            error: null,
        });

        const result = validateJsonString("{invalid json5", "json5");
        expect(result.valid).toBe(false);
        expect(result.error).toEqual(expect.any(String));
    });

    it("handles non-Error throws in JSON.parse", () => {
        // Pass a string that causes JSON.parse to throw a non-Error
        const result = validateJsonString("undefined");
        expect(result.valid).toBe(false);
    });
});
