import * as v from "valibot";

import { jobWorkerFreshnessMs } from "../../../contracts/jobModel.ts";
import {
    type SystemHealthDiagnostics,
    systemHealthDiagnosticsGatewaySchema,
    systemHealthDiagnosticsQueueSchema,
    systemHealthDiagnosticsSchema,
    systemHealthDiagnosticsSessionsSchema,
} from "../../../contracts/system.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";
import type { ReadinessState } from "../../platform/readiness/readinessState.ts";
import type { GatewayConnectionService } from "../gatewayConnection/service.ts";
import type { GatewaySessionsHeartbeatReader } from "../gatewaySessions/service.ts";
import type { JobHealthState, JobHealthStateReader } from "../jobs/repository.ts";

type GatewayDiagnostics = SystemHealthDiagnostics["dependencies"]["gateway"];
type SessionsDiagnostics = SystemHealthDiagnostics["dependencies"]["sessions"];
type QueueDiagnostics = SystemHealthDiagnostics["queue"];
type WorkerCheck = SystemHealthDiagnostics["checks"]["worker"];

/** Request-safe detailed health reader used by the session-only system procedure. */
export interface SystemHealthDiagnosticsService {
    read(): SystemHealthDiagnostics;
}

export interface SystemHealthDiagnosticsServiceDependencies {
    readonly expectedWorkerReleaseId?: string;
    readonly frontendReady: boolean;
    readonly gatewayConnectionService: Pick<GatewayConnectionService, "get">;
    readonly gatewaySessionsReader: GatewaySessionsHeartbeatReader;
    readonly jobHealthReader: JobHealthStateReader;
    readonly nowMs?: () => number;
    readonly readiness: ReadinessState;
}

const healthDiagnosticsClockSchema = timestampMillisecondsSchema(
    "System health diagnostics clock is invalid"
);

function readGatewayDiagnostics(
    service: Pick<GatewayConnectionService, "get">
): GatewayDiagnostics {
    try {
        const snapshot = service.get();
        return v.parse(systemHealthDiagnosticsGatewaySchema, {
            freshness: snapshot.freshness,
            phase: snapshot.phase,
            status: "observed",
        });
    } catch {
        return { status: "unavailable" };
    }
}

function readSessionsProjection(
    reader: GatewaySessionsHeartbeatReader
): SessionsDiagnostics {
    try {
        return v.parse(
            systemHealthDiagnosticsSessionsSchema,
            reader.readHeartbeatProjection()
        );
    } catch {
        return { state: "unavailable" };
    }
}

function projectSessionsDiagnostics(
    sessions: SessionsDiagnostics,
    gateway: GatewayDiagnostics,
    checkedAtMs: number
): SessionsDiagnostics {
    try {
        if (
            sessions.state !== "unavailable" &&
            (sessions.observedAtMs > checkedAtMs ||
                (sessions.state === "last-known-good" &&
                    sessions.staleSinceMs > checkedAtMs))
        ) {
            return { state: "unavailable" };
        }
        if (
            sessions.state === "fresh" &&
            (gateway.status === "unavailable" || gateway.freshness !== "fresh")
        ) {
            return v.parse(systemHealthDiagnosticsSessionsSchema, {
                ...sessions,
                staleSinceMs: checkedAtMs,
                state: "last-known-good",
            });
        }
        return sessions;
    } catch {
        return { state: "unavailable" };
    }
}

function readHealthState(
    reader: JobHealthStateReader,
    startedAtMs: number,
    expectedWorkerReleaseId: string | undefined
): JobHealthState | undefined {
    try {
        return reader.readHealthState({
            ...(expectedWorkerReleaseId === undefined
                ? {}
                : { expectedReleaseId: expectedWorkerReleaseId }),
            minimumHeartbeatAt: new Date(Math.max(0, startedAtMs - jobWorkerFreshnessMs)),
        });
    } catch {
        return undefined;
    }
}

