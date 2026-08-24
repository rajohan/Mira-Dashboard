import { describe, expect, test } from "bun:test";

import type { GatewayConnectionSnapshot } from "../../contracts/gatewayConnection.ts";
import type { JobQueueSummary } from "../../contracts/jobs.ts";
import { projectDashboardSystemStatus } from "./dashboardSystemStatus.ts";

const observedAtMs = 1_800_000_000_000;
const gateway = Object.freeze({
    checkedAtMs: observedAtMs,
    connectedAtMs: observedAtMs - 1000,
    connectionGeneration: 2,
    freshness: "fresh",
    lastActivityAtMs: observedAtMs,
    phase: "connected",
    reconnectAttempt: 0,
} satisfies GatewayConnectionSnapshot);
const workerSummary = Object.freeze({
    activeResourceClasses: [],
    control: { claimingPaused: false, updatedAtMs: observedAtMs, version: 1 },
    stateCounts: {
        cancelled: 0,
        failed: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
        "timed-out": 0,
    },
    workers: [
        {
            activeRunCount: 0,
            capacity: 1,
            heartbeatAtMs: observedAtMs,
            id: "019fe300-0000-7000-8000-000000000001",
            releaseId: "a".repeat(40),
            startedAtMs: observedAtMs - 60_000,
            state: "online",
        },
    ],
} satisfies JobQueueSummary);

describe("Dashboard system status projection", () => {
    test("reports online only when every bounded observation is online", () => {
        expect(
            projectDashboardSystemStatus({
                backendReady: true,
                gateway,
                workerSummary,
            })
        ).toEqual({
            backend: "online",
            gateway: "online",
            overall: "online",
            worker: "online",
        });
    });

    test("does not treat missing observations as healthy", () => {
        expect(projectDashboardSystemStatus({})).toEqual({
            backend: "unavailable",
            gateway: "unavailable",
            overall: "unavailable",
            worker: "unavailable",
        });
    });

    test("surfaces a paused worker or degraded Gateway as attention", () => {
        expect(
            projectDashboardSystemStatus({
                backendReady: true,
                gateway: { ...gateway, freshness: "stale", phase: "degraded" },
                workerSummary: {
                    ...workerSummary,
                    control: { ...workerSummary.control, claimingPaused: true },
                },
            })
        ).toMatchObject({ gateway: "offline", overall: "offline", worker: "offline" });
    });
});
