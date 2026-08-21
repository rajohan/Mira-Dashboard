import { describe, expect, test } from "bun:test";

import type { AgentStatus } from "../../../contracts/agentModel.ts";
import {
    type GatewaySession,
    type ListGatewaySessionsResult,
    deriveGatewaySessionStats,
} from "../../../contracts/gatewaySessions.ts";
import { GatewaySessionsUnavailableError } from "../gatewaySessions/errors.ts";
import type { GatewaySessionsService } from "../gatewaySessions/service.ts";
import {
    projectAgentGatewayAvailability,
    readAgentGatewayAvailability,
} from "./gatewayAvailability.ts";

const observedAtMs = 1_800_000_000_000;
const unexpectedControl = (): Promise<never> =>
    Promise.reject(new TypeError("Unexpected session control"));
const statuses = Object.freeze([
    {
        agentId: "coder",
        lastActivityAtMs: observedAtMs - 1000,
        state: "idle",
    },
    {
        agentId: "main",
        currentTask: "Keep Dashboard task state independent",
        lastActivityAtMs: observedAtMs,
        startedAtMs: observedAtMs - 2000,
        state: "working",
    },
    { agentId: "researcher", state: "idle" },
] as const satisfies readonly AgentStatus[]);

function session(
    key: string,
    hasActiveRun: boolean,
    updatedAtMs: number,
    overrides: Partial<GatewaySession> = {}
): GatewaySession {
    return {
        displayName: key,
        hasActiveRun,
        key,
        kind: key.includes(":subagent:") ? "subagent" : "main",
        totalTokensFresh: false,
        updatedAtMs,
        ...overrides,
    };
}

function snapshot(
    sessions: readonly GatewaySession[],
    freshness: "fresh" | "stale",
    projectionTruncated = false
): ListGatewaySessionsResult {
    return {
        filter: "ALL",
        projectionTruncated,
        sessions: [...sessions],
        source:
            freshness === "fresh"
                ? {
                      checkedAtMs: observedAtMs,
                      connection: "connected",
                      freshness,
                      observedAtMs,
                  }
                : {
                      checkedAtMs: observedAtMs + 10_000,
                      connection: "disconnected",
                      freshness,
                      observedAtMs,
                  },
        stats: deriveGatewaySessionStats(sessions, observedAtMs),
    };
}

describe("agent Gateway availability", () => {
    test("enriches only supplied reviewed IDs and preserves Dashboard task states", () => {
        const projected = projectAgentGatewayAvailability(
            statuses,
            snapshot(
                [
                    session("agent:coder:main", false, observedAtMs - 5000),
                    session("agent:main:subagent:newer-idle", false, observedAtMs),
                    session(
                        "agent:main:subagent:older-active",
                        true,
                        observedAtMs - 1000,
                        {
                            model: "gpt-5.6-sol",
                            modelProvider: "openai",
                        }
                    ),
                    session("agent:unreviewed:main", true, observedAtMs),
                ],
                "fresh"
            )
        );

        expect(projected.map(({ agentId }) => agentId)).toEqual([
            "coder",
            "main",
            "researcher",
        ]);
        expect(projected.find(({ agentId }) => agentId === "main")).toEqual({
            agentId: "main",
            currentTask: "Keep Dashboard task state independent",
            freshness: "fresh",
            gatewayAvailability: "active",
            hasActiveRun: true,
            lastActivityAtMs: observedAtMs,
            lastSeenAtMs: observedAtMs - 1000,
            observedAtMs,
            providerModel: "openai/gpt-5.6-sol",
            sessionKey: "agent:main:subagent:older-active",
            startedAtMs: observedAtMs - 2000,
            state: "working",
        });
        expect(projected.find(({ agentId }) => agentId === "coder")).toMatchObject({
            gatewayAvailability: "idle",
            hasActiveRun: false,
            state: "idle",
        });
        expect(projected.find(({ agentId }) => agentId === "researcher")).toEqual({
            agentId: "researcher",
            freshness: "fresh",
            gatewayAvailability: "unknown",
            observedAtMs,
            state: "idle",
        });
        expect(projected.some(({ agentId }) => agentId === "unreviewed")).toBeFalse();
    });

    test("retains matching last-known-good metadata and marks absent agents disconnected", () => {
        const projected = projectAgentGatewayAvailability(
            statuses,
            snapshot([session("agent:main:main", true, observedAtMs - 3000)], "stale")
        );

        expect(projected.find(({ agentId }) => agentId === "main")).toMatchObject({
            freshness: "stale",
            gatewayAvailability: "stale",
            hasActiveRun: true,
            lastSeenAtMs: observedAtMs - 3000,
            sessionKey: "agent:main:main",
            state: "working",
        });
        expect(projected.find(({ agentId }) => agentId === "researcher")).toEqual({
            agentId: "researcher",
            freshness: "stale",
            gatewayAvailability: "disconnected",
            observedAtMs,
            state: "idle",
        });
    });

    test("does not infer disconnection from an absent row in a truncated stale projection", () => {
        const projected = projectAgentGatewayAvailability(
            statuses,
            snapshot([session("agent:main:main", true, observedAtMs)], "stale", true)
        );

        expect(projected.find(({ agentId }) => agentId === "researcher")).toEqual({
            agentId: "researcher",
            freshness: "stale",
            gatewayAvailability: "unknown",
            observedAtMs,
            state: "idle",
        });
    });

    test("degrades initial session unavailability without dropping configured statuses", async () => {
        const gatewaySessionsService: GatewaySessionsService = {
            compact: unexpectedControl,
            delete: unexpectedControl,
            list: () => Promise.reject(new GatewaySessionsUnavailableError()),
            reset: unexpectedControl,
        };
        const projected = await readAgentGatewayAvailability(
            statuses,
            gatewaySessionsService
        );

        expect(projected).toHaveLength(statuses.length);
        expect(projected).toEqual(
            statuses.map((status) => ({
                ...status,
                freshness: "unavailable",
                gatewayAvailability: "disconnected",
            }))
        );
    });
});
