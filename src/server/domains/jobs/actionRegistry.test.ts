import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    deliveryGitHubJobActionDefinition,
    deliveryPreviewJobActionDefinition,
    deliveryProductionJobActionDefinition,
    findJobActionDefinition,
    hostSystemCleanupJobActionDefinition,
    hostSystemRestartJobActionDefinition,
    hostSystemUpdateJobActionDefinition,
    isRegisteredJobSchedule,
    openClawGatewayRestartJobActionDefinition,
    openClawInstallationUpdateJobActionDefinition,
    openClawInstallationUpdateJobResultSchema,
    openClawSessionsCleanupJobActionDefinition,
    openClawSessionsCleanupJobResultSchema,
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
        expect(findJobActionDefinition("cache.refresh.delivery-overview")).toMatchObject({
            actionPayload: { key: "delivery.overview" },
            defaultSchedule: { intervalMs: 60_000, kind: "interval" },
            manualExposure: "cache-internal",
            resourceClass: "host-heavy",
            resourceKeys: ["cache.delivery", "delivery.preview", "github.repository"],
            scheduleId: "cache.delivery-overview",
        });
        expect(
            findJobActionDefinition("cache.refresh.database-observability")
        ).toMatchObject({
            actionPayload: { key: "database.observability" },
            defaultEnabled: true,
            defaultSchedule: { intervalMs: 3_600_000, kind: "interval" },
            manualExposure: "cache-internal",
            resourceClass: "host-heavy",
            resourceKeys: [
                "database.postgresql",
                "docker.engine",
                "network.database-observability",
            ],
            scheduleId: "cache.database-observability",
            timeoutMs: 420_000,
        });
        expect(findJobActionDefinition("database.sqlite-maintenance")).toMatchObject({
            actionPayload: {},
            attemptLimit: 1,
            cancellationPolicy: "never",
            defaultEnabled: true,
            defaultSchedule: {
                kind: "daily",
                timeOfDay: "02:40",
                timeZone: "Europe/Oslo",
            },
            initialDue: "next-occurrence",
            manualExposure: "none",
            resourceClass: "host-heavy",
            resourceKeys: ["database"],
            retrySafe: false,
            scheduleId: "database.sqlite-maintenance",
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
        expect(() =>
            validateJobActionRegistration({
                ...smoke,
                afterSuccessfulSettlement: null as never,
                execute: () => {
                    throw new Error("not executed by this validation test");
                },
            })
        ).toThrow("Job action settlement handler is invalid");
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

    test("separates GitHub, preview, and versioned production Delivery effects", () => {
        expect(deliveryGitHubJobActionDefinition).toMatchObject({
            actionKey: "delivery.github",
            attemptLimit: 1,
            cancellationPolicy: "never",
            resourceClass: "network",
            retrySafe: false,
        });
        expect(deliveryPreviewJobActionDefinition).toMatchObject({
            actionKey: "delivery.preview",
            attemptLimit: 1,
            cancellationPolicy: "never",
            resourceClass: "host-heavy",
            retrySafe: false,
        });
        expect(deliveryProductionJobActionDefinition).toMatchObject({
            actionKey: "delivery.production.v1",
            attemptLimit: 3,
            cancellationPolicy: "never",
            resourceClass: "exclusive",
            retrySafe: true,
        });
        for (const definition of [
            deliveryGitHubJobActionDefinition,
            deliveryPreviewJobActionDefinition,
            deliveryProductionJobActionDefinition,
        ]) {
            expect(definition).not.toHaveProperty("scheduleId");
        }
    });

    test("publishes the fixed restart as exclusive and never retryable", () => {
        expect(openClawGatewayRestartJobActionDefinition).toMatchObject({
            actionKey: "openclaw.gateway.restart",
            attemptLimit: 1,
            cancellationPolicy: "never",
            manualExposure: "none",
            resourceClass: "exclusive",
            resourceKeys: ["host.mutation", "openclaw.gateway"],
            retrySafe: false,
        });
        expect(openClawGatewayRestartJobActionDefinition).not.toHaveProperty(
            "scheduleId"
        );
    });

    test("publishes fixed Service Actions with cross-domain exclusive locks", () => {
        for (const definition of [
            openClawSessionsCleanupJobActionDefinition,
            openClawGatewayRestartJobActionDefinition,
            hostSystemCleanupJobActionDefinition,
            hostSystemRestartJobActionDefinition,
            hostSystemUpdateJobActionDefinition,
        ]) {
            expect(definition).toMatchObject({
                attemptLimit: 1,
                cancellationPolicy: "never",
                manualExposure: "none",
                priority: 20,
                resourceClass: "exclusive",
                retrySafe: false,
            });
            expect(definition).not.toHaveProperty("scheduleId");
        }
        expect(openClawSessionsCleanupJobActionDefinition.resourceKeys).toEqual([
            "host.mutation",
            "openclaw.gateway",
        ]);
        expect(openClawGatewayRestartJobActionDefinition.resourceKeys).toEqual([
            "host.mutation",
            "openclaw.gateway",
        ]);
        expect(hostSystemRestartJobActionDefinition.resourceKeys).toEqual([
            "host.mutation",
        ]);
        expect(hostSystemCleanupJobActionDefinition.resourceKeys).toEqual([
            "host.logs",
            "host.mutation",
        ]);
        expect(hostSystemUpdateJobActionDefinition.resourceKeys).toEqual([
            "host.mutation",
        ]);
        expect(openClawInstallationUpdateJobActionDefinition).toMatchObject({
            attemptLimit: 1,
            cancellationPolicy: "never",
            manualExposure: "none",
            resourceClass: "exclusive",
            resourceKeys: ["host.mutation", "openclaw.gateway"],
            retrySafe: false,
        });
        expect(hostSystemRestartJobActionDefinition.timeoutMs).toBe(60_000);
        expect(hostSystemCleanupJobActionDefinition.timeoutMs).toBe(2_100_000);
        expect(hostSystemUpdateJobActionDefinition.timeoutMs).toBe(7_200_000);
        expect(openClawSessionsCleanupJobActionDefinition.timeoutMs).toBe(630_000);
        expect(openClawInstallationUpdateJobActionDefinition.timeoutMs).toBe(2_130_000);
    });

    test("reports explicit validation errors for invalid OpenClaw result statuses", () => {
        expect(() =>
            v.parse(openClawSessionsCleanupJobResultSchema, {
                artifactsRemoved: 0,
                bytesFreed: 0,
                completedAtMs: 1,
                diskEntriesRemoved: 0,
                diskFilesRemoved: 0,
                dmScopesRetired: 0,
                entriesAfter: 0,
                entriesBefore: 0,
                entriesCapped: 0,
                entriesPruned: 0,
                missingEntriesRemoved: 0,
                modelRunsPruned: 0,
                status: "failed",
                storesProcessed: 0,
            })
        ).toThrow("OpenClaw cleanup result is invalid");
        expect(() =>
            v.parse(openClawInstallationUpdateJobResultSchema, {
                completedAtMs: 1,
                status: "failed",
            })
        ).toThrow("OpenClaw update result is invalid");
    });
});
