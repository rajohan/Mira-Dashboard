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
    requestLogMaintenanceOutputSchema,
    searchLogsInputSchema,
    tailLogsInputSchema,
} from "./logs.ts";

const observedAtMs = 1_800_000_000_000;
const digest = "a".repeat(64);

function maintenanceRun(
    state: "queued" | "succeeded",
    overrides: Record<string, unknown> = {}
) {
    const terminal = state === "succeeded";
    return {
        actionKey: "maintenance.rotate-logs",
        attemptCount: terminal ? 1 : 0,
        attemptLimit: 1,
        availableAtMs: observedAtMs,
        cancellationPolicy: "cooperative",
        displayName: "Managed log maintenance",
        eventCount: terminal ? 3 : 1,
        ...(terminal
            ? {
                  finishedAtMs: observedAtMs + 200,
                  firstStartedAtMs: observedAtMs + 100,
                  lastAttemptStartedAtMs: observedAtMs + 100,
              }
            : {}),
        id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
        priority: 0,
        queuedAtMs: observedAtMs,
        resourceClass: "host-heavy",
        resourceKeys: ["host.logs"],
        retrySafe: false,
        state,
        stateVersion: terminal ? 3 : 1,
        timeoutMs: 300_000,
        triggerType: "system",
        updatedAtMs: terminal ? observedAtMs + 200 : observedAtMs,
        ...overrides,
    };
}

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
        const policies = logMaintenancePolicyIds.map((id) => ({
            id,
            label: id,
            scope: id === "docker-managed" ? ("docker" as const) : ("host" as const),
            state: "queueable" as const,
        }));
        expect(
            v.parse(logMaintenanceStatusOutputSchema, {
                observedAtMs,
                policies,
            }).policies
        ).toHaveLength(logMaintenancePolicyIds.length);

        const incoherentPolicies = [
            policies.map((policy) =>
                policy.id === "docker-managed"
                    ? { ...policy, scope: "host" as const }
                    : policy
            ),
            policies.map((policy) =>
                policy.id === "docker-managed"
                    ? {
                          ...policy,
                          activeRun: maintenanceRun("queued", {
                              actionKey: "system.worker-smoke",
                          }),
                      }
                    : policy
            ),
            policies.map((policy) =>
                policy.id === "host-rsyslog"
                    ? {
                          ...policy,
                          lastRun: { run: maintenanceRun("succeeded"), summary },
                      }
                    : policy
            ),
            policies.map((policy) =>
                policy.id === "docker-managed"
                    ? {
                          ...policy,
                          lastRun: {
                              run: maintenanceRun("succeeded"),
                              summary: { ...summary, ok: false },
                          },
                      }
                    : policy
            ),
        ];
        for (const invalidPolicies of incoherentPolicies) {
            expect(
                v.safeParse(logMaintenanceStatusOutputSchema, {
                    observedAtMs,
                    policies: invalidPolicies,
                }).success
            ).toBe(false);
        }
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
        expect(
            v.safeParse(requestLogMaintenanceOutputSchema, {
                dryRun: true,
                jobRunId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b5",
                policyId: "host-rsyslog",
                queued: true,
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
                summary: undefined,
            }).success
        ).toBe(false);
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
                summary: {
                    ...summary,
                    actionCounts: { ...summary.actionCounts, error: 1 },
                },
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
