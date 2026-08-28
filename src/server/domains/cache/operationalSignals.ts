import { getTime } from "date-fns";
import * as v from "valibot";

import type { KopiaBackupStatus, WalgBackupStatus } from "../../../contracts/backups.ts";
import {
    type CacheHeartbeatOperationalSignals,
    cacheHeartbeatBackupSignalSchema,
    cacheHeartbeatGitSignalSchema,
    cacheHeartbeatOperationalSignalsSchema,
    cacheHeartbeatQuotaSignalSchema,
    cacheHeartbeatWeatherSignalSchema,
} from "../../../contracts/cache.ts";
import type { DatabaseOverview } from "../../../contracts/database.ts";
import type { DockerOverview } from "../../../contracts/docker.ts";
import {
    gitWorkspaceCacheKey,
    gitWorkspaceCachePayloadSchema,
    gitWorkspaceCacheSchemaId,
    gitWorkspaceCacheSource,
    gitWorkspaceCacheTtlMs,
} from "../../../contracts/gitWorkspace.ts";
import type { LogMaintenanceStatusOutput } from "../../../contracts/logs.ts";
import {
    quotaCacheKey,
    quotaCachePayloadSchema,
    quotaCacheSchemaId,
    quotaCacheSource,
    quotaCacheTtlMs,
} from "../../../contracts/quota.ts";
import type { SystemMetrics } from "../../../contracts/system.ts";
import {
    weatherCacheKey,
    weatherCachePayloadSchema,
    weatherCacheSchemaId,
    weatherCacheSource,
    weatherCacheTtlMs,
} from "../../../contracts/weather.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { DatabaseObservabilityService } from "../database/service.ts";
import type { DockerService } from "../docker/service.ts";
import { gitWorkspaceSyncJobScheduleId } from "../jobs/actionRegistry.ts";
import { toJobRunResult } from "../jobs/records.ts";
import type { JobRepository } from "../jobs/repository.ts";
import type { LogsService } from "../logs/service.ts";
import type { SystemMetricsRuntimeService } from "../system/systemMetricsService.ts";
import type { CacheEntryRecord, CacheRepository } from "./repository.ts";

type OperationalSignalsReader = () =>
    | CacheHeartbeatOperationalSignals
    | Promise<CacheHeartbeatOperationalSignals>;
type GitSignal = CacheHeartbeatOperationalSignals["git"];
type QuotaSignal = CacheHeartbeatOperationalSignals["quota"];
type WeatherSignal = CacheHeartbeatOperationalSignals["weather"];
type AvailableSignal<T> = Exclude<T, { readonly state: "unavailable" }>;

/** Stable seams for providers whose final cache modules are composed independently. */
export interface CacheHeartbeatOperationalSignalSeams {
    readonly readKopiaBackup?: () =>
        | CacheHeartbeatOperationalSignals["backups"]["kopia"]
        | Promise<CacheHeartbeatOperationalSignals["backups"]["kopia"]>;
    readonly readWalgBackup?: () =>
        | CacheHeartbeatOperationalSignals["backups"]["walg"]
        | Promise<CacheHeartbeatOperationalSignals["backups"]["walg"]>;
    readonly readGit?: () => GitSignal | Promise<GitSignal>;
    readonly readQuota?: () => QuotaSignal | Promise<QuotaSignal>;
    readonly readWeather?: () => WeatherSignal | Promise<WeatherSignal>;
}

export interface CacheHeartbeatOperationalSignalsDependencies extends CacheHeartbeatOperationalSignalSeams {
    readonly databaseService: Pick<DatabaseObservabilityService, "read">;
    readonly dockerService?: Pick<DockerService, "overview">;
    readonly logsService?: Pick<LogsService, "maintenanceStatus">;
    readonly nowMs?: () => number;
    readonly systemMetricsService: Pick<SystemMetricsRuntimeService, "read">;
}

const unavailable = Object.freeze({ state: "unavailable" as const });

