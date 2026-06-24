import { describe, expect, it } from "bun:test";

import {
    type DockerUpdaterStepResult,
    isNonblockingRegistrationFailure,
    isSafeTagPatternMatch,
    isSafeTagRegexPattern,
} from "../src/services/dockerUpdater.ts";

function dockerUpdaterStep(
    overrides: Partial<DockerUpdaterStepResult>
): DockerUpdaterStepResult {
    return {
        step: "register-services",
        isOk: false,
        stdout: "",
        stderr: "",
        ...overrides,
    };
}

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
        expect(isSafeTagRegexPattern(String.raw`^\d+[0-9]+$`)).toBe(false);
        expect(isSafeTagRegexPattern(String.raw`^[0-9]+\d+$`)).toBe(false);
        expect(isSafeTagRegexPattern(String.raw`^\d+1$`)).toBe(false);
        expect(isSafeTagRegexPattern("^[0-9]+1$")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^\d+\.\d+\.\d+$$`, "1.2.x")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^v\d+\.\d+\.\d+$$`, "1.2.3")).toBe(false);
        expect(isSafeTagPatternMatch(String.raw`^1\.\d+\.\d+$$`, "2.2.3")).toBe(false);
    });

    it("distinguishes blocking service registration failures from warning-only failures", () => {
        const warningOnlyFailure = dockerUpdaterStep({ stderr: "" });
        const nonblockingAppFailure = dockerUpdaterStep({
            stderr: JSON.stringify({
                failed: [{ appSlug: "comet", blocking: false }],
            }),
        });
        const blockingAppFailure = dockerUpdaterStep({
            stderr: JSON.stringify({
                failed: [{ appSlug: "postgres", blocking: true }],
            }),
        });
        const malformedRegistrationFailure = dockerUpdaterStep({
            stderr: '{"failed":',
        });
        const wrongStepFailure = dockerUpdaterStep({
            step: "poll-registries",
            stderr: "",
        });
        const successfulStep = dockerUpdaterStep({ isOk: true, stderr: "" });

        expect(isNonblockingRegistrationFailure(warningOnlyFailure)).toBe(true);
        expect(isNonblockingRegistrationFailure(nonblockingAppFailure)).toBe(true);
        expect(isNonblockingRegistrationFailure(blockingAppFailure)).toBe(false);
        expect(isNonblockingRegistrationFailure(malformedRegistrationFailure)).toBe(
            false
        );
        expect(isNonblockingRegistrationFailure(wrongStepFailure)).toBe(false);
        expect(isNonblockingRegistrationFailure(successfulStep)).toBe(false);
    });
});
