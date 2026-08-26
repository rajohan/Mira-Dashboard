import { getTime, subMilliseconds, toDate } from "date-fns";
import * as v from "valibot";

import { jobWorkerFreshnessMs } from "../../../contracts/jobModel.ts";
import {
    systemCacheSnapshotMetricMaximum,
    systemOperationMetricSampleMaximum,
    type SystemApplicationMetrics,
} from "../../../contracts/system.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import type { DatabaseRuntimeObservation } from "../../database/runtime/databaseService.ts";
import type { RealtimeEventPumpMetrics } from "../../platform/realtime/eventPump.ts";
import { findCacheProviderDefinition } from "../cache/providerRegistry.ts";
import type { CacheRepository } from "../cache/repository.ts";
import type { ChatRepository } from "../chat/repository.ts";
import type { GatewayConnectionService } from "../gatewayConnection/service.ts";
import type { JobHealthStateReader, JobRepositoryReader } from "../jobs/repository.ts";

type ApplicationMetricsWithoutHttp = Omit<SystemApplicationMetrics, "http">;
type ApplicationMetricComponent =
    ApplicationMetricsWithoutHttp[keyof ApplicationMetricsWithoutHttp];

/** One independently contained application-metrics collection. */
export type SystemApplicationMetricsReader = () => Promise<ApplicationMetricsWithoutHttp>;

export interface SystemApplicationMetricsReaderDependencies {
    readonly cacheRepository: Pick<CacheRepository, "readStatus">;
    readonly chatReader?: Pick<ChatRepository, "readMetrics">;
    readonly databaseDiagnostics: () => Promise<DatabaseRuntimeObservation>;
    readonly gatewayConnectionService: Pick<GatewayConnectionService, "get">;
    readonly jobReader: JobHealthStateReader &
        Pick<JobRepositoryReader, "listDueSchedules" | "listRuns">;
    readonly nowMs?: () => number;
    readonly realtimeMetrics: () => Promise<Readonly<RealtimeEventPumpMetrics>>;
}

const metricsClockSchema = timestampMillisecondsSchema(
    "Application metrics clock is invalid"
);

function safeInteger(value: number, field: string): number {
    const integer = Math.round(value);
    if (!Number.isSafeInteger(integer) || integer < 0) {
        throw new RangeError(`Application metrics ${field} is outside its budget`);
    }
    return integer;
}

function saturatedSum(values: readonly number[]): number {
    let total = 0;
    for (const value of values) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError("Application metrics count is invalid");
        }
        total = Math.min(Number.MAX_SAFE_INTEGER, total + value);
    }
    return total;
}

async function contained<T extends ApplicationMetricComponent>(
    read: () => T | Promise<T>
): Promise<T | { readonly state: "unavailable" }> {
    try {
        return await read();
    } catch {
        return { state: "unavailable" };
    }
}

async function readWebMetrics(): Promise<SystemApplicationMetrics["web"]> {
    const startedAtMs = performance.now();
    await Bun.sleep(0);
    const memory = process.memoryUsage();
    const heapUsedBytes = safeInteger(memory.heapUsed, "heap used");
    const heapTotalBytes = Math.max(
        heapUsedBytes,
        safeInteger(memory.heapTotal, "heap total")
    );
    return {
        eventLoopDelayMs: safeInteger(
            Math.max(0, performance.now() - startedAtMs),
            "event-loop delay"
        ),
        externalBytes: safeInteger(memory.external, "external memory"),
        heapTotalBytes,
        heapUsedBytes,
        rssBytes: safeInteger(memory.rss, "RSS"),
        state: "observed",
        uptimeSeconds: safeInteger(performance.now() / 1000, "web uptime"),
    };
}