function cacheSignal<TPayload, TCondition extends string>(input: {
    readonly condition: (payload: TPayload) => TCondition;
    readonly key: string;
    readonly nowMs: number;
    readonly payloadSchema: v.GenericSchema<unknown, TPayload>;
    readonly record: CacheEntryRecord | undefined;
    readonly schemaId: string;
    readonly source: string;
    readonly ttlMs: number;
}):
    | { readonly state: "unavailable" }
    | {
          readonly condition: TCondition;
          readonly observedAtMs: number;
          readonly state: "fresh";
      }
    | {
          readonly condition: TCondition;
          readonly observedAtMs: number;
          readonly staleSinceMs: number;
          readonly state: "last-known-good";
      } {
    const record = input.record;
    if (
        record === undefined ||
        record.key !== input.key ||
        record.payloadJson === null ||
        record.schemaId !== input.schemaId ||
        record.source !== input.source ||
        record.lastSuccessAt === null ||
        record.expiresAt === null
    ) {
        return unavailable;
    }
    try {
        const payload = v.parse(input.payloadSchema, parseJsonText(record.payloadJson));
        const observedAtMs = v.parse(
            v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
            Reflect.get(payload as object, "observedAtMs")
        );
        const lastSuccessAtMs = getTime(record.lastSuccessAt);
        const expiresAtMs = getTime(record.expiresAt);
        if (
            observedAtMs > lastSuccessAtMs ||
            expiresAtMs !== lastSuccessAtMs + input.ttlMs ||
            lastSuccessAtMs > input.nowMs
        ) {
            return unavailable;
        }
        const condition = input.condition(payload);
        if (
            record.lastAttemptStatus === "succeeded" &&
            getTime(record.lastAttemptAt) === lastSuccessAtMs &&
            expiresAtMs > input.nowMs
        ) {
            return { condition, observedAtMs, state: "fresh" };
        }
        const staleSinceMs =
            record.lastAttemptStatus === "failed"
                ? getTime(record.lastAttemptAt)
                : expiresAtMs;
        return {
            condition,
            observedAtMs,
            staleSinceMs: Math.max(observedAtMs, staleSinceMs),
            state: "last-known-good",
        };
    } catch {
        return unavailable;
    }
}

/**
 * Creates exact cache-entry readers for Git, quota, and weather heartbeat leaves.
 * @param repository Exact cache-entry read boundary.
 * @param now Read clock used to derive freshness.
 * @returns Three independent payload-free heartbeat readers.
 */
export function createCacheHeartbeatOverviewSignalReaders(
    repository: Pick<CacheRepository, "findEntry">,
    now: () => number = Date.now,
    jobRepository?: Pick<JobRepository, "findLatestRunForSchedule">
): Required<
    Pick<CacheHeartbeatOperationalSignalSeams, "readGit" | "readQuota" | "readWeather">
> {
    return Object.freeze({
        readGit() {
            const nowMs = now();
            return cacheSignal({
                condition: (payload) => {
                    if (jobRepository === undefined) {
                        return payload.repositories.some(
                            ({ changedFileCount, detached, state }) =>
                                state !== "available" || detached || changedFileCount > 0
                        )
                            ? "attention"
                            : "clean";
                    }
                    const managedSourceNeedsAttention = payload.repositories
                        .filter(({ id }) => id !== "openclaw")
                        .some(
                            ({ changedFileCount, detached, state }) =>
                                state !== "available" || detached || changedFileCount > 0
                        );
                    const latestSync = jobRepository?.findLatestRunForSchedule(
                        gitWorkspaceSyncJobScheduleId
                    );
                    if (
                        managedSourceNeedsAttention ||
                        latestSync?.state !== "succeeded"
                    ) {
                        return "attention";
                    }
                    const result = toJobRunResult(latestSync);
                    return typeof result?.residualChangedFileCount === "number" &&
                        Number.isSafeInteger(result.residualChangedFileCount) &&
                        result.residualChangedFileCount === 0
                        ? "clean"
                        : "attention";
                },
                key: gitWorkspaceCacheKey,
                nowMs,
                payloadSchema: gitWorkspaceCachePayloadSchema,
                record: repository.findEntry(gitWorkspaceCacheKey),
                schemaId: gitWorkspaceCacheSchemaId,
                source: gitWorkspaceCacheSource,
                ttlMs: gitWorkspaceCacheTtlMs,
            });
        },
        readQuota() {
            const nowMs = now();
            return cacheSignal({
                condition: (payload) =>
                    payload.providers.some(
                        ({ remainingPercent, status, usedPercent, windows }) =>
                            status === "unavailable" ||
                            (remainingPercent !== undefined && remainingPercent <= 10) ||
                            (usedPercent !== undefined && usedPercent >= 90) ||
                            windows?.some(({ usedPercent: used }) => used >= 90) === true
                    )
                        ? "attention"
                        : "healthy",
                key: quotaCacheKey,
                nowMs,
                payloadSchema: quotaCachePayloadSchema,
                record: repository.findEntry(quotaCacheKey),
                schemaId: quotaCacheSchemaId,
                source: quotaCacheSource,
                ttlMs: quotaCacheTtlMs,
            });
        },
        readWeather() {
            const nowMs = now();
            return cacheSignal({
                condition: () => "available",
                key: weatherCacheKey,
                nowMs,
                payloadSchema: weatherCachePayloadSchema,
                record: repository.findEntry(weatherCacheKey),
                schemaId: weatherCacheSchemaId,
                source: weatherCacheSource,
                ttlMs: weatherCacheTtlMs,
            });
        },
    });
}

