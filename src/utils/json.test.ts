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
    });
});
