import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    listOpenClawCronInputSchema,
    listOpenClawCronResultSchema,
    openClawCronDeliveryPatchSchema,
    openClawCronDeliverySchema,
    openClawCronJobIdSchema,
    openClawCronJobSchema,
    openClawCronProcedureContracts,
    setOpenClawCronEnabledInputSchema,
    updateOpenClawCronInputSchema,
} from "./openClawCron.ts";

describe("OpenClaw cron contracts", () => {
    test("keeps reads session-only and every control behind recent MFA", () => {
        expect(
            openClawCronProcedureContracts.map(({ access, kind, name, transport }) => ({
                access,
                batching: transport.batching,
                kind,
                name,
            }))
        ).toEqual([
            {
                access: {
                    capabilities: ["jobs:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                batching: "adapter-default",
                kind: "query",
                name: "openClawCron.list",
            },
            {
                access: {
                    capabilities: ["jobs:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                batching: "adapter-default",
                kind: "query",
                name: "openClawCron.get",
            },
            {
                access: {
                    capabilities: ["jobs:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                batching: "adapter-default",
                kind: "query",
                name: "openClawCron.listRuns",
            },
            ...["run", "setEnabled", "update", "delete"].map((operation) => ({
                access: {
                    capabilities: ["jobs:write"] as const,
                    kind: "recent-auth" as const,
                    principalKinds: ["session"] as const,
                    whenMfaDisabled: "deny" as const,
                    whenMfaEnabled: "mfa" as const,
                },
                batching: "forbidden",
                kind: "mutation",
                name: `openClawCron.${operation}`,
            })),
        ]);
        for (const contract of openClawCronProcedureContracts.filter(
            ({ kind }) => kind === "mutation"
        )) {
            if (!("errorReasons" in contract)) {
                throw new Error("OpenClaw cron control is missing error reasons");
            }
            expect(contract.errorReasons).toEqual([
                "mfa_enrollment_required",
                "operation_outcome_unknown",
                "step_up_required",
            ]);
        }
    });

    test("defaults to the bounded current-protocol inventory page", () => {
        expect(v.parse(listOpenClawCronInputSchema, {})).toEqual({
            enabled: "all",
            lastRunStatus: "all",
            limit: 50,
            offset: 0,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        });
        expect(
            v.safeParse(listOpenClawCronInputSchema, { limit: 101 }).success
        ).toBeFalse();
    });

    test("keeps external job ids inside the persisted 256-character boundary", () => {
        expect(v.safeParse(openClawCronJobIdSchema, "x".repeat(256)).success).toBeTrue();
        expect(v.safeParse(openClawCronJobIdSchema, "x".repeat(257)).success).toBeFalse();
    });

    test("requires canonical list pagination and a bounded snapshot revision", () => {
        const page = {
            freshness: { kind: "fresh", observedAtMs: 100 },
            hasMore: true,
            jobs: [],
            limit: 1,
            nextOffset: 1,
            offset: 0,
            snapshotRevision: `sha256:${"A".repeat(43)}`,
            total: 2,
        };
        expect(v.safeParse(listOpenClawCronResultSchema, page).success).toBeFalse();
        expect(
            v.safeParse(listOpenClawCronResultSchema, {
                ...page,
                hasMore: false,
                nextOffset: undefined,
                total: 0,
            }).success
        ).toBeTrue();
    });

    test("requires an explicit disable annotation and a future check in the service", () => {
        expect(
            v.safeParse(setOpenClawCronEnabledInputSchema, {
                disableIntent: { reason: "Maintenance" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            }).success
        ).toBeTrue();
        expect(
            v.safeParse(setOpenClawCronEnabledInputSchema, {
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(setOpenClawCronEnabledInputSchema, {
                disableIntent: { reason: "No longer needed" },
                enabled: true,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            }).success
        ).toBeFalse();
    });

    test("accepts only reviewed update fields and rejects generic Gateway patches", () => {
        const base = {
            expectedConfigRevision: "revision-1",
            id: "nightly-report",
        };
        expect(
            v.parse(updateOpenClawCronInputSchema, {
                ...base,
                patch: {
                    name: "Nightly report",
                    delivery: {
                        accountId: null,
                        bestEffort: false,
                        channel: null,
                        completionDestination: null,
                        failureDestination: {
                            accountId: null,
                            channel: null,
                            mode: null,
                            to: null,
                        },
                        mode: "announce",
                        threadId: null,
                        to: null,
                    },
                    payload: {
                        kind: "agent-turn",
                        message: "Produce the reviewed report.",
                        model: null,
                    },
                    schedule: { expr: "0 7 * * *", kind: "cron", tz: "Europe/Oslo" },
                },
            }).patch
        ).toEqual({
            delivery: {
                accountId: null,
                bestEffort: false,
                channel: null,
                completionDestination: null,
                failureDestination: {
                    accountId: null,
                    channel: null,
                    mode: null,
                    to: null,
                },
                mode: "announce",
                threadId: null,
                to: null,
            },
            name: "Nightly report",
            payload: {
                kind: "agent-turn",
                message: "Produce the reviewed report.",
                model: null,
            },
            schedule: { expr: "0 7 * * *", kind: "cron", tz: "Europe/Oslo" },
        });
        for (const patch of [
            {},
            { enabled: false },
            { payload: { argv: ["sh", "-c", "unsafe"], kind: "command" } },
            { state: { runningAtMs: 1 } },
        ]) {
            expect(
                v.safeParse(updateOpenClawCronInputSchema, { ...base, patch }).success
            ).toBeFalse();
        }
    });

    test("locks full delivery variants and every reviewed null-clear boundary", () => {
        expect(
            v.parse(openClawCronDeliverySchema, {
                accountId: "operations",
                bestEffort: true,
                channel: "last",
                completionDestination: {
                    mode: "webhook",
                    to: "https://example.test/completed",
                },
                failureDestination: {
                    accountId: "alerts",
                    channel: "slack",
                    mode: "announce",
                    to: "C012345",
                },
                mode: "announce",
                threadId: 42,
                to: "C012345",
            })
        ).toMatchObject({ mode: "announce", threadId: 42 });
        expect(
            v.safeParse(openClawCronDeliverySchema, { mode: "none" }).success
        ).toBeTrue();
        expect(
            v.safeParse(openClawCronDeliverySchema, {
                mode: "webhook",
                to: "https://example.test/hook",
            }).success
        ).toBeTrue();
        expect(
            v.safeParse(openClawCronDeliverySchema, { mode: "webhook" }).success
        ).toBeFalse();

        const clears = {
            accountId: null,
            bestEffort: false,
            channel: null,
            completionDestination: null,
            failureDestination: {
                accountId: null,
                channel: null,
                mode: null,
                to: null,
            },
            mode: "announce",
            threadId: null,
            to: null,
        };
        expect(v.parse(openClawCronDeliveryPatchSchema, clears)).toEqual(clears);
        expect(
            v.safeParse(openClawCronDeliveryPatchSchema, {
                bestEffort: null,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(openClawCronDeliveryPatchSchema, {
                completionDestination: { mode: "announce", to: "invalid" },
            }).success
        ).toBeFalse();
    });

    test("rejects contradictory browser job delivery and synchronization projections", () => {
        const job = {
            agentIdTruncated: false,
            createdAtMs: 100,
            deliveryMode: "unspecified" as const,
            descriptionTruncated: false,
            enabled: true,
            id: "nightly-report",
            name: "Nightly report",
            nameTruncated: false,
            payload: { kind: "heartbeat" as const },
            schedule: { everyMs: 60_000, kind: "every" as const, truncated: false },
            sessionTarget: "isolated" as const,
            source: "openclaw" as const,
            state: {},
            synchronization: { state: "confirmed" as const },
            updatedAtMs: 200,
            wakeMode: "now" as const,
        };
        expect(v.safeParse(openClawCronJobSchema, job).success).toBeTrue();
        expect(
            v.safeParse(openClawCronJobSchema, {
                ...job,
                deliveryMode: "announce",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(openClawCronJobSchema, {
                ...job,
                delivery: {
                    completionDestinationConfigured: false,
                    metadataTruncated: false,
                    mode: "announce",
                    targetConfigured: false,
                },
                deliveryMode: "webhook",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(openClawCronJobSchema, {
                ...job,
                synchronization: { desiredEnabled: false, state: "confirmed" },
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(openClawCronJobSchema, {
                ...job,
                synchronization: { desiredEnabled: true, state: "pending" },
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(openClawCronJobSchema, {
                ...job,
                synchronization: { desiredEnabled: false, state: "conflict" },
            }).success
        ).toBeTrue();
    });
});