function projectQueue(
    queue: JobHealthState | undefined,
    checkedAtMs: number
): QueueDiagnostics {
    if (queue === undefined) return { status: "unavailable" };
    try {
        if (
            queue.oldestQueuedAt !== undefined &&
            queue.oldestQueuedAt.getTime() > checkedAtMs
        ) {
            return { status: "unavailable" };
        }
        return v.parse(systemHealthDiagnosticsQueueSchema, {
            claimingPaused: queue.control.claimingPaused,
            ...(queue.oldestQueuedAt === undefined
                ? {}
                : { oldestQueuedAtMs: queue.oldestQueuedAt.getTime() }),
            runs: {
                queued: queue.queuedRunCount,
                running: queue.runningRunCount,
            },
            status: "observed",
            workers: {
                capacity: queue.workers.capacity,
                drainingCount: queue.workers.drainingCount,
                freshCount: queue.workers.freshCount,
                onlineCount: queue.workers.onlineCount,
            },
        });
    } catch {
        return { status: "unavailable" };
    }
}

function readWorkerCheck(
    queue: JobHealthState | undefined,
    expectedWorkerReleaseId: string | undefined
): WorkerCheck {
    if (queue === undefined || expectedWorkerReleaseId === undefined) {
        return { status: "unavailable" };
    }
    if (queue.workers.exactReleaseOnline) {
        return { status: "ready" };
    }
    return { status: "not-ready" };
}

/**
 * Projects live process, dependency, and queue state onto one bounded identity-free snapshot.
 * Expected dependency failures are represented per component so diagnostics remain readable.
 * @param dependencies Process-owned state readers and verified composition facts.
 * @returns An immutable synchronous diagnostics service.
 */
export function createSystemHealthDiagnosticsService(
    dependencies: SystemHealthDiagnosticsServiceDependencies
): SystemHealthDiagnosticsService {
    const nowMs = dependencies.nowMs ?? Date.now;
    const expectedWorkerReleaseId =
        dependencies.expectedWorkerReleaseId === undefined
            ? undefined
            : v.parse(
                  fullCommitShaSchema("Expected worker release id is invalid"),
                  dependencies.expectedWorkerReleaseId
              );

    return Object.freeze({
        read(): SystemHealthDiagnostics {
            const startedAtMs = v.parse(healthDiagnosticsClockSchema, nowMs());
            const queueState = readHealthState(
                dependencies.jobHealthReader,
                startedAtMs,
                expectedWorkerReleaseId
            );
            const gateway = readGatewayDiagnostics(dependencies.gatewayConnectionService);
            const sessionsProjection = readSessionsProjection(
                dependencies.gatewaySessionsReader
            );
            const checkedAtMs = Math.max(
                startedAtMs,
                v.parse(healthDiagnosticsClockSchema, nowMs())
            );
            const queue = projectQueue(queueState, checkedAtMs);
            const checks = {
                application: {
                    status: dependencies.readiness.isReady()
                        ? ("ready" as const)
                        : ("not-ready" as const),
                },
                database: {
                    status:
                        queue.status === "unavailable"
                            ? ("unavailable" as const)
                            : ("ready" as const),
                },
                frontend: {
                    status: dependencies.frontendReady
                        ? ("ready" as const)
                        : ("unavailable" as const),
                },
                release: {
                    status:
                        expectedWorkerReleaseId === undefined
                            ? ("unavailable" as const)
                            : ("verified" as const),
                },
                worker:
                    queue.status === "unavailable"
                        ? ({ status: "unavailable" } as const)
                        : readWorkerCheck(queueState, expectedWorkerReleaseId),
            };
            const ready =
                checks.application.status === "ready" &&
                checks.database.status === "ready" &&
                checks.frontend.status === "ready" &&
                checks.release.status === "verified" &&
                checks.worker.status === "ready";
            return v.parse(systemHealthDiagnosticsSchema, {
                checkedAtMs,
                checks,
                dependencies: {
                    gateway,
                    sessions: projectSessionsDiagnostics(
                        sessionsProjection,
                        gateway,
                        checkedAtMs
                    ),
                },
                queue,
                status: ready ? "ready" : "not-ready",
            });
        },
    });
}
