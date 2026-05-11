import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateJsonString } from "./json";

describe("json utils", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

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
        vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
            throw "bad json";
        });
        const result = validateJsonString("{}");
        expect(result).toEqual({ valid: false, error: "Invalid JSON" });
    });

    it("handles non-Error throws in JSON5.parse", () => {
        vi.spyOn(JSON5, "parse").mockImplementationOnce(() => {
            throw "bad json5";
        });
        const result = validateJsonString("{}", "json5");
        expect(result).toEqual({ valid: false, error: "Invalid JSON5" });
    });
});
