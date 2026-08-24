import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    type GatewaySession,
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
    gatewaySessionActionResultSchema,
    gatewaySessionProcedureContracts,
    gatewaySessionProjectionMaximum,
    listGatewaySessionsInputSchema,
    listGatewaySessionsResultSchema,
} from "./gatewaySessions.ts";

const observedAtMs = 1_800_000_000_000;

function session(
    key: string,
    kind: GatewaySession["kind"],
    updatedAtMs: number,
    overrides: Partial<GatewaySession> = {}
): GatewaySession {
    return {
        displayName: key,
        hasActiveRun: false,
        key,
        kind,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        totalTokens: 1234,
        totalTokensFresh: true,
        updatedAtMs,
        ...overrides,
    };
}

function validSnapshot() {
    const sessions = [
        session(gatewayPrimarySessionKey, "main", observedAtMs - 5000, {
            hasActiveRun: true,
        }),
        session("agent:coder:main", "subagent", observedAtMs - 10_000),
        session("agent:main:subagent:recent", "subagent", observedAtMs - 20_000),
        session("hook:startup", "hook", observedAtMs - 3_700_000),
        session("cron:daily", "cron", observedAtMs - 30_000),
    ];
    return {
        filter: "ALL" as const,
        projectionTruncated: false,
        sessions,
        source: {
            checkedAtMs: observedAtMs,
            connection: "connected" as const,
            freshness: "fresh" as const,
            observedAtMs,
        },
        stats: deriveGatewaySessionStats(sessions, observedAtMs),
    };
}