/**
 * Reduces a full backup status to one identity- and payload-free heartbeat leaf.
 * @param status Validated Kopia or WAL-G status.
 * @returns One fixed-condition heartbeat signal.
 */
export function cacheHeartbeatBackupSignalFromStatus(
    status: KopiaBackupStatus | WalgBackupStatus
): CacheHeartbeatOperationalSignals["backups"]["kopia"] {
    if (status.state === "unavailable") return unavailable;
    let condition: "attention" | "healthy" | "running" = "healthy";
    if (
        status.activity.state === "failed" ||
        status.activity.state === "needs-attention" ||
        !status.payload.healthy
    ) {
        condition = "attention";
    } else if (
        status.activity.state === "queued" ||
        status.activity.state === "running" ||
        !status.payload.providerIdle
    ) {
        condition = "running";
    }
    return status.state === "fresh"
        ? {
              condition,
              observedAtMs: status.payload.observedAtMs,
              state: "fresh",
          }
        : {
              condition,
              observedAtMs: status.payload.observedAtMs,
              staleSinceMs: status.staleSinceMs,
              state: "last-known-good",
          };
}

async function contained<T>(
    read: (() => T | Promise<T>) | undefined,
    fallback: T
): Promise<T> {
    if (read === undefined) return fallback;
    try {
        return await read();
    } catch {
        return fallback;
    }
}

async function containedProviderSignal<T>(
    schema: v.GenericSchema<unknown, T>,
    read: (() => T | Promise<T>) | undefined
): Promise<T | { readonly state: "unavailable" }> {
    if (read === undefined) return unavailable;
    try {
        return v.parse(schema, await read());
    } catch {
        return unavailable;
    }
}

function sourceSignal<TCondition extends string>(
    source: {
        readonly observedAtMs: number;
        readonly staleSinceMs?: number;
        readonly state: "fresh" | "last-known-good";
    },
    condition: TCondition
):
    | {
          readonly condition: TCondition;
          readonly observedAtMs: number;
          readonly state: "fresh";
      }
    | {
          readonly condition: TCondition;
          readonly observedAtMs: number;
          readonly staleSinceMs: number;
          readonly state: "last-known-good";
      } {
    return source.state === "fresh"
        ? { condition, observedAtMs: source.observedAtMs, state: "fresh" }
        : {
              condition,
              observedAtMs: source.observedAtMs,
              staleSinceMs: source.staleSinceMs!,
              state: "last-known-good",
          };
}

function projectPostgresqlMaintenance(
    database: DatabaseOverview
): CacheHeartbeatOperationalSignals["database"]["postgresqlMaintenance"] {
    const source = database.postgresql;
    if (source.state === "unavailable") return unavailable;
    const maintenanceStatus = source.summary.maintenance.status;
    let condition: "attention" | "healthy" | "not-assessed" = "not-assessed";
    if (maintenanceStatus === "review") condition = "attention";
    if (maintenanceStatus === "healthy") condition = "healthy";
    return sourceSignal(source, condition);
}

function projectSqliteMaintenance(
    database: DatabaseOverview
): CacheHeartbeatOperationalSignals["database"]["sqliteMaintenance"] {
    const sqlite = database.sqlite;
    if (sqlite.state === "unavailable") return unavailable;
    const maintenance = sqlite.lifecycle.maintenance;
    if (maintenance.state === "unavailable") return unavailable;
    const latestRun = maintenance.runs[0];
    let condition: "attention" | "healthy" | "not-assessed" | "running" = "healthy";
    if (maintenance.runs.some(({ state }) => state === "queued" || state === "running")) {
        condition = "running";
    } else if (latestRun !== undefined && latestRun.state !== "succeeded") {
        condition = "attention";
    } else if (maintenance.latestSuccessfulAtMs === undefined) {
        condition = "not-assessed";
    }
    if (sqlite.state === "fresh" && maintenance.state === "available") {
        return {
            condition,
            observedAtMs: maintenance.observedAtMs,
            state: "fresh",
        };
    }
    return {
        condition,
        observedAtMs: maintenance.observedAtMs,
        staleSinceMs: Math.max(
            maintenance.observedAtMs,
            sqlite.state === "last-known-good"
                ? sqlite.staleSinceMs
                : maintenance.observedAtMs,
            maintenance.state === "last-known-good"
                ? maintenance.staleSinceMs
                : maintenance.observedAtMs
        ),
        state: "last-known-good",
    };
}

