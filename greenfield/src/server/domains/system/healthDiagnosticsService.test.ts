import { describe, expect, test } from "bun:test";

import { jobWorkerFreshnessMs } from "../../../contracts/jobModel.ts";
import type { ReadinessState } from "../../platform/readiness/readinessState.ts";
import type { GatewayConnectionService } from "../gatewayConnection/service.ts";
import type { GatewaySessionsHeartbeatReader } from "../gatewaySessions/service.ts";
import type {
    JobHealthState,
    JobHealthStateReader,
    ReadJobHealthStateInput,
} from "../jobs/repository.ts";
import {
    createSystemHealthDiagnosticsService,
    type SystemHealthDiagnosticsServiceDependencies,
} from "./healthDiagnosticsService.ts";

const checkedAtMs = 1_800_000_000_000;
const releaseId = "a".repeat(40);

function healthState(overrides: Partial<JobHealthState> = {}): JobHealthState {
    return {
        control: {
            claimingPaused: false,
            id: 1,
            updatedAt: new Date(0),
            updatedById: null,
            updatedByKind: null,
            version: 1,
        },
        oldestQueuedAt: new Date(checkedAtMs - 1000),
        queuedRunCount: 1,
        runningRunCount: 1,
        workers: {
            capacity: 2,
            drainingCount: 0,
            exactReleaseOnline: true,
            freshCount: 1,
            onlineCount: 1,
        },
        ...overrides,
    };
}

const connectedGateway = Object.freeze({
    get: () => ({
        checkedAtMs,
        connectedAtMs: checkedAtMs - 1000,
        connectionGeneration: 1,
        freshness: "fresh" as const,
        lastActivityAtMs: checkedAtMs,
        phase: "connected" as const,
        reconnectAttempt: 0,
    }),
} satisfies Pick<GatewayConnectionService, "get">);

const freshSessions = Object.freeze({
    readHeartbeatProjection: () => ({
        count: 2,
        observedAtMs: checkedAtMs,
        state: "fresh" as const,
        truncated: false,
    }),
} satisfies GatewaySessionsHeartbeatReader);

function createReader(
    state: JobHealthState,
    onRead?: (input: ReadJobHealthStateInput) => void
): JobHealthStateReader {
    return Object.freeze({
        readHealthState(input: ReadJobHealthStateInput) {
            onRead?.(input);
            return state;
        },
    });
}

function readyDependencies(
    overrides: Partial<SystemHealthDiagnosticsServiceDependencies> = {}
): SystemHealthDiagnosticsServiceDependencies {
    return {
        expectedWorkerReleaseId: releaseId,
        frontendReady: true,
        gatewayConnectionService: connectedGateway,
        gatewaySessionsReader: freshSessions,
        jobHealthReader: createReader(healthState()),
        nowMs: () => checkedAtMs,
        readiness: { isReady: () => true },
        ...overrides,
    };
}

