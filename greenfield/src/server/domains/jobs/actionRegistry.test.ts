import { describe, expect, test } from "bun:test";

import {
    findJobActionRegistration,
    parseJobActionOutputMessage,
    parseJobActionProgress,
} from "./actionRegistry.ts";

describe("durable job action registry", () => {
    test("exposes only the safe worker smoke action", () => {
        const registration = findJobActionRegistration("system.worker-smoke");

        expect(registration).toMatchObject({
            cancellationPolicy: "cooperative",
            manualExposure: "jobs-write",
            resourceClass: "light",
            retrySafe: true,
        });
        expect(findJobActionRegistration("system.shell")).toBeUndefined();
    });

    test("bounds progress and output before persistence", () => {
        expect(parseJobActionProgress({ completed: 1 })).toEqual({ completed: 1 });
        expect(parseJobActionOutputMessage("safe output")).toBe("safe output");

        expect(() => parseJobActionProgress({ value: "x".repeat(17 * 1024) })).toThrow();
        expect(() => parseJobActionOutputMessage("🙂".repeat(2000))).toThrow();
        expect(() => parseJobActionOutputMessage("line\nbreak")).toThrow();
    });
});