function projectDocker(
    docker: DockerOverview
): CacheHeartbeatOperationalSignals["docker"] {
    if (docker.state === "unavailable") {
        return { health: unavailable, updates: unavailable };
    }
    const healthCondition = docker.containers.some(
        ({ health, state }) =>
            state !== "running" || health === "unhealthy" || health === "starting"
    )
        ? "attention"
        : "healthy";
    const updateCondition = docker.updaterServices.some(
        ({ status }) => status.state !== "current"
    )
        ? "attention"
        : "current";
    return {
        health: sourceSignal(docker, healthCondition),
        updates: sourceSignal(docker, updateCondition),
    };
}

function projectLogs(
    logs: LogMaintenanceStatusOutput
): AvailableSignal<CacheHeartbeatOperationalSignals["logs"]> {
    let condition: "attention" | "healthy" | "running" = "healthy";
    if (
        logs.policies.some(
            ({ lastRun, state }) =>
                state === "unavailable" ||
                (lastRun !== undefined && lastRun.run.state !== "succeeded")
        )
    ) {
        condition = "attention";
    } else if (logs.policies.some(({ activeRun }) => activeRun !== undefined)) {
        condition = "running";
    }
    return { condition, observedAtMs: logs.observedAtMs, state: "fresh" };
}

function projectHostCapacity(
    metrics: SystemMetrics,
    nowMs: number
): AvailableSignal<CacheHeartbeatOperationalSignals["hostCapacity"]> {
    const condition =
        metrics.disk.usedPercent >= 85 || metrics.memory.usedPercent >= 85
            ? "attention"
            : "healthy";
    return metrics.freshness === "fresh"
        ? { condition, observedAtMs: metrics.sampledAtMs, state: "fresh" }
        : {
              condition,
              observedAtMs: metrics.sampledAtMs,
              staleSinceMs: Math.max(metrics.sampledAtMs, nowMs),
              state: "last-known-good",
          };
}

/**
 * Composes independent payload-free operational signals for heartbeat v5.
 * Optional provider seams fail closed and cannot suppress the existing sources.
 * @param dependencies Existing domain services and optional provider leaves.
 * @returns One independently contained heartbeat-v5 operational-signal reader.
 */
export function createCacheHeartbeatOperationalSignalsReader(
    dependencies: CacheHeartbeatOperationalSignalsDependencies
): OperationalSignalsReader {
    const nowMs = dependencies.nowMs ?? Date.now;
    return async () => {
        const [kopia, walg, database, docker, git, hostCapacity, logs, quota, weather] =
            await Promise.all([
                containedProviderSignal(
                    cacheHeartbeatBackupSignalSchema,
                    dependencies.readKopiaBackup
                ),
                containedProviderSignal(
                    cacheHeartbeatBackupSignalSchema,
                    dependencies.readWalgBackup
                ),
                contained(() => dependencies.databaseService.read(), undefined),
                contained<DockerOverview | undefined>(
                    dependencies.dockerService === undefined
                        ? undefined
                        : () => dependencies.dockerService!.overview(),
                    undefined
                ),
                containedProviderSignal(
                    cacheHeartbeatGitSignalSchema,
                    dependencies.readGit
                ),
                contained<CacheHeartbeatOperationalSignals["hostCapacity"]>(
                    async () =>
                        projectHostCapacity(
                            await dependencies.systemMetricsService.read(),
                            nowMs()
                        ),
                    unavailable
                ),
                contained<CacheHeartbeatOperationalSignals["logs"]>(
                    dependencies.logsService === undefined
                        ? undefined
                        : async () =>
                              projectLogs(
                                  await dependencies.logsService!.maintenanceStatus()
                              ),
                    unavailable
                ),
                containedProviderSignal(
                    cacheHeartbeatQuotaSignalSchema,
                    dependencies.readQuota
                ),
                containedProviderSignal(
                    cacheHeartbeatWeatherSignalSchema,
                    dependencies.readWeather
                ),
            ]);
        return v.parse(cacheHeartbeatOperationalSignalsSchema, {
            backups: { kopia, walg },
            database:
                database === undefined
                    ? {
                          postgresqlMaintenance: unavailable,
                          sqliteMaintenance: unavailable,
                      }
                    : {
                          postgresqlMaintenance: projectPostgresqlMaintenance(database),
                          sqliteMaintenance: projectSqliteMaintenance(database),
                      },
            docker:
                docker === undefined
                    ? { health: unavailable, updates: unavailable }
                    : projectDocker(docker),
            git,
            hostCapacity,
            logs,
            quota,
            weather,
        });
    };
}