function readOperationMetrics(
    dependencies: SystemApplicationMetricsReaderDependencies
): SystemApplicationMetrics["operations"] {
    const runs = dependencies.jobReader
        .listRuns({ limit: systemOperationMetricSampleMaximum })
        .slice(0, systemOperationMetricSampleMaximum);
    const succeededRuns = runs.filter(({ state }) => state === "succeeded").length;
    const failedRuns = runs.filter(({ state }) =>
        ["cancelled", "failed", "timed-out"].includes(state)
    ).length;
    const activeRuns = runs.length - succeededRuns - failedRuns;
    const durations = runs.flatMap((run) => {
        if (run.finishedAt === null || run.firstStartedAt === null) return [];
        return [
            safeInteger(
                Math.max(0, getTime(run.finishedAt) - getTime(run.firstStartedAt)),
                "operation duration"
            ),
        ];
    });
    return {
        activeRuns,
        averageDurationMs:
            durations.length === 0
                ? 0
                : safeInteger(
                      saturatedSum(durations) / durations.length,
                      "average operation duration"
                  ),
        failedRuns,
        maximumDurationMs: durations.length === 0 ? 0 : Math.max(...durations),
        sampledRuns: runs.length,
        state: "observed",
        succeededRuns,
    };
}

function readChatMetrics(
    dependencies: SystemApplicationMetricsReaderDependencies
): SystemApplicationMetrics["chat"] {
    if (dependencies.chatReader === undefined) {
        throw new Error("Chat metrics reader is unavailable");
    }
    return {
        ...dependencies.chatReader.readMetrics(),
        state: "observed",
    };
}

function readJobsMetrics(
    dependencies: SystemApplicationMetricsReaderDependencies,
    nowMs: number
): SystemApplicationMetrics["jobs"] {
    const queue = dependencies.jobReader.readHealthState({
        minimumHeartbeatAt: subMilliseconds(toDate(nowMs), jobWorkerFreshnessMs),
    });
    const oldestDue = dependencies.jobReader.listDueSchedules({
        at: toDate(nowMs),
        limit: 1,
    })[0];
    return {
        claimingPaused: queue.control.claimingPaused,
        queuedRuns: queue.queuedRunCount,
        runningRuns: queue.runningRunCount,
        scheduleLagMs:
            oldestDue?.nextRunAt === null || oldestDue?.nextRunAt === undefined
                ? 0
                : safeInteger(
                      Math.max(0, nowMs - getTime(oldestDue.nextRunAt)),
                      "schedule lag"
                  ),
        state: "observed",
        workers: {
            capacity: queue.workers.capacity,
            draining: queue.workers.drainingCount,
            online: queue.workers.onlineCount,
        },
    };
}

async function readSqliteMetrics(
    dependencies: SystemApplicationMetricsReaderDependencies
): Promise<SystemApplicationMetrics["sqlite"]> {
    const startedAtMs = performance.now();
    const diagnostics = await dependencies.databaseDiagnostics();
    return {
        freeBytes: diagnostics.sqlite.freeBytes,
        freePages: diagnostics.sqlite.freePages,
        freePercent: diagnostics.sqlite.freePercent,
        pageCount: diagnostics.sqlite.pageCount,
        readLatencyMs: safeInteger(
            Math.max(0, performance.now() - startedAtMs),
            "SQLite read latency"
        ),
        state: "observed",
        storageBytes: diagnostics.sqlite.storageBytes,
    };
}

function readGatewayMetrics(
    dependencies: SystemApplicationMetricsReaderDependencies
): SystemApplicationMetrics["gateway"] {
    const gateway = dependencies.gatewayConnectionService.get();
    return {
        checkedAtMs: gateway.checkedAtMs,
        freshness: gateway.freshness,
        ...(gateway.lastActivityAtMs === undefined
            ? {}
            : { lastActivityAtMs: gateway.lastActivityAtMs }),
        phase: gateway.phase,
        reconnectAttempt: gateway.reconnectAttempt,
        state: "observed",
    };
}

