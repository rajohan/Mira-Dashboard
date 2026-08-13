import { describe, expect, test } from "bun:test";

import type { KopiaBackupStatus } from "../../../contracts/backups.ts";
import type { DatabaseOverview } from "../../../contracts/database.ts";
import type { DockerOverview } from "../../../contracts/docker.ts";
import { gitWorkspaceCacheTtlMs } from "../../../contracts/gitWorkspace.ts";
import type { LogMaintenanceStatusOutput } from "../../../contracts/logs.ts";
import { quotaCacheTtlMs } from "../../../contracts/quota.ts";
import type { SystemMetrics } from "../../../contracts/system.ts";
import { weatherCacheTtlMs } from "../../../contracts/weather.ts";
import {
    cacheHeartbeatBackupSignalFromStatus,
    createCacheHeartbeatOverviewSignalReaders,
    createCacheHeartbeatOperationalSignalsReader,
} from "./operationalSignals.ts";
import type { CacheEntryRecord } from "./repository.ts";

function cacheRecord(input: {
    readonly expiresAtMs: number;
    readonly key: string;
    readonly lastAttemptAtMs?: number;
    readonly lastAttemptStatus?: "failed" | "succeeded";
    readonly lastSuccessAtMs: number;
    readonly payload: unknown;
    readonly schemaId: string;
    readonly source: string;
}): CacheEntryRecord {
    return {
        consecutiveFailures: 0,
        expiresAt: new Date(input.expiresAtMs),
        failureCode: null,
        failureMessage: null,
        key: input.key,
        lastAttemptAt: new Date(input.lastAttemptAtMs ?? input.lastSuccessAtMs),
        lastAttemptDurationMs: 1,
        lastAttemptNumber: 1,
        lastAttemptRunId: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
        lastAttemptStatus: input.lastAttemptStatus ?? "succeeded",
        lastSuccessAt: new Date(input.lastSuccessAtMs),
        metadataJson: null,
        payloadJson: JSON.stringify(input.payload),
        schemaId: input.schemaId,
        source: input.source,
        updatedAt: new Date(input.lastAttemptAtMs ?? input.lastSuccessAtMs),
    };
}

