import { describe, expect, test } from "bun:test";

import {
    browserSessionIdleDurationDefaultMs,
    browserSessionIdleDurationMaximumMs,
    browserSessionIdleDurationMinimumMs,
    parseBrowserSessionIdleDurationMs,
} from "./authenticationPolicy.ts";

describe("authentication policy", () => {
    test("uses the default and accepts both inclusive session-idle bounds", () => {
        expect(parseBrowserSessionIdleDurationMs()).toBe(
            browserSessionIdleDurationDefaultMs
        );
        expect(
            parseBrowserSessionIdleDurationMs(browserSessionIdleDurationMinimumMs)
        ).toBe(browserSessionIdleDurationMinimumMs);
        expect(
            parseBrowserSessionIdleDurationMs(browserSessionIdleDurationMaximumMs)
        ).toBe(browserSessionIdleDurationMaximumMs);
    });

    test.each([
        browserSessionIdleDurationMinimumMs - 1,
        browserSessionIdleDurationMaximumMs + 1,
        90_000.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])("rejects invalid session-idle duration %s", (durationMs) => {
        expect(() => parseBrowserSessionIdleDurationMs(durationMs)).toThrow(
            "Session idle duration is invalid"
        );
    });
});
