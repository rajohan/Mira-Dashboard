import { describe, expect, it, jest } from "bun:test";
import { rmSync } from "node:fs";

import { requestUrl } from "../../../test/support/fetch.ts";
import { database } from "../../src/database/connection.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
import { startTestScheduledJobExecutor } from "../support/scheduledJobExecutor.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
import { captureStructuredLogs } from "../support/structuredLogCapture.ts";
describe("backend cache services", () => {
    const { cleanupCallbacks, rememberEnvironment, startTestScheduledExecutor, waitFor } =
        createServiceBehaviorHarness();
    it("records cache failures without claiming a successful update timestamp", async () => {
        const key = `test.cache.${Bun.randomUUIDv7()}`;
        const { writeCacheFailure } =
            await import("../../src/services/cacheRefresh/cacheEntryFailure.ts");
        try {
            writeCacheFailure({
                key,
                source: "test",
                ttl: 5,
                ttlUnit: "minutes",
                error: new Error("provider unavailable"),
                metadata: {
                    provider: "unit-test",
                },
            });
            const row = database
                .prepare(`SELECT updated_at, last_attempt_at, status, error_message, consecutive_failures, metadata_json
                     FROM cache_entries
                     WHERE key = ?`)
                .get(key) as {
                updated_at: string | null;
                last_attempt_at: string;
                status: string;
                error_message: string;
                consecutive_failures: number;
                metadata_json: string;
            };
            expect(row.updated_at).toBeNull();
            expect(row.last_attempt_at).toBeTruthy();
            expect(row.status).toBe("error");
            expect(row.error_message).toBe("provider unavailable");
            expect(row.consecutive_failures).toBe(1);
            expect(JSON.parse(row.metadata_json)).toMatchObject({
                provider: "unit-test",
                lastFailureAt: row.last_attempt_at,
            });
        } finally {
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
        }
    });
    it("writes successful cache entries and preserves existing data when requested", async () => {
        const key = `test.cache.success.${Bun.randomUUIDv7()}`;
        const { getCacheEntry, invalidateCacheEntry } =
            await import("../../src/lib/cacheStore.ts");
        const { writeCacheSuccess } =
            await import("../../src/services/cacheEntryWriter.ts");
        try {
            writeCacheSuccess({
                data: {
                    version: 1,
                },
                key,
                metadata: {
                    source: "initial",
                },
                source: "unit",
                ttl: 1,
                ttlUnit: "minutes",
            });
            writeCacheSuccess({
                data: {
                    version: 2,
                },
                key,
                metadata: {
                    source: "preserved",
                },
                preserveExistingData: true,
                source: "unit",
                ttl: 2,
                ttlUnit: "hours",
            });
            const row = database
                .prepare(`SELECT data_json, status, consecutive_failures, error_message, metadata_json
                     FROM cache_entries
                     WHERE key = ?`)
                .get(key) as {
                consecutive_failures: number;
                data_json: string;
                error_message: string | null;
                metadata_json: string;
                status: string;
            };
            expect(JSON.parse(row.data_json)).toEqual({
                version: 1,
            });
            expect(row.status).toBe("fresh");
            expect(row.consecutive_failures).toBe(0);
            expect(row.error_message).toBeNull();
            expect(JSON.parse(row.metadata_json)).toEqual({
                source: "preserved",
            });
            invalidateCacheEntry(key, new Date(0));
            expect(getCacheEntry(key)).toMatchObject({
                data: JSON.stringify({
                    version: 1,
                }),
                error_code: undefined,
                error_message: undefined,
                status: "stale",
            });
            expect(() => invalidateCacheEntry(`${key}.missing`)).not.toThrow();
        } finally {
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
        }
    });
    it("invalidates database metrics on startup and queues lifecycle refreshes", async () => {
        const key = "database.summary";
        const originalEntry = database
            .prepare("SELECT * FROM cache_entries WHERE key = ?")
            .get(key) as
            | {
                  consecutive_failures: number;
                  data_json: string | null;
                  error_code: string | null;
                  error_message: string | null;
                  expires_at: string;
                  key: string;
                  last_attempt_at: string;
                  metadata_json: string;
                  source: string;
                  status: string;
                  updated_at: string | null;
              }
            | undefined;
        const { enqueueDatabaseSummaryRefresh, registerCacheRefreshScheduledJobs } =
            await import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts");
        const { getCacheEntry } = await import("../../src/lib/cacheStore.ts");
        const { writeCacheSuccess } =
            await import("../../src/services/cacheEntryWriter.ts");
        const { getScheduledJob, updateScheduledJob } =
            await import("../../src/services/scheduledJobs/repository.ts");
        registerCacheRefreshScheduledJobs({
            seedStrategy: "none",
        });
        const originalJobEnabled =
            getScheduledJob("cache.database.summary")?.enabled ?? true;
        updateScheduledJob("cache.database.summary", {
            enabled: true,
        });
        const baselineRunId = (
            database
                .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM scheduled_job_runs")
                .get() as {
                id: number;
            }
        ).id;
        const createdRunIds: number[] = [];
        const removeCreatedRuns = () => {
            for (const runId of createdRunIds) {
                database
                    .prepare("DELETE FROM job_executions WHERE scheduled_run_id = ?")
                    .run(runId);
                database
                    .prepare("DELETE FROM scheduled_job_runs WHERE id = ?")
                    .run(runId);
            }
            createdRunIds.length = 0;
        };
        cleanupCallbacks.push(() => {
            removeCreatedRuns();
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(key);
            if (originalEntry) {
                database
                    .prepare(`INSERT INTO cache_entries (
                             key, data_json, source, updated_at, last_attempt_at,
                             expires_at, status, error_code, error_message,
                             consecutive_failures, metadata_json
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(
                        originalEntry.key,
                        originalEntry.data_json,
                        originalEntry.source,
                        originalEntry.updated_at,
                        originalEntry.last_attempt_at,
                        originalEntry.expires_at,
                        originalEntry.status,
                        originalEntry.error_code,
                        originalEntry.error_message,
                        originalEntry.consecutive_failures,
                        originalEntry.metadata_json
                    );
            }
            updateScheduledJob("cache.database.summary", {
                enabled: originalJobEnabled,
            });
        });
        writeCacheSuccess({
            data: {
                migrations: "old",
            },
            key,
            metadata: {
                source: "startup-test",
            },
            source: "unit",
            ttl: 1,
            ttlUnit: "hours",
        });
        registerCacheRefreshScheduledJobs({
            refreshDatabaseOnStartup: true,
            seedStrategy: "queue",
        });
        const startupRuns = database
            .prepare(`SELECT id
                 FROM scheduled_job_runs
                 WHERE id > ?
                 ORDER BY id`)
            .all(baselineRunId) as Array<{
            id: number;
        }>;
        createdRunIds.push(...startupRuns.map((run) => run.id));
        const startupDatabaseRun = database
            .prepare(`SELECT run.id, run.status, run.trigger_type AS triggerType,
                        execution.available_at AS availableAt,
                        execution.queued_at AS queuedAt
                 FROM scheduled_job_runs AS run
                 JOIN job_executions AS execution
                   ON execution.scheduled_run_id = run.id
                 WHERE run.id > ? AND run.job_id = 'cache.database.summary'
                 ORDER BY run.id DESC
                 LIMIT 1`)
            .get(baselineRunId) as {
            availableAt: string;
            id: number;
            queuedAt: string;
            status: string;
            triggerType: string;
        };
        expect(startupDatabaseRun).toMatchObject({
            status: "queued",
            triggerType: "startup",
        });
        expect(
            Date.parse(startupDatabaseRun.availableAt) -
                Date.parse(startupDatabaseRun.queuedAt)
        ).toBeLessThan(2500);
        expect(getCacheEntry(key)).toMatchObject({
            data: JSON.stringify({
                migrations: "old",
            }),
            status: "stale",
        });
        removeCreatedRuns();
        writeCacheSuccess({
            data: {
                migrations: "current",
            },
            key,
            metadata: {
                source: "maintenance-test",
            },
            source: "unit",
            ttl: 1,
            ttlUnit: "hours",
        });
        enqueueDatabaseSummaryRefresh();
        const systemRun = database
            .prepare(`SELECT id, job_id AS jobId, status, trigger_type AS triggerType
                 FROM scheduled_job_runs
                 WHERE job_id = 'cache.database.summary'
                 ORDER BY id DESC
                 LIMIT 1`)
            .get() as {
            id: number;
            jobId: string;
            status: string;
            triggerType: string;
        };
        createdRunIds.push(systemRun.id);
        expect(systemRun).toMatchObject({
            jobId: "cache.database.summary",
            status: "queued",
            triggerType: "system",
        });
        expect(
            database
                .prepare(`SELECT status, trigger_type AS triggerType
                     FROM job_executions
                     WHERE scheduled_run_id = ?`)
                .get(systemRun.id)
        ).toEqual({
            status: "queued",
            triggerType: "system",
        });
        expect(getCacheEntry(key)).toMatchObject({
            data: JSON.stringify({
                migrations: "current",
            }),
            status: "stale",
        });
        removeCreatedRuns();
        writeCacheSuccess({
            data: {
                migrations: "paused",
            },
            key,
            metadata: {
                source: "disabled-maintenance-test",
            },
            source: "unit",
            ttl: 1,
            ttlUnit: "hours",
        });
        updateScheduledJob("cache.database.summary", {
            enabled: false,
        });
        const disabledBaselineRunId = (
            database
                .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM scheduled_job_runs")
                .get() as {
                id: number;
            }
        ).id;
        expect(() => enqueueDatabaseSummaryRefresh()).not.toThrow();
        expect(
            database
                .prepare(`SELECT COUNT(*) AS count
                     FROM scheduled_job_runs
                     WHERE id > ? AND job_id = 'cache.database.summary'`)
                .get(disabledBaselineRunId)
        ).toEqual({
            count: 0,
        });
        expect(getCacheEntry(key)).toMatchObject({
            data: JSON.stringify({
                migrations: "paused",
            }),
            status: "stale",
        });
    });
    it("reports database-summary refresh results from SQLite maintenance", async () => {
        const { enqueueDatabaseSummaryRefresh } =
            await import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts");
        const { SQLITE_MAINTENANCE_JOB_ID, registerSqliteMaintenanceScheduledJob } =
            await import("../../src/services/sqliteMaintenance.ts");
        const { getScheduledJob, runScheduledJob, updateScheduledJob } =
            await Promise.all([
                import("../../src/services/scheduledJobs/repository.ts"),
                import("../../src/services/scheduledJobs/enqueue.ts"),
            ]).then(([module0, module1]) => ({
                getScheduledJob: module0.getScheduledJob,
                runScheduledJob: module1.runScheduledJob,
                updateScheduledJob: module0.updateScheduledJob,
            }));
        const originalJob = getScheduledJob(SQLITE_MAINTENANCE_JOB_ID);
        const createdBackupPaths: string[] = [];
        const createdRunIds: number[] = [];
        const queuedRefresh = jest.fn(() => {});
        const structuredLogs = captureStructuredLogs();
        cleanupCallbacks.push(() => {
            structuredLogs.stop();
            for (const backupPath of createdBackupPaths) {
                rmSync(backupPath, {
                    force: true,
                });
            }
            registerSqliteMaintenanceScheduledJob({
                enqueueDatabaseSummaryRefresh,
            });
            for (const runId of createdRunIds) {
                database
                    .prepare("DELETE FROM job_executions WHERE scheduled_run_id = ?")
                    .run(runId);
                database
                    .prepare("DELETE FROM scheduled_job_runs WHERE id = ?")
                    .run(runId);
            }
            if (originalJob) {
                updateScheduledJob(SQLITE_MAINTENANCE_JOB_ID, {
                    cronExpression: originalJob.cronExpression,
                    enabled: originalJob.enabled,
                    intervalSeconds: originalJob.intervalSeconds,
                    scheduleType: originalJob.scheduleType,
                    timeOfDay: originalJob.timeOfDay,
                });
            } else {
                database
                    .prepare("DELETE FROM scheduled_jobs WHERE id = ?")
                    .run(SQLITE_MAINTENANCE_JOB_ID);
            }
        });
        registerSqliteMaintenanceScheduledJob({
            enqueueDatabaseSummaryRefresh: queuedRefresh,
        });
        updateScheduledJob(SQLITE_MAINTENANCE_JOB_ID, {
            enabled: true,
        });
        await startTestScheduledExecutor();
        const queuedRun = await runScheduledJob(SQLITE_MAINTENANCE_JOB_ID);
        createdBackupPaths.push(
            (
                queuedRun.output.backup as {
                    path: string;
                }
            ).path
        );
        createdRunIds.push(queuedRun.id);
        expect(queuedRun).toMatchObject({
            cancellable: false,
            output: {
                cacheRefresh: {
                    status: "queued",
                },
            },
            status: "success",
        });
        expect(queuedRefresh).toHaveBeenCalledTimes(1);
        registerSqliteMaintenanceScheduledJob({
            enqueueDatabaseSummaryRefresh: () => {
                throw new Error("refresh queue unavailable");
            },
        });
        const failedRefreshRun = await runScheduledJob(SQLITE_MAINTENANCE_JOB_ID);
        createdBackupPaths.push(
            (
                failedRefreshRun.output.backup as {
                    path: string;
                }
            ).path
        );
        createdRunIds.push(failedRefreshRun.id);
        expect(failedRefreshRun).toMatchObject({
            output: {
                cacheRefresh: {
                    message: "refresh queue unavailable",
                    status: "failed",
                },
            },
            status: "success",
        });
        expect(structuredLogs.entries).toContainEqual(
            expect.objectContaining({
                component: "sqlite-maintenance",
                error: expect.objectContaining({
                    message: "refresh queue unavailable",
                }),
                event: "sqlite_maintenance.summary_refresh_enqueue_failed",
                level: "warn",
            })
        );
    });
    it("rejects unsupported and aborted cache refresh producer requests", async () => {
        const { refreshCacheProducer, waitForLocalCacheSeed } = await Promise.all([
            import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts"),
            import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts"),
        ]).then(([module0, module1]) => ({
            refreshCacheProducer: module0.refreshCacheProducer,
            waitForLocalCacheSeed: module1.waitForLocalCacheSeed,
        }));
        const { cacheRoutes } = await import("../../src/routes/cacheRoutes.ts");
        expect(refreshCacheProducer("unknown.cache.key")).rejects.toThrow(
            "No backend refresh producer configured for cache key"
        );
        const unknownRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/unknown.cache.key/refresh",
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        key: "unknown.cache.key",
                    },
                }
            )
        );
        expect(unknownRefresh.status).toBe(400);
        expect(unknownRefresh.json()).resolves.toEqual(
            apiErrorExpectation(
                "No backend refresh producer configured for cache key: unknown.cache.key"
            )
        );
        const missingCacheKey = cacheRoutes["/api/cache/:key"].GET(
            Object.assign(new Request("https://dashboard.test/api/cache/%20"), {
                params: {
                    key: " ",
                },
            })
        );
        expect(missingCacheKey.status).toBe(400);
        expect(missingCacheKey.json()).resolves.toEqual(
            apiErrorExpectation("Missing cache key")
        );
        const controller = new AbortController();
        controller.abort();
        expect(
            refreshCacheProducer("weather.spydeberg", controller.signal)
        ).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(waitForLocalCacheSeed("missing.key")).resolves.toBeUndefined();
    });
    it("refreshes supported cache keys through the cache route", async () => {
        rememberEnvironment("MOLTBOOK_API_KEY");
        process.env.MOLTBOOK_API_KEY = "moltbook-key";
        const { waitForLocalCacheSeed } =
            await import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts");
        try {
            await waitForLocalCacheSeed("weather.spydeberg");
        } catch {
            // Startup seeding is best-effort; this test replaces it with a mock refresh.
        }
        cleanupCallbacks.push(() => {
            database
                .prepare(`DELETE FROM cache_entries
                     WHERE key IN (
                         'weather.spydeberg',
                         'log_rotation.state',
                         'moltbook.home'
                     )`)
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(((
            input: Request | string | URL
        ) => {
            return Promise.try(() => {
                const url = input instanceof Request ? input.url : requestUrl(input);
                if (url.startsWith("https://wttr.in/Spydeberg")) {
                    return Response.json({
                        current_condition: [
                            {
                                FeelsLikeC: "8",
                                humidity: "75",
                                temp_C: "10",
                                weatherCode: "116",
                                weatherDesc: [
                                    {
                                        value: "Partly cloudy",
                                    },
                                ],
                                windspeedKmph: "14",
                            },
                        ],
                        nearest_area: [
                            {
                                areaName: [
                                    {
                                        value: "Spydeberg",
                                    },
                                ],
                            },
                        ],
                        weather: [
                            {
                                date: "2026-06-26",
                                maxtempC: "18",
                                mintempC: "7",
                                hourly: [
                                    {
                                        weatherCode: "116",
                                        weatherDesc: [
                                            {
                                                value: "Partly cloudy",
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    });
                }
                if (url === "https://www.moltbook.com/api/v1/home") {
                    return Response.json({
                        activity_on_your_posts: [],
                        posts_from_accounts_you_follow: [],
                        what_to_do_next: [],
                        your_direct_messages: {
                            pending_request_count: 0,
                            unread_message_count: 0,
                        },
                    });
                }
                return new Response("not found", {
                    status: 404,
                });
            });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const { cacheRefreshScheduledJobId, registerCacheRefreshScheduledJobs } =
            await import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts");
        const { enqueueScheduledJob, stopScheduledJobExecutor, updateScheduledJob } =
            await Promise.all([
                import("../../src/services/scheduledJobs/enqueue.ts"),
                import("../../src/services/scheduledJobs/runtime.ts"),
                import("../../src/services/scheduledJobs/repository.ts"),
            ]).then(([module0, module1, module2]) => ({
                enqueueScheduledJob: module0.enqueueScheduledJob,
                stopScheduledJobExecutor: module1.stopScheduledJobExecutor,
                updateScheduledJob: module2.updateScheduledJob,
            }));
        expect(cacheRefreshScheduledJobId("weather.spydeberg")).toBe("cache.weather");
        expect(cacheRefreshScheduledJobId("moltbook.home")).toBeUndefined();
        expect(cacheRefreshScheduledJobId("system.openclaw")).toBe("cache.system");
        expect(cacheRefreshScheduledJobId("log_rotation.state")).toBeUndefined();
        registerCacheRefreshScheduledJobs({
            seedStrategy: "none",
        });
        cleanupCallbacks.push(() => {
            database
                .prepare(`DELETE FROM job_executions
                     WHERE scheduled_job_id = 'cache.weather'
                        OR (action_key = 'cache.refresh'
                            AND json_extract(payload_json, '$.key') IN (
                                'log_rotation.state',
                                'moltbook.home',
                                'weather.spydeberg'
                            ))`)
                .run();
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id = 'cache.weather'")
                .run();
        });
        await startTestScheduledExecutor();
        const { cacheRoutes } = await import("../../src/routes/cacheRoutes.ts");
        const response = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/weather.spydeberg/refresh",
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        key: "weather.spydeberg",
                    },
                }
            )
        );
        expect(response.status).toBe(200);
        expect(response.json()).resolves.toMatchObject({
            entry: {
                data: {
                    description: "Partly cloudy",
                    location: "Spydeberg",
                    temperatureC: 10,
                },
                key: "weather.spydeberg",
                source: "wttr.in",
                status: "fresh",
            },
            isOk: true,
        });
        expect(
            database
                .prepare(`SELECT job_id AS jobId, status, trigger_type AS triggerType
                     FROM scheduled_job_runs
                     WHERE job_id = 'cache.weather'
                     ORDER BY id DESC
                     LIMIT 1`)
                .get()
        ).toEqual({
            jobId: "cache.weather",
            status: "success",
            triggerType: "manual",
        });
        const existingRun = enqueueScheduledJob("cache.weather", "startup");
        const reusedRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/weather.spydeberg/refresh",
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        key: "weather.spydeberg",
                    },
                }
            )
        );
        expect(reusedRefresh.status).toBe(200);
        expect(
            database
                .prepare(`SELECT id, trigger_type AS triggerType
                     FROM scheduled_job_runs
                     WHERE job_id = 'cache.weather'
                     ORDER BY id DESC
                     LIMIT 1`)
                .get()
        ).toEqual({
            id: existingRun.id,
            triggerType: "startup",
        });
        const moltbookHome = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request("https://dashboard.test/api/cache/moltbook.home/refresh", {
                    method: "POST",
                }),
                {
                    params: {
                        key: "moltbook.home",
                    },
                }
            )
        );
        expect(moltbookHome.status).toBe(200);
        expect(
            database
                .prepare(`SELECT scheduled_job_id IS NULL AS isUnscheduled, status,
                            trigger_type AS triggerType
                     FROM job_executions
                     WHERE action_key = 'cache.refresh'
                       AND json_extract(payload_json, '$.key') = 'moltbook.home'
                     ORDER BY queued_at DESC, id DESC
                     LIMIT 1`)
                .get()
        ).toEqual({
            isUnscheduled: 1,
            status: "success",
            triggerType: "manual",
        });
        await stopScheduledJobExecutor();
        const disabledRun = enqueueScheduledJob("cache.weather", "startup");
        expect(
            updateScheduledJob("cache.weather", {
                enabled: false,
            })
        ).toMatchObject({
            enabled: false,
        });
        cleanupCallbacks.push(() => {
            updateScheduledJob("cache.weather", {
                enabled: true,
            });
        });
        const disabledRefreshPromise = cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/weather.spydeberg/refresh",
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        key: "weather.spydeberg",
                    },
                }
            )
        );
        await waitFor(
            () =>
                database
                    .prepare(`SELECT 1
                         FROM job_executions
                         WHERE scheduled_job_id IS NULL
                           AND action_key = 'cache.refresh'
                           AND json_extract(payload_json, '$.key') = 'weather.spydeberg'
                           AND status = 'queued'`)
                    .get() !== undefined
        );
        startTestScheduledJobExecutor();
        const disabledRefresh = await disabledRefreshPromise;
        expect(disabledRefresh.status).toBe(200);
        expect(
            database
                .prepare(`SELECT status
                     FROM scheduled_job_runs
                     WHERE id = ?`)
                .get(disabledRun.id)
        ).toEqual({
            status: "cancelled",
        });
        expect(
            database
                .prepare(`SELECT scheduled_job_id IS NULL AS isUnscheduled, status,
                            trigger_type AS triggerType
                     FROM job_executions
                     WHERE scheduled_job_id IS NULL
                       AND action_key = 'cache.refresh'
                       AND json_extract(payload_json, '$.key') = 'weather.spydeberg'
                     ORDER BY queued_at DESC, id DESC
                     LIMIT 1`)
                .get()
        ).toEqual({
            isUnscheduled: 1,
            status: "success",
            triggerType: "manual",
        });
        expect(
            updateScheduledJob("cache.weather", {
                enabled: true,
            })
        ).toMatchObject({
            enabled: true,
        });
        await stopScheduledJobExecutor();
        const disabledAfterReuseRun = enqueueScheduledJob("cache.weather", "startup");
        const disabledAfterReusePromise = cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/weather.spydeberg/refresh",
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        key: "weather.spydeberg",
                    },
                }
            )
        );
        expect(
            updateScheduledJob("cache.weather", {
                enabled: false,
            })
        ).toMatchObject({
            enabled: false,
        });
        startTestScheduledJobExecutor();
        const disabledAfterReuseRefresh = await disabledAfterReusePromise;
        expect(disabledAfterReuseRefresh.status).toBe(200);
        expect(
            database
                .prepare(`SELECT status
                     FROM scheduled_job_runs
                     WHERE id = ?`)
                .get(disabledAfterReuseRun.id)
        ).toEqual({
            status: "cancelled",
        });
        expect(
            updateScheduledJob("cache.weather", {
                enabled: true,
            })
        ).toMatchObject({
            enabled: true,
        });
        cleanupCallbacks.push(() => {
            registerCacheRefreshScheduledJobs({
                seedStrategy: "none",
            });
        });
        const unscheduledWeatherCountBefore = (
            database
                .prepare(`SELECT COUNT(*) AS count
                     FROM job_executions
                     WHERE scheduled_job_id IS NULL
                       AND action_key = 'cache.refresh'
                       AND json_extract(payload_json, '$.key') = 'weather.spydeberg'`)
                .get() as {
                count: number;
            }
        ).count;
        database.prepare("DELETE FROM scheduled_jobs WHERE id = 'cache.weather'").run();
        const missingScheduleRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/weather.spydeberg/refresh",
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        key: "weather.spydeberg",
                    },
                }
            )
        );
        expect(missingScheduleRefresh.status).toBe(200);
        expect(
            (
                database
                    .prepare(`SELECT COUNT(*) AS count
                         FROM job_executions
                         WHERE scheduled_job_id IS NULL
                           AND action_key = 'cache.refresh'
                           AND json_extract(payload_json, '$.key') = 'weather.spydeberg'`)
                    .get() as {
                    count: number;
                }
            ).count
        ).toBe(unscheduledWeatherCountBefore + 1);
        registerCacheRefreshScheduledJobs({
            seedStrategy: "none",
        });
        const logRotationState = await cacheRoutes["/api/cache/:key/refresh"].POST(
            Object.assign(
                new Request(
                    "https://dashboard.test/api/cache/log_rotation.state/refresh",
                    {
                        method: "POST",
                    }
                ),
                {
                    params: {
                        key: "log_rotation.state",
                    },
                }
            )
        );
        expect(logRotationState.status).toBe(200);
    }, 10_000);
});