describe("system health diagnostics service", () => {
    test("projects one ready identity-free snapshot at the exact heartbeat boundary", () => {
        let observedInput: ReadJobHealthStateInput | undefined;
        const service = createSystemHealthDiagnosticsService(
            readyDependencies({
                jobHealthReader: createReader(healthState(), (input) => {
                    observedInput = input;
                }),
            })
        );

        const diagnostics = service.read();

        expect(observedInput).toEqual({
            expectedReleaseId: releaseId,
            minimumHeartbeatAt: new Date(checkedAtMs - jobWorkerFreshnessMs),
        });
        expect(diagnostics).toMatchObject({
            checkedAtMs,
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
                sessions: { count: 2, state: "fresh" },
            },
            queue: {
                claimingPaused: false,
                runs: { queued: 1, running: 1 },
                status: "observed",
                workers: {
                    capacity: 2,
                    drainingCount: 0,
                    freshCount: 1,
                    onlineCount: 1,
                },
            },
            status: "ready",
        });
        expect(JSON.stringify(diagnostics)).not.toContain(releaseId);
        expect(Object.isFrozen(service)).toBe(true);
    });

    test("bounds the response after reads while retaining the start-time worker cutoff", () => {
        let clockReads = 0;
        let observedInput: ReadJobHealthStateInput | undefined;
        const service = createSystemHealthDiagnosticsService(
            readyDependencies({
                jobHealthReader: createReader(
                    healthState({ oldestQueuedAt: new Date(checkedAtMs + 1) }),
                    (input) => {
                        observedInput = input;
                    }
                ),
                nowMs: () => checkedAtMs + Math.min(clockReads++, 1),
            })
        );

        const diagnostics = service.read();

        expect(observedInput).toEqual({
            expectedReleaseId: releaseId,
            minimumHeartbeatAt: new Date(checkedAtMs - jobWorkerFreshnessMs),
        });
        expect(diagnostics).toMatchObject({
            checkedAtMs: checkedAtMs + 1,
            queue: {
                oldestQueuedAtMs: checkedAtMs + 1,
                status: "observed",
            },
            status: "ready",
        });
    });

    test("keeps Gateway degradation, stale sessions, and paused claiming non-gating", () => {
        const diagnostics = createSystemHealthDiagnosticsService(
            readyDependencies({
                gatewayConnectionService: {
                    get: () => ({
                        checkedAtMs,
                        connectionGeneration: 2,
                        freshness: "stale",
                        lastDisconnectedAtMs: checkedAtMs - 2000,
                        phase: "degraded",
                        reconnectAttempt: 2,
                    }),
                },
                jobHealthReader: createReader(
                    healthState({
                        control: {
                            claimingPaused: true,
                            id: 1,
                            updatedAt: new Date(checkedAtMs - 1000),
                            updatedById: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                            updatedByKind: "user",
                            version: 2,
                        },
                    })
                ),
            })
        ).read();

        expect(diagnostics.status).toBe("ready");
        expect(diagnostics.dependencies.gateway).toEqual({
            freshness: "stale",
            phase: "degraded",
            status: "observed",
        });
        expect(diagnostics.dependencies.sessions).toEqual({
            count: 2,
            observedAtMs: checkedAtMs,
            staleSinceMs: checkedAtMs,
            state: "last-known-good",
            truncated: false,
        });
        expect(diagnostics.queue).toMatchObject({ claimingPaused: true });
    });

    test("keeps each readiness blocker explicit in the aggregate", () => {
        const applicationUnavailable = createSystemHealthDiagnosticsService(
            readyDependencies({ readiness: { isReady: () => false } })
        ).read();
        const frontendUnavailable = createSystemHealthDiagnosticsService(
            readyDependencies({ frontendReady: false })
        ).read();
        const workerMismatch = createSystemHealthDiagnosticsService(
            readyDependencies({
                jobHealthReader: createReader(
                    healthState({
                        workers: {
                            capacity: 2,
                            drainingCount: 1,
                            exactReleaseOnline: false,
                            freshCount: 1,
                            onlineCount: 0,
                        },
                    })
                ),
            })
        ).read();
        const releaseUnavailable = createSystemHealthDiagnosticsService({
            frontendReady: true,
            gatewayConnectionService: connectedGateway,
            gatewaySessionsReader: freshSessions,
            jobHealthReader: createReader(healthState()),
            nowMs: () => checkedAtMs,
            readiness: { isReady: () => true },
        }).read();
        const invalidQueueProjection = createSystemHealthDiagnosticsService(
            readyDependencies({
                jobHealthReader: createReader(healthState({ queuedRunCount: 0 })),
            })
        ).read();
        const futureQueueProjection = createSystemHealthDiagnosticsService(
            readyDependencies({
                jobHealthReader: createReader(
                    healthState({ oldestQueuedAt: new Date(checkedAtMs + 1) })
                ),
            })
        ).read();

        expect(applicationUnavailable).toMatchObject({
            checks: { application: { status: "not-ready" } },
            status: "not-ready",
        });
        expect(frontendUnavailable).toMatchObject({
            checks: { frontend: { status: "unavailable" } },
            status: "not-ready",
        });
        expect(workerMismatch).toMatchObject({
            checks: { worker: { status: "not-ready" } },
            status: "not-ready",
        });
        expect(releaseUnavailable).toMatchObject({
            checks: {
                release: { status: "unavailable" },
                worker: { status: "unavailable" },
            },
            status: "not-ready",
        });
        expect(invalidQueueProjection).toMatchObject({
            checks: {
                database: { status: "unavailable" },
                worker: { status: "unavailable" },
            },
            queue: { status: "unavailable" },
            status: "not-ready",
        });
        expect(futureQueueProjection).toMatchObject({
            checks: {
                database: { status: "unavailable" },
                worker: { status: "unavailable" },
            },
            queue: { status: "unavailable" },
            status: "not-ready",
        });
    });

    test("degrades component reader failures without exposing their diagnostics", () => {
        const secret = "private dependency diagnostic";
        const throwingReadiness: ReadinessState = { isReady: () => true };
        const diagnostics = createSystemHealthDiagnosticsService({
            expectedWorkerReleaseId: releaseId,
            frontendReady: true,
            gatewayConnectionService: {
                get: () => {
                    throw new Error(secret);
                },
            },
            gatewaySessionsReader: {
                readHeartbeatProjection: () => {
                    throw new Error(secret);
                },
            },
            jobHealthReader: {
                readHealthState: () => {
                    throw new Error(secret);
                },
            },
            nowMs: () => checkedAtMs,
            readiness: throwingReadiness,
        }).read();

        expect(diagnostics).toMatchObject({
            checks: {
                database: { status: "unavailable" },
                worker: { status: "unavailable" },
            },
            dependencies: {
                gateway: { status: "unavailable" },
                sessions: { state: "unavailable" },
            },
            queue: { status: "unavailable" },
            status: "not-ready",
        });
        expect(JSON.stringify(diagnostics)).not.toContain(secret);
    });
});
