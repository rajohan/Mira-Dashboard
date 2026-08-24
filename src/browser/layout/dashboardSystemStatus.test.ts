import { describe, expect, test } from "bun:test";

import type { SystemHealthDiagnostics } from "../../contracts/system.ts";
import {
    dashboardHealthSnapshotIsStale,
    projectDashboardSystemStatus,
} from "./dashboardSystemStatus.ts";

const observedAtMs = 1_800_000_000_000;
const diagnostics = Object.freeze({
    checkedAtMs: observedAtMs,
    checks: {
        application: { status: "ready" },
        database: { status: "ready" },
        frontend: { status: "ready" },
        release: { status: "verified" },
        worker: { status: "ready" },
    },
    dependencies: {
        gateway: {
            freshness: "fresh",
            phase: "connected",
            status: "observed",
        },
        sessions: {
            count: 1,
            observedAtMs,
            state: "fresh",
            truncated: false,
        },
    },
    queue: {
        claimingPaused: false,
        runs: { queued: 0, running: 0 },
        status: "observed",
        workers: {
            capacity: 1,
            drainingCount: 0,
            freshCount: 1,
            onlineCount: 1,
        },
    },
    status: "ready",
} as const satisfies SystemHealthDiagnostics);

describe("Dashboard system status projection", () => {
    test("marks only retained snapshots without a current observation stale", () => {
        expect(
            dashboardHealthSnapshotIsStale({
                fetchStatus: "idle",
                hasData: false,
                isError: true,
            })
        ).toBe(false);
        expect(
            dashboardHealthSnapshotIsStale({
                fetchStatus: "fetching",
                hasData: true,
                isError: false,
            })
        ).toBe(false);
        expect(
            dashboardHealthSnapshotIsStale({
                dataUpdatedAtMs: observedAtMs,
                fetchStatus: "fetching",
                hasData: true,
                isError: false,
                nowMs: observedAtMs + 45_001,
            })
        ).toBe(false);
        expect(
            dashboardHealthSnapshotIsStale({
                dataUpdatedAtMs: observedAtMs,
                fetchStatus: "idle",
                hasData: true,
                isError: false,
                nowMs: observedAtMs + 15_001,
            })
        ).toBe(false);
        expect(
            dashboardHealthSnapshotIsStale({
                dataUpdatedAtMs: observedAtMs,
                fetchStatus: "idle",
                hasData: true,
                isError: false,
                nowMs: observedAtMs + 45_001,
            })
        ).toBe(true);
        expect(
            dashboardHealthSnapshotIsStale({
                fetchStatus: "paused",
                hasData: true,
                isError: false,
            })
        ).toBe(true);
        expect(
            dashboardHealthSnapshotIsStale({
                fetchStatus: "idle",
                hasData: true,
                isError: true,
            })
        ).toBe(true);
        expect(
            dashboardHealthSnapshotIsStale({
                fetchStatus: "idle",
                hasData: true,
                isError: false,
            })
        ).toBe(false);
    });

    test("reports online only when every bounded observation is online", () => {
        expect(projectDashboardSystemStatus(diagnostics)).toEqual({
            backend: "online",
            gateway: "online",
            overall: "online",
            worker: "online",
        });
    });

    test("does not treat a missing diagnostic snapshot as healthy", () => {
        expect(projectDashboardSystemStatus(undefined)).toEqual({
            backend: "unavailable",
            gateway: "unavailable",
            overall: "unavailable",
            worker: "unavailable",
        });
    });

    test("marks retained healthy data stale after a failed background refresh", () => {
        expect(projectDashboardSystemStatus(diagnostics, true)).toEqual({
            backend: "stale",
            gateway: "stale",
            overall: "stale",
            worker: "stale",
        });
    });

    test("does not treat intentionally paused claiming as a worker outage", () => {
        expect(
            projectDashboardSystemStatus({
                ...diagnostics,
                queue: { ...diagnostics.queue, claimingPaused: true },
            })
        ).toMatchObject({ overall: "online", worker: "online" });
    });

    test("surfaces a degraded Gateway as attention", () => {
        expect(
            projectDashboardSystemStatus({
                ...diagnostics,
                dependencies: {
                    ...diagnostics.dependencies,
                    gateway: {
                        freshness: "stale",
                        phase: "degraded",
                        status: "observed",
                    },
                },
            })
        ).toMatchObject({ gateway: "offline", overall: "offline", worker: "online" });
    });

    test("keeps unavailable backend checks distinct from an observed offline process", () => {
        expect(
            projectDashboardSystemStatus({
                ...diagnostics,
                checks: {
                    ...diagnostics.checks,
                    database: { status: "unavailable" },
                },
                status: "not-ready",
            })
        ).toMatchObject({ backend: "unavailable", overall: "unavailable" });
        expect(
            projectDashboardSystemStatus({
                ...diagnostics,
                checks: {
                    ...diagnostics.checks,
                    application: { status: "not-ready" },
                },
                status: "not-ready",
            })
        ).toMatchObject({ backend: "offline", overall: "offline" });
    });
});
