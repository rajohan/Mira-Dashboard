import { describe, expect, test } from "bun:test";

import {
    findJobActionRegistration,
    isRegisteredJobSchedule,
    parseJobActionOutputMessage,
    parseJobActionProgress,
    validateJobActionRegistration,
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
        expect(
            isRegisteredJobSchedule("system.worker-smoke", "system.worker-smoke")
        ).toBe(true);
        expect(
            isRegisteredJobSchedule("system.worker-smoke-renamed", "system.worker-smoke")
        ).toBe(false);
        expect(isRegisteredJobSchedule("system.worker-smoke", "system.shell")).toBe(
            false
        );
    });

    test("retains the canonical schedule produced while validating a registration", () => {
        const smoke = findJobActionRegistration("system.worker-smoke");
        if (smoke === undefined) throw new TypeError("Missing smoke registration");

        const registration = validateJobActionRegistration({
            ...smoke,
            defaultSchedule: {
                expression: "0\t0 * JAN MON",
                kind: "cron",
                timeZone: "UTC",
            },
            scheduleId: "system.normalized-cron-test",
        });

        expect(registration.defaultSchedule).toEqual({
            expression: "0 0 * 1 1",
            kind: "cron",
            timeZone: "UTC",
        });
        expect(() =>
            validateJobActionRegistration({
                ...smoke,
                manualExposure: "administrator" as never,
            })
        ).toThrow("Job manual exposure is invalid");
        expect(() =>
            validateJobActionRegistration({
                ...smoke,
                retrySafe: "yes" as never,
            })
        ).toThrow("Job retry-safe flag is invalid");
        expect(() =>
            validateJobActionRegistration({
                ...smoke,
                execute: null as never,
            })
        ).toThrow("Job action executor is invalid");
    });

    test("bounds progress and output before persistence", () => {
        expect(parseJobActionProgress({ completed: 1 })).toEqual({ completed: 1 });
        expect(parseJobActionOutputMessage("safe output")).toBe("safe output");

        expect(() => parseJobActionProgress({ value: "x".repeat(17 * 1024) })).toThrow();
        expect(() => parseJobActionOutputMessage("🙂".repeat(2000))).toThrow();
        expect(() => parseJobActionOutputMessage("line\nbreak")).toThrow();
    });
});
