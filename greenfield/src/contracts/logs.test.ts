import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    logLineMaximumCharacters,
    logMaintenanceJobResultSchema,
    logMaintenancePolicyIds,
    logMaintenanceStatusOutputSchema,
    logProcedureContracts,
    logRowMaximum,
    logSnapshotOutputSchema,
    listLogSourcesOutputSchema,
    requestLogMaintenanceInputSchema,
    searchLogsInputSchema,
    tailLogsInputSchema,
} from "./logs.ts";

const observedAtMs = 1_800_000_000_000;
const digest = "a".repeat(64);

describe("log contracts", () => {
    test("accepts one bounded path-free source catalog", () => {
        expect(
            v.parse(listLogSourcesOutputSchema, {
                observedAtMs,
                sources: [
                    {
                        availability: "available",
                        group: "host",
                        id: "host.auth",
                        label: "Authentication",
                        modifiedAtMs: observedAtMs,
                        sizeBytes: 42,
                    },
                ],
            })
        ).toMatchObject({ sources: [{ id: "host.auth" }] });
        expect(
            v.safeParse(listLogSourcesOutputSchema, {
                observedAtMs,
                sources: [
                    {
                        availability: "available",
                        group: "host",
                        id: "../var/log/auth.log",
                        label: "Authentication",
                    },
                ],
            }).success
        ).toBe(false);
    });

    test("defaults tail and search budgets and rejects oversized inputs", () => {
        expect(
            v.parse(tailLogsInputSchema, { sourceId: "dashboard.web.stdout" })
        ).toEqual({ limit: 200, sourceId: "dashboard.web.stdout" });
        expect(
            v.parse(searchLogsInputSchema, {
                query: "error",
                sourceId: "dashboard.web.stdout",
            })
        ).toMatchObject({ limit: 200, query: "error" });
        expect(
            v.safeParse(tailLogsInputSchema, {
                limit: logRowMaximum + 1,
                sourceId: "host.auth",
            }).success
        ).toBe(false);
    });

    test("bounds rows and rejects duplicate line identities", () => {
        const line = { id: digest, line: "ready", severity: "info" };
        expect(
            v.parse(logSnapshotOutputSchema, {
                hasEarlier: false,
                lines: [line],
                observedAtMs,
                revision: digest,
                scannedBytes: 5,
                sourceId: "host.auth",
            })
        ).toMatchObject({ lines: [line] });
        expect(
            v.safeParse(logSnapshotOutputSchema, {
                hasEarlier: false,
                lines: [{ ...line, line: "x".repeat(logLineMaximumCharacters + 1) }],
                observedAtMs,
                revision: digest,
                scannedBytes: 5,
                sourceId: "host.auth",
            }).success
        ).toBe(false);
        expect(
            v.safeParse(logSnapshotOutputSchema, {
                hasEarlier: false,
                lines: [line, line],
                observedAtMs,
                revision: digest,
                scannedBytes: 5,
                sourceId: "host.auth",
            }).success
        ).toBe(false);
    });

    test("requires the complete fixed maintenance policy inventory", () => {
        expect(
            v.parse(logMaintenanceStatusOutputSchema, {
                observedAtMs,
                policies: logMaintenancePolicyIds.map((id) => ({
                    id,
                    label: id,
                    scope: id === "docker-managed" ? "docker" : "host",
                    state: "queueable",
                })),
            }).policies
        ).toHaveLength(logMaintenancePolicyIds.length);
    });

    test("defaults real maintenance mode and limits dry-run to the managed policy", () => {
        const request = {
            idempotencyKey: "log-maintenance-019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
            policyId: "docker-managed",
        } as const;

        expect(v.parse(requestLogMaintenanceInputSchema, request)).toEqual({
            dryRun: false,
            ...request,
        });
        expect(
            v.parse(requestLogMaintenanceInputSchema, { ...request, dryRun: true })
        ).toMatchObject({ dryRun: true, policyId: "docker-managed" });
        expect(
            v.safeParse(requestLogMaintenanceInputSchema, {
                ...request,
                dryRun: true,
                policyId: "host-rsyslog",
            }).success
        ).toBe(false);
    });

    test("accepts only coherent successful managed maintenance results", () => {
        const summary = {
            actionCounts: {
                compressed: 1,
                deleted: 2,
                error: 0,
                missing: 0,
                rotated: 3,
                skipped: 4,
            },
            checkedTargets: 10,
            dryRun: false,
            finishedAtMs: observedAtMs + 100,
            ok: true,
            startedAtMs: observedAtMs,
        } as const;
        const result = {
            completedAtMs: observedAtMs + 200,
            dryRun: false,
            policyId: "docker-managed",
            status: "completed",
            summary,
        } as const;

        expect(v.parse(logMaintenanceJobResultSchema, result)).toEqual(result);
        expect(
            v.safeParse(logMaintenanceJobResultSchema, {
                ...result,
                dryRun: true,
                policyId: "host-rsyslog",
                summary: undefined,
            }).success
        ).toBe(false);
        expect(
            v.safeParse(logMaintenanceJobResultSchema, {
                ...result,
                policyId: "host-rsyslog",
                summary: undefined,
            }).success
        ).toBe(true);
        expect(
            v.safeParse(logMaintenanceJobResultSchema, {
                ...result,
                policyId: "host-rsyslog",
            }).success
        ).toBe(false);
        expect(
            v.safeParse(logMaintenanceJobResultSchema, {
                ...result,
                summary: { ...summary, ok: false },
            }).success
        ).toBe(false);
        expect(
            v.safeParse(logMaintenanceJobResultSchema, {
                ...result,
                completedAtMs: summary.finishedAtMs - 1,
            }).success
        ).toBe(false);
    });

    test("publishes bounded reads and recent-MFA worker dispatch metadata", () => {
        expect(logProcedureContracts.map(({ name }) => name)).toEqual([
            "logs.listSources",
            "logs.tail",
            "logs.search",
            "logs.maintenanceStatus",
            "logs.requestMaintenance",
        ]);
        expect(logProcedureContracts.at(-1)?.access).toEqual({
            capabilities: ["logs:write"],
            kind: "recent-auth",
            principalKinds: ["session"],
            whenMfaDisabled: "deny",
            whenMfaEnabled: "mfa",
        });
    });
});