describe("Gateway session contracts", () => {
    test("defaults to ALL and accepts one strict same-snapshot projection", () => {
        expect(v.parse(listGatewaySessionsInputSchema, {})).toEqual({ filter: "ALL" });
        const parsed = v.parse(listGatewaySessionsResultSchema, validSnapshot());
        expect(parsed.sessions[0]?.key).toBe(gatewayPrimarySessionKey);
        expect(parsed.stats).toEqual({
            activeInLastHour: 4,
            byKind: { cron: 1, hook: 1, main: 1, subagent: 2, unknown: 0 },
            byModel: [{ count: 5, model: "gpt-5.6-sol" }],
            shown: 5,
            tokenTotalState: "complete",
            totalTokens: 6170,
            unknownModelCount: 0,
        });
    });

    test("rejects duplicate, unstable, over-budget, and inconsistent projections", () => {
        const valid = validSnapshot();
        const duplicate = {
            ...valid,
            sessions: [valid.sessions[0], valid.sessions[0]],
            stats: deriveGatewaySessionStats(
                [valid.sessions[0]!, valid.sessions[0]!],
                observedAtMs
            ),
        };
        const unstable = {
            ...valid,
            sessions: [valid.sessions[1], valid.sessions[0]],
            stats: deriveGatewaySessionStats(
                [valid.sessions[1]!, valid.sessions[0]!],
                observedAtMs
            ),
        };
        const inconsistent = {
            ...valid,
            stats: { ...valid.stats, activeInLastHour: 5 },
        };
        const inconsistentTokens = {
            ...valid,
            sessions: valid.sessions.map((item, index) =>
                index === 0
                    ? { ...item, totalTokens: undefined, totalTokensFresh: true }
                    : item
            ),
        };
        const overBudget = {
            ...valid,
            sessions: Array.from(
                { length: gatewaySessionProjectionMaximum + 1 },
                (_, index) =>
                    session(
                        `cron:${index.toString().padStart(3, "0")}`,
                        "cron",
                        observedAtMs - index
                    )
            ),
            stats: deriveGatewaySessionStats(
                Array.from({ length: gatewaySessionProjectionMaximum + 1 }, (_, index) =>
                    session(
                        `cron:${index.toString().padStart(3, "0")}`,
                        "cron",
                        observedAtMs - index
                    )
                ),
                observedAtMs
            ),
        };

        for (const candidate of [
            duplicate,
            unstable,
            inconsistent,
            inconsistentTokens,
            overBudget,
        ]) {
            expect(v.safeParse(listGatewaySessionsResultSchema, candidate).success).toBe(
                false
            );
        }
    });

    test("accepts stale last-known-good data but rejects impossible freshness", () => {
        const valid = validSnapshot();
        const stale = {
            ...valid,
            source: {
                checkedAtMs: observedAtMs + 10_000,
                connection: "disconnected" as const,
                freshness: "stale" as const,
                observedAtMs,
            },
        };
        expect(v.safeParse(listGatewaySessionsResultSchema, stale).success).toBe(true);
        expect(
            v.safeParse(listGatewaySessionsResultSchema, {
                ...stale,
                source: { ...stale.source, checkedAtMs: observedAtMs - 1 },
            }).success
        ).toBe(false);
    });

    test("preserves an unknown upstream activity time without counting it as recent", () => {
        const valid = validSnapshot();
        const unknownActivity = session(
            "agent:unknown:main",
            "subagent",
            observedAtMs - 15_000,
            { updatedAtMs: undefined }
        );
        const candidate = {
            ...valid,
            sessions: [
                valid.sessions[0],
                valid.sessions[1],
                valid.sessions[2],
                unknownActivity,
                ...valid.sessions.slice(3),
            ],
            stats: deriveGatewaySessionStats(
                [
                    valid.sessions[0]!,
                    valid.sessions[1]!,
                    valid.sessions[2]!,
                    unknownActivity,
                    ...valid.sessions.slice(3),
                ],
                observedAtMs
            ),
        };

        const parsed = v.parse(listGatewaySessionsResultSchema, candidate);
        expect(parsed.sessions[3]?.updatedAtMs).toBeUndefined();
        expect(parsed.stats.activeInLastHour).toBe(4);
    });

    test("derives model and token totals without overflowing safe integers", () => {
        const complete = deriveGatewaySessionStats(
            [
                session("agent:z:main", "subagent", observedAtMs, {
                    model: "z-model",
                    totalTokens: 10,
                }),
                session("agent:a:main", "subagent", observedAtMs, {
                    model: "a-model",
                    totalTokens: 20,
                }),
            ],
            observedAtMs
        );
        expect(complete).toMatchObject({
            byModel: [
                { count: 1, model: "a-model" },
                { count: 1, model: "z-model" },
            ],
            tokenTotalState: "complete",
            totalTokens: 30,
            unknownModelCount: 0,
        });

        const partial = deriveGatewaySessionStats(
            [
                session("agent:known:main", "subagent", observedAtMs, {
                    totalTokens: 10,
                }),
                session("agent:unknown:main", "subagent", observedAtMs, {
                    model: undefined,
                    modelProvider: undefined,
                    totalTokens: undefined,
                    totalTokensFresh: false,
                }),
            ],
            observedAtMs
        );
        expect(partial).toMatchObject({
            tokenTotalState: "partial",
            totalTokens: 10,
            unknownModelCount: 1,
        });

        const overflow = deriveGatewaySessionStats(
            [
                session("agent:max:main", "subagent", observedAtMs, {
                    totalTokens: Number.MAX_SAFE_INTEGER,
                }),
                session("agent:one:main", "subagent", observedAtMs, {
                    totalTokens: 1,
                }),
            ],
            observedAtMs
        );
        expect(overflow.tokenTotalState).toBe("overflow");
        expect(overflow.totalTokens).toBeUndefined();
    });

    test("rejects inconsistent active-run and lifecycle projections", () => {
        for (const candidate of [
            session("agent:inactive:main", "subagent", observedAtMs, {
                activeRunIds: ["run-1"],
                hasActiveRun: false,
            }),
            session("agent:ended-before-started:main", "subagent", observedAtMs, {
                endedAtMs: observedAtMs - 20_000,
                startedAtMs: observedAtMs - 10_000,
            }),
            session("agent:ended-before-created:main", "subagent", observedAtMs, {
                createdAtMs: observedAtMs - 10_000,
                endedAtMs: observedAtMs - 20_000,
            }),
        ]) {
            expect(
                v.safeParse(listGatewaySessionsResultSchema, {
                    ...validSnapshot(),
                    sessions: [candidate],
                    stats: deriveGatewaySessionStats([candidate], observedAtMs),
                }).success
            ).toBe(false);
        }
    });

    test("requires action refreshes to return the unfiltered projection", () => {
        const valid = validSnapshot();
        expect(
            v.safeParse(gatewaySessionActionResultSchema, {
                action: "delete",
                key: "cron:daily",
                outcome: "changed",
                refresh: { snapshot: valid, status: "available" },
            }).success
        ).toBe(true);
        expect(
            v.safeParse(gatewaySessionActionResultSchema, {
                action: "delete",
                key: "cron:daily",
                outcome: "changed",
                refresh: {
                    snapshot: { ...valid, filter: "CRON" },
                    status: "available",
                },
            }).success
        ).toBe(false);
    });

    test("allows an unchanged outcome only for compaction", () => {
        const valid = validSnapshot();
        expect(
            v.safeParse(gatewaySessionActionResultSchema, {
                action: "compact",
                key: gatewayPrimarySessionKey,
                outcome: "unchanged",
                refresh: { status: "unavailable" },
            }).success
        ).toBe(true);
        for (const action of ["reset", "delete"] as const) {
            expect(
                v.safeParse(gatewaySessionActionResultSchema, {
                    action,
                    key: gatewayPrimarySessionKey,
                    outcome: "unchanged",
                    refresh: { snapshot: valid, status: "available" },
                }).success
            ).toBe(false);
            expect(
                v.safeParse(gatewaySessionActionResultSchema, {
                    action,
                    key: gatewayPrimarySessionKey,
                    outcome: "unchanged",
                    refresh: { status: "unavailable" },
                }).success
            ).toBe(false);
        }
    });

    test("locks reads to browser sessions and controls to recent MFA", () => {
        const contracts = Object.fromEntries(
            gatewaySessionProcedureContracts.map((contract) => [contract.name, contract])
        );
        expect(contracts["gatewaySessions.list"]?.access).toEqual({
            capabilities: ["gateway-sessions:read"],
            capabilityPolicy: "all",
            kind: "authenticated",
            principalKinds: ["session"],
        });
        for (const name of [
            "gatewaySessions.compact",
            "gatewaySessions.reset",
            "gatewaySessions.delete",
        ]) {
            const contract = contracts[name];
            expect(contract?.access).toEqual({
                capabilities: ["gateway-sessions:write"],
                kind: "recent-auth",
                principalKinds: ["session"],
                whenMfaDisabled: "deny",
                whenMfaEnabled: "mfa",
            });
            expect(
                contract !== undefined && "errorReasons" in contract
                    ? contract.errorReasons
                    : undefined
            ).toEqual([
                "mfa_enrollment_required",
                "operation_outcome_unknown",
                "step_up_required",
            ]);
            expect(contract?.errors).toContain("SERVICE_UNAVAILABLE");
            expect(contract?.errors).not.toContain("PRECONDITION_FAILED");
        }
    });
});