describe("heartbeat operational signals", () => {
    test("reads exact Git, quota, and weather rows with independent freshness", () => {
        const records = new Map<string, CacheEntryRecord>([
            [
                "git.workspace",
                cacheRecord({
                    expiresAtMs: 1000 + gitWorkspaceCacheTtlMs,
                    key: "git.workspace",
                    lastSuccessAtMs: 1000,
                    payload: {
                        observedAtMs: 900,
                        repositories: [
                            {
                                branch: "main",
                                changedFileCount: 1,
                                detached: false,
                                headSha: "a".repeat(40),
                                id: "dashboard",
                                stagedFileCount: 0,
                                state: "available",
                                untrackedFileCount: 1,
                            },
                            ...["docker", "openclaw"].map((id) => ({
                                branch: "main",
                                changedFileCount: 0,
                                detached: false,
                                headSha: "b".repeat(40),
                                id,
                                stagedFileCount: 0,
                                state: "available",
                                untrackedFileCount: 0,
                            })),
                        ],
                    },
                    schemaId: "git.workspace.v1",
                    source: "git.managed-workspace",
                }),
            ],
            [
                "quotas.summary",
                cacheRecord({
                    expiresAtMs: 1000 + quotaCacheTtlMs,
                    key: "quotas.summary",
                    lastAttemptAtMs: 5000,
                    lastAttemptStatus: "failed",
                    lastSuccessAtMs: 1000,
                    payload: {
                        observedAtMs: 950,
                        providers: [
                            {
                                id: "elevenlabs",
                                label: "ElevenLabs",
                                status: "not-configured",
                            },
                            {
                                id: "openai",
                                label: "OpenAI",
                                status: "not-configured",
                            },
                            {
                                id: "openrouter",
                                label: "OpenRouter",
                                remainingPercent: 5,
                                status: "available",
                                unit: "currency-usd",
                            },
                            {
                                id: "synthetic",
                                label: "Synthetic",
                                status: "not-configured",
                            },
                        ],
                    },
                    schemaId: "quotas.summary.v1",
                    source: "quota.providers",
                }),
            ],
            [
                "weather.spydeberg",
                cacheRecord({
                    expiresAtMs: 1000 + weatherCacheTtlMs,
                    key: "weather.spydeberg",
                    lastSuccessAtMs: 1000,
                    payload: {
                        apparentTemperatureC: 10,
                        condition: "clear",
                        forecast: [
                            ["2026-08-13", 8, 14],
                            ["2026-08-14", 9, 15],
                            ["2026-08-15", 10, 16],
                        ].map(([date, minimumTemperatureC, maximumTemperatureC]) => ({
                            condition: "clear",
                            date,
                            maximumTemperatureC,
                            minimumTemperatureC,
                        })),
                        humidityPercent: 50,
                        location: "Spydeberg",
                        observedAtMs: 975,
                        temperatureC: 11,
                        timezone: "Europe/Oslo",
                        windKilometresPerHour: 4,
                    },
                    schemaId: "weather.spydeberg.v1",
                    source: "weather.open-meteo",
                }),
            ],
        ]);
        const readers = createCacheHeartbeatOverviewSignalReaders(
            { findEntry: (key) => records.get(key) },
            () => 2000
        );

        expect(readers.readGit()).toMatchObject({
            condition: "attention",
            observedAtMs: 900,
            state: "fresh",
        });
        expect(readers.readQuota()).toEqual({
            condition: "attention",
            observedAtMs: 950,
            staleSinceMs: 5000,
            state: "last-known-good",
        });
        expect(readers.readWeather()).toMatchObject({
            condition: "available",
            observedAtMs: 975,
            state: "fresh",
        });

        records.set("weather.spydeberg", {
            ...records.get("weather.spydeberg")!,
            source: "wrong.private.source",
        });
        expect(readers.readWeather()).toEqual({ state: "unavailable" });
    });

    test("reduces backup status without exposing source or Jobs identity", () => {
        const status = {
            activity: {
                jobRunId: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
                jobsUrl: "/jobs?runId=019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
                queuedAtMs: 4000,
                startedAtMs: 4500,
                state: "running",
            },
            checkedAtMs: 6000,
            payload: {
                backupCount: 1,
                healthy: true,
                providerIdle: true,
                sourceRevision: "a".repeat(64),
                sources: [
                    {
                        health: "current",
                        id: "private-source",
                        latestCompletedAtMs: 5000,
                        snapshotCount: 1,
                    },
                ],
                observedAtMs: 5000,
                type: "kopia",
            },
            staleSinceMs: 5500,
            state: "last-known-good",
        } as KopiaBackupStatus;

        const signal = cacheHeartbeatBackupSignalFromStatus(status);
        expect(signal).toEqual({
            condition: "running",
            observedAtMs: 5000,
            staleSinceMs: 5500,
            state: "last-known-good",
        });
        expect(JSON.stringify(signal)).not.toContain("private-source");
        expect(JSON.stringify(signal)).not.toContain("jobRunId");
    });

    test("keeps durable backup attention visible while the provider remains busy", () => {
        const status: KopiaBackupStatus = {
            activity: {
                finishedAtMs: 5500,
                jobRunId: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
                jobsUrl: "/jobs?runId=019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
                queuedAtMs: 4000,
                startedAtMs: 4500,
                state: "needs-attention",
            },
            checkedAtMs: 6000,
            payload: {
                backupCount: 1,
                healthy: true,
                observedAtMs: 5000,
                providerIdle: false,
                sourceRevision: "a".repeat(64),
                sources: [
                    {
                        health: "current",
                        id: "private-source",
                        latestCompletedAtMs: 5000,
                        snapshotCount: 1,
                    },
                ],
                type: "kopia",
            },
            state: "fresh",
        };

        expect(cacheHeartbeatBackupSignalFromStatus(status)).toEqual({
            condition: "attention",
            observedAtMs: 5000,
            state: "fresh",
        });
    });

    test("projects existing sources and provider seams without payload identities", async () => {
        const read = createCacheHeartbeatOperationalSignalsReader({
            databaseService: {
                read: () =>
                    Promise.resolve({
                        checkedAtMs: 5000,
                        postgresql: {
                            observedAtMs: 4000,
                            state: "fresh",
                            summary: { maintenance: { status: "review" } },
                        },
                        sqlite: {
                            lifecycle: {
                                maintenance: {
                                    enabled: true,
                                    latestSuccessfulAtMs: 3500,
                                    nextRunAtMs: 8000,
                                    observedAtMs: 4000,
                                    runs: [],
                                    schedule: {
                                        timeOfDay: "02:40",
                                        timeZone: "Europe/Oslo",
                                    },
                                    state: "available",
                                },
                            },
                            observedAtMs: 4000,
                            state: "fresh",
                        },
                    } as unknown as DatabaseOverview),
            },
            dockerService: {
                overview: () =>
                    ({
                        checkedAtMs: 5000,
                        containers: [{ health: "unhealthy", state: "running" }],
                        observedAtMs: 3000,
                        staleSinceMs: 4500,
                        state: "last-known-good",
                        updaterServices: [{ status: { state: "update-available" } }],
                    }) as unknown as DockerOverview,
            },
            logsService: {
                maintenanceStatus: () =>
                    Promise.resolve({
                        observedAtMs: 4800,
                        policies: [
                            {
                                activeRun: { state: "running" },
                                state: "queueable",
                            },
                        ],
                    } as unknown as LogMaintenanceStatusOutput),
            },
            nowMs: () => 5000,
            readKopiaBackup: () => ({
                condition: "healthy",
                observedAtMs: 4500,
                state: "fresh",
            }),
            readGit: () => ({
                condition: "clean",
                observedAtMs: 4700,
                state: "fresh",
            }),
            readQuota: () => ({
                condition: "attention",
                observedAtMs: 4600,
                state: "fresh",
            }),
            readWeather: () => ({
                condition: "available",
                observedAtMs: 4550,
                state: "fresh",
            }),
            systemMetricsService: {
                read: () =>
                    Promise.resolve({
                        disk: { usedPercent: 50 },
                        freshness: "fresh",
                        memory: { usedPercent: 86 },
                        sampledAtMs: 4900,
                    } as unknown as SystemMetrics),
            },
        });

        const result = await read();
        expect(result).toMatchObject({
            backups: {
                kopia: { condition: "healthy", state: "fresh" },
                walg: { state: "unavailable" },
            },
            database: {
                postgresqlMaintenance: {
                    condition: "attention",
                    state: "fresh",
                },
                sqliteMaintenance: { condition: "healthy", state: "fresh" },
            },
            docker: {
                health: {
                    condition: "attention",
                    state: "last-known-good",
                },
                updates: {
                    condition: "attention",
                    state: "last-known-good",
                },
            },
            git: { condition: "clean", state: "fresh" },
            hostCapacity: { condition: "attention", state: "fresh" },
            logs: { condition: "running", state: "fresh" },
            quota: { condition: "attention", state: "fresh" },
            weather: { condition: "available", state: "fresh" },
        });
        expect(JSON.stringify(result)).not.toContain("container");
        expect(JSON.stringify(result)).not.toContain("path");
    });

    test("contains source and optional-reader failures independently", async () => {
        const read = createCacheHeartbeatOperationalSignalsReader({
            databaseService: {
                read: () => Promise.reject(new Error("database path")),
            },
            readGit: () => {
                throw new Error("repository path");
            },
            readQuota: () =>
                ({
                    condition: "secret-provider-state",
                    observedAtMs: 1,
                    state: "fresh",
                }) as never,
            readWeather: () => ({
                condition: "available",
                observedAtMs: 1,
                state: "fresh",
            }),
            systemMetricsService: {
                read: () => Promise.reject(new Error("host identity")),
            },
        });

        const result = await read();
        expect(result.database.postgresqlMaintenance.state).toBe("unavailable");
        expect(result.database.sqliteMaintenance.state).toBe("unavailable");
        expect(result.docker.health.state).toBe("unavailable");
        expect(result.git.state).toBe("unavailable");
        expect(result.hostCapacity.state).toBe("unavailable");
        expect(result.logs.state).toBe("unavailable");
        expect(result.quota.state).toBe("unavailable");
        expect(result.weather.state).toBe("fresh");
        expect(JSON.stringify(result)).not.toContain("repository path");
    });
});
