import { describe, expect, test } from "bun:test";

import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import {
    chatCompanionResetObservationConfirmsReset,
    chatProviderObservationIsNewer,
    chatRuntimeObservationAdvancesRun,
    chatTaskObservationAdvances,
} from "./chatPostMutationObservations.ts";
import type { ChatRuntimeBatch } from "./chatQueries.ts";

const observedAtMs = 1_800_000_000_000;
const runId = "019fe640-df89-7863-9f28-bcab49241d6f";

function inventory(
    freshness: "fresh" | "stale",
    providerObservedAtMs: number
): ListGatewaySessionsResult {
    return {
        filter: "ALL",
        projectionTruncated: false,
        sessions: [],
        source:
            freshness === "fresh"
                ? {
                      checkedAtMs: providerObservedAtMs,
                      connection: "connected",
                      freshness,
                      observedAtMs: providerObservedAtMs,
                  }
                : {
                      checkedAtMs: providerObservedAtMs + 1,
                      connection: "disconnected",
                      freshness,
                      observedAtMs: providerObservedAtMs,
                  },
        stats: deriveGatewaySessionStats([], providerObservedAtMs),
    };
}

function runtime(sequence: number): ChatRuntimeBatch {
    return {
        cursor: String(sequence),
        events: [],
        externalRuns: [],
        externalRunsTruncated: false,
        hasMore: false,
        resetRequired: true,
        runs: [
            {
                firstSequence: 1,
                parts: [],
                projectionTruncated: false,
                run: {
                    admittedAtMs: observedAtMs,
                    id: runId,
                    reconciliation: "runtime-authoritative",
                    sessionKey: gatewayPrimarySessionKey,
                    state: "active",
                    stateVersion: sequence,
                    updatedAtMs: observedAtMs + sequence,
                },
                throughSequence: sequence,
            },
        ],
        sessionKey: gatewayPrimarySessionKey,
        transcriptGeneration: 1,
    };
}

describe("chat post-mutation observations", () => {
    test("requires a strictly newer fresh provider inventory", () => {
        const boundary = { observedAtMs };
        expect(
            chatProviderObservationIsNewer(boundary, inventory("stale", observedAtMs + 1))
        ).toBe(false);
        expect(
            chatProviderObservationIsNewer(boundary, inventory("fresh", observedAtMs))
        ).toBe(false);
        expect(
            chatProviderObservationIsNewer(boundary, inventory("fresh", observedAtMs + 1))
        ).toBe(true);
    });

    test("accepts an action-owned empty reset observation from an empty prestate", () => {
        expect(
            chatCompanionResetObservationConfirmsReset(
                { stateFingerprint: "[]" },
                { exchanges: [] }
            )
        ).toBe(true);
    });

    test("requires the exact runtime target to advance", () => {
        const boundary = {
            runId,
            runLastSequence: 4,
            sessionKey: gatewayPrimarySessionKey,
        };
        expect(chatRuntimeObservationAdvancesRun(boundary, runtime(4))).toBe(false);
        expect(chatRuntimeObservationAdvancesRun(boundary, runtime(5))).toBe(true);
        expect(
            chatRuntimeObservationAdvancesRun(boundary, {
                ...runtime(5),
                sessionKey: "agent:other:main",
            })
        ).toBe(false);
    });

    test("accepts only terminal or strictly newer task state", () => {
        const boundary = { taskUpdatedAtMs: observedAtMs };
        const running = {
            id: "task-1",
            status: "running" as const,
            updatedAtMs: observedAtMs,
        };
        expect(chatTaskObservationAdvances(boundary, running)).toBe(false);
        expect(
            chatTaskObservationAdvances(boundary, {
                ...running,
                updatedAtMs: observedAtMs + 1,
            })
        ).toBe(true);
        expect(
            chatTaskObservationAdvances(boundary, {
                ...running,
                status: "cancelled",
            })
        ).toBe(true);
    });
});
