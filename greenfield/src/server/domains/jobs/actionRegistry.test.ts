import { describe, expect, test } from "bun:test";

import {
    findJobActionDefinition,
    isRegisteredJobSchedule,
    parseJobActionOutputMessage,
    parseJobActionProgress,
    validateJobActionRegistration,
    workspaceFileReplaceJobActionDefinition,
    workspaceFileWriteJobActionDefinition,
} from "./actionRegistry.ts";

describe("durable job action registry", () => {
    test("exposes pure smoke, cache, and fixed log definitions without worker authority", () => {
        const registration = findJobActionDefinition("system.worker-smoke");

        expect(registration).toMatchObject({
            cancellationPolicy: "cooperative",
            manualExposure: "jobs-write",
            resourceClass: "light",
            retrySafe: true,
        });
        expect(findJobActionDefinition("system.shell")).toBeUndefined();
        expect(findJobActionDefinition("cache.refresh.system-host")).toMatchObject({
            initialDue: "immediate",
            manualExposure: "cache-write",
            scheduleId: "cache.system-host",
        });
        expect(findJobActionDefinition("maintenance.rotate-logs")).toMatchObject({
            actionPayload: { policyId: "docker-managed" },
            attemptLimit: 1,
            defaultEnabled: true,
            initialDue: "immediate",
            manualExposure: "none",
            resourceClass: "host-heavy",
            resourceKeys: ["host.logs"],
            retrySafe: false,
            scheduleId: "maintenance.rotate-managed-logs",
        });
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
        const smoke = findJobActionDefinition("system.worker-smoke");
        if (smoke === undefined) throw new TypeError("Missing smoke registration");

        const registration = validateJobActionRegistration({
            ...smoke,
            defaultSchedule: {
                expression: "0\t0 * JAN MON",
                kind: "cron",
                timeZone: "UTC",
            },
            execute: () => {
                throw new Error("not executed by this validation test");
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
                execute: () => {
                    throw new Error("not executed by this validation test");
                },
            })
        ).toThrow("Job manual exposure is invalid");
        expect(() =>
            validateJobActionRegistration({
                ...smoke,
                retrySafe: "yes" as never,
                execute: () => {
                    throw new Error("not executed by this validation test");
                },
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

    test("publishes honest operation-specific workspace retry metadata", () => {
        expect(workspaceFileWriteJobActionDefinition).toMatchObject({
            actionKey: "workspace-files.apply-write",
            attemptLimit: 1,
            retrySafe: false,
        });
        expect(workspaceFileReplaceJobActionDefinition).toMatchObject({
            actionKey: "workspace-files.apply-replacement",
            attemptLimit: 3,
            retrySafe: true,
        });
    });
});
