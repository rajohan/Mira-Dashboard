import { describe, expect, it } from "bun:test";

import {
    isSafeTagPatternMatch,
    isSafeTagRegexPattern,
} from "../src/services/dockerUpdater.ts";

describe("Docker updater tag patterns", () => {
    it("matches the supported anchored numeric tag patterns without RegExp", () => {
        expect(isSafeTagPatternMatch(String.raw`^\d+\.\d+\.\d+$`, "1.2.3")).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^\d+\.\d+\.\d+$$`, "1.2.3")).toBe(true);
        expect(isSafeTagPatternMatch("^latest$$", "latest")).toBe(true);
        expect(
            isSafeTagPatternMatch(
                String.raw`^\d+\.\d+\-alpine\d+\.\d+$$`,
                "1.2-alpine3.20"
            )
        ).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^v\d+\.\d+\.\d+$$`, "v1.2.3")).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^[0-9]+\.[0-9]+$`, "1.2")).toBe(true);
        expect(
            isSafeTagPatternMatch(
                String.raw`^\d+\.\d+\.\d+-alpine\d+\.\d+$$`,
                "1.2.3-alpine3.20"
            )
        ).toBe(true);
        expect(isSafeTagPatternMatch(String.raw`^1\.\d+\.\d+$$`, "1.2.3")).toBe(true);
    });

    it("rejects unsupported or unsafe regex features", () => {
        expect(isSafeTagRegexPattern("^(a+)+$")).toBe(false);
        expect(isSafeTagRegexPattern("^v(1|2)$")).toBe(false);
        expect(isSafeTagRegexPattern(String.raw`\d+\.\d+`)).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^\d+\.\d+\.\d+$$`, "1.2.x")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^v\d+\.\d+\.\d+$$`, "1.2.3")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^1\.\d+\.\d+$$`, "2.2.3")).toBe(false);
    });
});
