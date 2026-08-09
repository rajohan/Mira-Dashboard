import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    logLineMaximumCharacters,
    logMaintenancePolicyIds,
    logMaintenanceStatusOutputSchema,
    logProcedureContracts,
    logRowMaximum,
    logSnapshotOutputSchema,
    listLogSourcesOutputSchema,
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