async function readRealtimeMetrics(
    dependencies: SystemApplicationMetricsReaderDependencies
): Promise<SystemApplicationMetrics["realtime"]> {
    const metrics = await dependencies.realtimeMetrics();
    return {
        activeSubscribers: metrics.activeSubscribers,
        droppedSlowSubscribers: metrics.droppedSlowSubscribers,
        forcedResyncs: metrics.forcedResyncs,
        pollFailures: metrics.pollFailures,
        polls: metrics.polls,
        ...(metrics.retainedEventsSample === null
            ? {}
            : { retainedEvents: metrics.retainedEventsSample.count }),
        state: "observed",
        subscriberCapacityRejections: metrics.subscriberCapacityRejections,
        subscriptionReadFailures: metrics.subscriptionReadFailures,
        wakeups: metrics.wakeups,
    };
}

function readCacheMetrics(
    dependencies: SystemApplicationMetricsReaderDependencies,
    nowMs: number
): SystemApplicationMetrics["cache"] {
    const snapshot = dependencies.cacheRepository.readStatus();
    const entries = snapshot.entries;
    const snapshotFreshness = (expiresAt: Date | null): "fresh" | "missing" | "stale" => {
        if (expiresAt === null) return "missing";
        return getTime(expiresAt) <= nowMs ? "stale" : "fresh";
    };
    return {
        entryCount: snapshot.totalCount,
        failedEntryCount: entries.filter(
            ({ lastAttemptStatus }) => lastAttemptStatus === "failed"
        ).length,
        ...(entries.length === 0
            ? {}
            : {
                  latestAttemptAtMs: Math.max(
                      ...entries.map(({ lastAttemptAt }) => getTime(lastAttemptAt))
                  ),
              }),
        maximumAttemptDurationMs:
            entries.length === 0
                ? 0
                : Math.max(
                      ...entries.map(({ lastAttemptDurationMs }) => lastAttemptDurationMs)
                  ),
        missingEntryCount: entries.filter(({ expiresAt }) => expiresAt === null).length,
        refreshAttemptCount: saturatedSum(
            entries.map(({ lastAttemptNumber }) => lastAttemptNumber)
        ),
        snapshots: entries
            .filter(({ key }) => findCacheProviderDefinition(key) !== undefined)
            .toSorted((left, right) => left.key.localeCompare(right.key))
            .slice(0, systemCacheSnapshotMetricMaximum)
            .map((entry) => ({
                attemptCount: entry.lastAttemptNumber,
                consecutiveFailures: entry.consecutiveFailures,
                freshness: snapshotFreshness(entry.expiresAt),
                key: entry.key,
                lastAttemptDurationMs: entry.lastAttemptDurationMs,
                lastAttemptStatus: entry.lastAttemptStatus,
            })),
        staleEntryCount: entries.filter(
            ({ expiresAt }) => expiresAt !== null && getTime(expiresAt) <= nowMs
        ).length,
        state: "observed",
    };
}

/**
 * Creates one reader whose component failures are represented independently.
 * No raw failures, database paths, worker identities, or cache payloads escape.
 * @param dependencies Reviewed process and repository observation boundaries.
 * @returns One independently contained application-metrics reader.
 */
export function createSystemApplicationMetricsReader(
    dependencies: SystemApplicationMetricsReaderDependencies
): SystemApplicationMetricsReader {
    const now = dependencies.nowMs ?? Date.now;
    return async () => {
        const nowMs = v.parse(metricsClockSchema, now());
        const [cache, chat, gateway, jobs, operations, realtime, sqlite, web] =
            await Promise.all([
                contained(() => readCacheMetrics(dependencies, nowMs)),
                contained(() => readChatMetrics(dependencies)),
                contained(() => readGatewayMetrics(dependencies)),
                contained(() => readJobsMetrics(dependencies, nowMs)),
                contained(() => readOperationMetrics(dependencies)),
                contained(() => readRealtimeMetrics(dependencies)),
                contained(() => readSqliteMetrics(dependencies)),
                contained(readWebMetrics),
            ]);
        return {
            cache,
            chat,
            gateway,
            jobs,
            operations,
            realtime,
            sqlite,
            web,
        } satisfies ApplicationMetricsWithoutHttp;
    };
}
