import { afterEach, describe, expect, it, jest } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
import { startTestScheduledJobExecutor } from "../support/scheduledJobExecutor.ts";
const cleanupCallbacks: Array<() => Promise<void> | void> = [];
function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}
function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() =>
        rmSync(root, {
            force: true,
            recursive: true,
        })
    );
    return root;
}
function writeExecutable(filePath: string, content: string): void {
    writeFileSync(filePath, content);
    chmodSync(filePath, 0o755);
}
function isolateOpenClawEnvironment(prefix: string): void {
    rememberEnvironment("OPENCLAW_HOME");
    rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
    const root = createTemporaryRoot(prefix);
    process.env.OPENCLAW_HOME = path.join(root, "openclaw-home");
    process.env.MIRA_DASHBOARD_OPENCLAW_HOME = path.join(root, "dashboard-home");
}
function requestWithParameters<T extends string>(
    route: string,
    parameters: Record<T, string>,
    init?: RequestInit
): Request & {
    params: Record<T, string>;
} {
    return Object.assign(new Request(`https://test.local${route}`, init), {
        params: parameters,
    });
}
function jsonRequest(route: string, body: unknown): Request {
    return new Request(`https://test.local${route}`, {
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });
}
async function startTestScheduledExecutor(): Promise<void> {
    const { stopScheduledJobExecutor } =
        await import("../../src/services/scheduledJobs/runtime.ts");
    startTestScheduledJobExecutor();
    cleanupCallbacks.push(stopScheduledJobExecutor);
}
afterEach(async () => {
    while (cleanupCallbacks.length > 0) await cleanupCallbacks.pop()?.();
    database
        .prepare(
            "DELETE FROM task_updates WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database
        .prepare(
            "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database.prepare("DELETE FROM tasks WHERE title LIKE 'Coverage %'").run();
    database
        .prepare(
            "DELETE FROM openclaw_cron_job_metadata WHERE job_id LIKE 'coverage-%' OR job_id = 'item-cron'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM notifications WHERE dedupe_key LIKE 'quota:%' OR dedupe_key LIKE 'openclaw:%'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM quota_alert_state WHERE provider IN ('openrouter', 'elevenlabs', 'synthetic', 'openai')"
        )
        .run();
    database.prepare("DELETE FROM openclaw_alert_state WHERE id = 1").run();
    database
        .prepare(
            "DELETE FROM scheduled_job_runs WHERE job_id LIKE 'cache.%' OR job_id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM scheduled_jobs WHERE id LIKE 'cache.%' OR id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM cache_entries WHERE key IN ('quotas.summary', 'system.host', 'system.openclaw', 'git.workspace', 'backup.kopia.status', 'backup.walg.status', 'log_rotation.state', 'weather.spydeberg')"
        )
        .run();
    database.prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'").run();
    database
        .prepare(
            "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'coverage-%')"
        )
        .run();
    database.prepare("DELETE FROM auth_rate_limit_buckets").run();
    database.prepare("DELETE FROM users WHERE username LIKE 'coverage-%'").run();
});
describe("backend contract and metrics routes", () => {
    it("defensive route contracts for Docker, pull requests, cache, database, and backup APIs", async () => {
        isolateOpenClawEnvironment("mira-route-contract-coverage-");
        const terminalRoot = createTemporaryRoot("mira-terminal-route-coverage-");
        const terminalDirectory = path.join(terminalRoot, "work dir");
        const terminalFile = path.join(terminalRoot, "work file.txt");
        const terminalExecutable = path.join(terminalRoot, "work-bin");
        mkdirSync(terminalDirectory);
        writeFileSync(terminalFile, "text");
        writeExecutable(terminalExecutable, "#!/usr/bin/env bash\nexit 0\n");
        const [
            { backupRoutes },
            { cacheRoutes },
            { cronRoutes },
            { dockerRoutes },
            gatewayModule,
            { jobRoutes },
            { moltbookRoutes },
            { pullRequestRoutes },
            { terminalRoutes },
        ] = await Promise.all([
            import("../../src/routes/backupRoutes.ts"),
            import("../../src/routes/cacheRoutes.ts"),
            import("../../src/routes/cronRoutes.ts"),
            import("../../src/routes/dockerRoutes.ts"),
            import("../../src/services/gateway/runtime.ts"),
            import("../../src/routes/jobRoutes.ts"),
            import("../../src/routes/moltbookRoutes.ts"),
            import("../../src/routes/pullRequestRoutes.ts"),
            import("../../src/routes/terminalRoutes.ts"),
        ]);
        const gateway = gatewayModule.default;
        const gatewayRequestSpy = jest
            .spyOn(gateway, "request")
            .mockImplementation((method) => {
                return Promise.try(() => {
                    if (method === "cron.list") {
                        return {
                            jobs: [
                                {
                                    enabled: false,
                                    id: "item-cron",
                                    name: "Coverage cron",
                                    state: {
                                        lastRunAtMs: 1_721_465_940_000,
                                        lastRunStatus: "ok",
                                    },
                                },
                            ],
                        };
                    }
                    throw Object.assign(new Error(`gateway failed for ${method}`), {
                        statusCode: 502,
                    });
                });
            });
        cleanupCallbacks.push(() => gatewayRequestSpy.mockRestore());
        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES ('route.string', 'raw-value', 'test', ?, ?, ?, 'fresh', 2, '{}') ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, expires_at = excluded.expires_at"
            )
            .run(Date.now(), Date.now(), Date.now() + 60_000);
        cleanupCallbacks.push(() => {
            database
                .prepare(
                    "DELETE FROM cache_entries WHERE key = 'route.string' OR key LIKE 'moltbook.%'"
                )
                .run();
        });
        const heartbeatTimestamp = "2026-07-20T10:00:00.000Z";
        database
            .prepare(`INSERT INTO tasks (
                    title, body, status, priority, labels_json, automation_json,
                    assignee, created_at, updated_at
                ) VALUES (?, '', 'in-progress', 'high', ?, ?, 'mira-2026', ?, ?)`)
            .run(
                "Coverage heartbeat task",
                JSON.stringify(["in-progress", "priority-high"]),
                JSON.stringify({
                    type: "cron",
                    recurring: true,
                    cronJobId: "item-cron",
                }),
                heartbeatTimestamp,
                heartbeatTimestamp
            );
        database
            .prepare(`INSERT INTO openclaw_cron_job_metadata (
                    job_id, disable_intent_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?)`)
            .run(
                "item-cron",
                JSON.stringify({
                    mode: "indefinite",
                    comment: "Paused during chat work",
                }),
                heartbeatTimestamp,
                heartbeatTimestamp
            );
        database
            .prepare(`INSERT INTO scheduled_jobs (
                    id, name, description, enabled, schedule_type, interval_seconds,
                    action_key, action_payload_json, disable_intent_json,
                    next_run_at, created_at, updated_at
                ) VALUES (?, ?, '', 0, 'daily', 86400, ?, '{}', ?, ?, ?, ?)`)
            .run(
                "coverage.workspace-sync",
                "OpenClaw workspace sync",
                "workspace.sync",
                JSON.stringify({
                    mode: "indefinite",
                    comment: "Paused during maintenance",
                }),
                "2026-07-21T02:00:00.000Z",
                heartbeatTimestamp,
                heartbeatTimestamp
            );
        database
            .prepare(`INSERT INTO tasks (
                    title, body, status, priority, labels_json, automation_json,
                    assignee, created_at, updated_at
                ) VALUES (?, '', 'done', 'high', ?, ?, 'mira-2026', ?, ?)`)
            .run(
                "Coverage completed heartbeat task",
                JSON.stringify(["done", "priority-high"]),
                JSON.stringify({
                    type: "cron",
                    recurring: true,
                    cronJobId: "item-cron",
                }),
                heartbeatTimestamp,
                heartbeatTimestamp
            );
        database
            .prepare(`INSERT INTO scheduled_job_runs (
                    job_id, status, trigger_type, started_at, finished_at, message,
                    output_json
                ) VALUES (?, 'failed', 'schedule', ?, ?, ?, '{}')`)
            .run(
                "coverage.workspace-sync",
                heartbeatTimestamp,
                "2026-07-20T10:00:01.000Z",
                "Refusing to push unrelated local commits"
            );
        cleanupCallbacks.push(() => {
            database
                .prepare(
                    "DELETE FROM scheduled_job_runs WHERE job_id = 'coverage.workspace-sync'"
                )
                .run();
            database
                .prepare(
                    "DELETE FROM scheduled_jobs WHERE id = 'coverage.workspace-sync'"
                )
                .run();
        });
        const cacheHeartbeat = await cacheRoutes["/api/cache/heartbeat"].GET();
        const cacheHeartbeatText = await cacheHeartbeat.text();
        const cacheHeartbeatJson = JSON.parse(cacheHeartbeatText) as {
            count: number;
            cronJobs: {
                dataAvailable: boolean;
                items: Array<Record<string, unknown>>;
            };
            dashboardJobs: Array<Record<string, unknown>>;
            schemaVersion: number;
            entries: Record<
                string,
                {
                    data?: unknown;
                    key?: string;
                }
            >;
            tasks: Array<Record<string, unknown>>;
        };
        expect(cacheHeartbeatJson).toMatchObject({
            count: expect.any(Number),
            cronJobs: {
                dataAvailable: true,
                items: [
                    expect.objectContaining({
                        disableIntent: {
                            mode: "indefinite",
                            comment: "Paused during chat work",
                        },
                        enabled: false,
                        id: "item-cron",
                        lastRunStatus: "ok",
                    }),
                ],
            },
            schemaVersion: 3,
            entries: expect.arrayContaining([
                expect.objectContaining({
                    consecutiveFailures: 2,
                    data: null,
                    key: "route.string",
                    meta: {},
                }),
            ]),
        });
        const workspaceSyncJob = cacheHeartbeatJson.dashboardJobs.find(
            (job) => job.id === "coverage.workspace-sync"
        );
        expect(workspaceSyncJob).toMatchObject({
            disableIntent: {
                mode: "indefinite",
                comment: "Paused during maintenance",
            },
            lastRun: {
                message: "Refusing to push unrelated local commits",
                status: "failed",
            },
        });
        const heartbeatTask = cacheHeartbeatJson.tasks.find(
            (task) => task.title === "Coverage heartbeat task"
        );
        expect(heartbeatTask).toMatchObject({
            automation: {
                cronJobId: "item-cron",
            },
        });
        expect(heartbeatTask?.automation).not.toHaveProperty("disableIntent");
        expect(heartbeatTask?.automation).not.toHaveProperty("enabled");
        expect(cacheHeartbeatJson.cronJobs.items[0]).not.toHaveProperty("taskNumbers");
        expect(heartbeatTask?.number).toEqual(expect.any(Number));
        expect(
            cacheHeartbeatJson.tasks.find(
                (task) => task.title === "Coverage completed heartbeat task"
            )
        ).toBeUndefined();
        const cacheStatus = cacheRoutes["/api/cache/status"].GET();
        expect(cacheStatus.json()).resolves.toMatchObject({
            count: expect.any(Number),
            entries: expect.arrayContaining([
                expect.objectContaining({
                    consecutiveFailures: 2,
                    data: null,
                    key: "route.string",
                    meta: {},
                }),
            ]),
        });
        const missingCache = cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/", {
                key: "",
            })
        );
        expect(missingCache.status).toBe(400);
        const stringCache = cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/route.string", {
                key: "route.string",
            })
        );
        expect(stringCache.json()).resolves.toMatchObject({
            data: "raw-value",
            errorCode: null,
            errorMessage: null,
            key: "route.string",
            meta: {},
        });
        const unknownCache = cacheRoutes["/api/cache/:key"].GET(
            requestWithParameters("/api/cache/nope", {
                key: "nope",
            })
        );
        expect(unknownCache.status).toBe(404);
        const missingCacheRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            requestWithParameters("/api/cache//refresh", {
                key: "",
            })
        );
        expect(missingCacheRefresh.json()).resolves.toEqual(
            apiErrorExpectation("Missing cache key")
        );
        expect(missingCacheRefresh.status).toBe(400);
        const unknownCacheRefresh = await cacheRoutes["/api/cache/:key/refresh"].POST(
            requestWithParameters("/api/cache/nope/refresh", {
                key: "nope",
            })
        );
        expect(unknownCacheRefresh.json()).resolves.toEqual(
            apiErrorExpectation(
                "No backend refresh producer configured for cache key: nope"
            )
        );
        expect(unknownCacheRefresh.status).toBe(400);
        const backupStatus = backupRoutes["/api/backups/kopia"].GET();
        expect(backupStatus.json()).resolves.toEqual({
            job: undefined,
        });
        const missingJob = jobRoutes["/api/jobs/:id"].GET(
            requestWithParameters("/api/jobs/missing-route-job", {
                id: "missing-route-job",
            })
        );
        expect(missingJob.status).toBe(404);
        expect(missingJob.json()).resolves.toEqual(
            apiErrorExpectation("Scheduled job not found")
        );
        const malformedJobPatch = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                "/api/jobs/missing-route-job",
                {
                    id: "missing-route-job",
                },
                {
                    body: "{",
                    method: "PATCH",
                }
            )
        );
        expect(malformedJobPatch.status).toBe(400);
        const invalidJobPatchBody = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                "/api/jobs/missing-route-job",
                {
                    id: "missing-route-job",
                },
                {
                    body: JSON.stringify({
                        patch: [],
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(invalidJobPatchBody.status).toBe(400);
        const invalidJobPatchField = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                "/api/jobs/missing-route-job",
                {
                    id: "missing-route-job",
                },
                {
                    body: JSON.stringify({
                        patch: {
                            enabled: "yes",
                        },
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(invalidJobPatchField.status).toBe(400);
        expect(invalidJobPatchField.json()).resolves.toMatchObject(
            apiErrorExpectation(
                expect.stringContaining("body.patch.enabled"),
                "invalid_request"
            )
        );
        const missingJobRun = jobRoutes["/api/jobs/:id/run"].POST(
            requestWithParameters("/api/jobs/missing-route-job/run", {
                id: "missing-route-job",
            })
        );
        expect(missingJobRun.status).toBe(404);
        const missingJobRuns = jobRoutes["/api/jobs/:id/runs"].GET(
            requestWithParameters("/api/jobs/missing-route-job/runs", {
                id: "missing-route-job",
            })
        );
        expect(missingJobRuns.status).toBe(404);
        const terminalComplete = await terminalRoutes["/api/terminal/complete"].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: terminalRoot,
                partial: "echo work",
            })
        );
        expect(terminalComplete.json()).resolves.toMatchObject({
            commonPrefix: "echo work",
            completions: [
                {
                    completion: String.raw`echo work\ dir`,
                    display: "work dir/",
                    type: "directory",
                },
                {
                    completion: "echo work-bin",
                    display: "work-bin",
                    type: "executable",
                },
                {
                    completion: String.raw`echo work\ file.txt`,
                    display: "work file.txt",
                    type: "file",
                },
            ],
        });
        const invalidTerminalComplete = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: "relative",
                partial: "work",
            })
        );
        expect(invalidTerminalComplete.status).toBe(400);
        const malformedTerminalComplete = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            new Request("https://test.local/api/terminal/complete", {
                body: "{",
                method: "POST",
            })
        );
        expect(malformedTerminalComplete.status).toBe(400);
        const missingTerminalCompleteBody = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(jsonRequest("/api/terminal/complete", []));
        expect(missingTerminalCompleteBody.status).toBe(400);
        const invalidTerminalPartial = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: terminalRoot,
                partial: "bad\0partial",
            })
        );
        expect(invalidTerminalPartial.status).toBe(400);
        const missingDirectoryCompletion = await terminalRoutes[
            "/api/terminal/complete"
        ].POST(
            jsonRequest("/api/terminal/complete", {
                cwd: terminalRoot,
                partial: "missing/",
            })
        );
        expect(missingDirectoryCompletion.json()).resolves.toEqual({
            commonPrefix: "",
            completions: [],
        });
        const terminalCdFile = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalRoot,
                path: "work file.txt",
            })
        );
        expect(terminalCdFile.status).toBe(400);
        expect(terminalCdFile.json()).resolves.toMatchObject({
            error: {
                code: "bad_request",
                message: "Not a directory: work file.txt",
                requestId: expect.any(String),
            },
        });
        const terminalCdHome = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalRoot,
                path: "~",
            })
        );
        expect(terminalCdHome.json()).resolves.toMatchObject({
            newCwd: expect.any(String),
        });
        const terminalCdNormalized = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalDirectory,
                path: "../work dir/.",
            })
        );
        expect(terminalCdNormalized.json()).resolves.toEqual({
            newCwd: terminalDirectory,
        });
        const malformedTerminalCd = await terminalRoutes["/api/terminal/cd"].POST(
            new Request("https://test.local/api/terminal/cd", {
                body: "{",
                method: "POST",
            })
        );
        expect(malformedTerminalCd.status).toBe(400);
        const invalidTerminalCd = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: "relative",
                path: "work dir",
            })
        );
        expect(invalidTerminalCd.status).toBe(400);
        const missingTerminalCd = await terminalRoutes["/api/terminal/cd"].POST(
            jsonRequest("/api/terminal/cd", {
                cwd: terminalRoot,
                path: "missing",
            })
        );
        expect(missingTerminalCd.status).toBe(400);
        const invalidContainer = await dockerRoutes[
            "/api/docker/containers/:containerId"
        ].GET(
            requestWithParameters("/api/docker/containers/--bad", {
                containerId: "--bad",
            })
        );
        expect(invalidContainer.status).toBe(400);
        const invalidAction = await dockerRoutes[
            "/api/docker/containers/:containerId/action"
        ].POST(
            requestWithParameters(
                "/api/docker/containers/abc/action",
                {
                    containerId: "abc",
                },
                {
                    body: JSON.stringify({
                        action: "destroy",
                    }),
                    method: "POST",
                }
            )
        );
        expect(invalidAction.status).toBe(400);
        const missingExec = dockerRoutes["/api/docker/exec/:jobId"].GET(
            requestWithParameters("/api/docker/exec/missing", {
                jobId: "missing",
            })
        );
        expect(missingExec.status).toBe(404);
        const invalidExecStart = await dockerRoutes["/api/docker/exec/start"].POST(
            jsonRequest("/api/docker/exec/start", {
                command: "",
                containerId: "",
            })
        );
        expect(invalidExecStart.status).toBe(400);
        const invalidPrune = await dockerRoutes["/api/docker/prune"].POST(
            jsonRequest("/api/docker/prune", {
                target: "networks",
            })
        );
        expect(invalidPrune.status).toBe(400);
        const malformedPrune = await dockerRoutes["/api/docker/prune"].POST(
            new Request("https://test.local/api/docker/prune", {
                body: "{",
                method: "POST",
            })
        );
        expect(malformedPrune.status).toBe(400);
        const invalidStackActionBody = await dockerRoutes[
            "/api/docker/stack/action"
        ].POST(jsonRequest("/api/docker/stack/action", []));
        expect(invalidStackActionBody.status).toBe(400);
        const invalidStackAction = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", {
                action: "reload",
            })
        );
        expect(invalidStackAction.status).toBe(400);
        const invalidStackService = await dockerRoutes["/api/docker/stack/action"].POST(
            jsonRequest("/api/docker/stack/action", {
                action: "restart",
                service: "--bad",
            })
        );
        expect(invalidStackService.status).toBe(400);
        const invalidImageDelete = await dockerRoutes[
            "/api/docker/images/:imageId"
        ].DELETE(
            requestWithParameters("/api/docker/images/--bad", {
                imageId: "--bad",
            })
        );
        expect(invalidImageDelete.status).toBe(400);
        const invalidVolumeDelete = await dockerRoutes[
            "/api/docker/volumes/:volumeName"
        ].DELETE(
            requestWithParameters("/api/docker/volumes/--bad", {
                volumeName: "--bad",
            })
        );
        expect(invalidVolumeDelete.status).toBe(400);
        const invalidUpdater = await dockerRoutes[
            "/api/docker/updater/services/:serviceId/update"
        ].POST(
            requestWithParameters("/api/docker/updater/services/not-number/update", {
                serviceId: "not-number",
            })
        );
        expect(invalidUpdater.status).toBe(400);
        database
            .prepare(`INSERT INTO docker_managed_services (
                    app_slug,
                    service_name,
                    compose_path,
                    image_repo,
                    compose_image_ref,
                    current_tag,
                    current_digest,
                    latest_tag,
                    latest_digest,
                    policy,
                    pin_mode,
                    enabled,
                    metadata_json,
                    last_checked_at,
                    last_updated_at,
                    last_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                "coverage-app",
                "api",
                "/tmp/compose.yml",
                "example/api",
                "example/api:1.0",
                "1.0",
                "sha256:old",
                "1.1",
                "sha256:new",
                "notify",
                "tag",
                1,
                '{"source":"test"}',
                "2026-06-25T10:00:00.000Z",
                "2026-06-25T11:00:00.000Z",
                "auto_update_failed"
            );
        const updaterServiceId = Number(
            (
                database
                    .prepare(
                        "SELECT id FROM docker_managed_services WHERE app_slug = 'coverage-app' AND service_name = 'api'"
                    )
                    .get() as {
                    id: number;
                }
            ).id
        );
        database
            .prepare(`INSERT INTO docker_update_events (
                    managed_service_id,
                    app_slug,
                    service_name,
                    event_type,
                    from_tag,
                    to_tag,
                    from_digest,
                    to_digest,
                    message,
                    details_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                updaterServiceId,
                "",
                "",
                "update_available",
                "1.0",
                "1.1",
                "sha256:old",
                "sha256:new",
                "candidate found",
                "{}",
                "2026-06-25T12:00:00.000Z"
            );
        cleanupCallbacks.push(() => {
            database
                .prepare(
                    "DELETE FROM docker_update_events WHERE managed_service_id = ? OR app_slug = 'coverage-app'"
                )
                .run(updaterServiceId);
            database
                .prepare(
                    "DELETE FROM docker_managed_services WHERE app_slug = 'coverage-app'"
                )
                .run();
        });
        const updaterServices = dockerRoutes["/api/docker/updater/services"].GET();
        expect(updaterServices.json()).resolves.toMatchObject({
            services: [
                expect.objectContaining({
                    appSlug: "coverage-app",
                    enabled: true,
                    metadata: {
                        source: "test",
                    },
                    serviceName: "api",
                    updateAvailable: true,
                }),
            ],
            summary: expect.objectContaining({
                enabled: 1,
                failed: 1,
                notifyPolicy: 1,
                total: 1,
                updateAvailable: 1,
            }),
        });
        const updaterEvents = dockerRoutes["/api/docker/updater/events"].GET(
            new Request("https://test.local/api/docker/updater/events?limit=500")
        );
        expect(updaterEvents.json()).resolves.toMatchObject({
            events: [
                expect.objectContaining({
                    appSlug: "coverage-app",
                    eventType: "update_available",
                    fromTag: "1.0",
                    managedServiceId: updaterServiceId,
                    serviceName: "api",
                    toTag: "1.1",
                }),
            ],
        });
        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        rememberEnvironment("MIRA_DOCKER_UPDATER_SKIP_REGISTRY");
        process.env.MIRA_DOCKER_APPS_ROOT = path.join(
            terminalRoot,
            "missing-docker-apps"
        );
        process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY = "1";
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM scheduled_job_runs WHERE job_id = 'docker.updater'")
                .run();
            database
                .prepare("DELETE FROM scheduled_jobs WHERE id = 'docker.updater'")
                .run();
        });
        const { registerDockerUpdaterScheduledJobs } =
            await import("../../src/services/dockerUpdater/scheduler.ts");
        registerDockerUpdaterScheduledJobs();
        await startTestScheduledExecutor();
        const updaterRun = await dockerRoutes["/api/docker/updater/run"].POST(
            new Request("https://test.local/api/docker/updater/run", {
                method: "POST",
            })
        );
        expect(updaterRun.status).toBe(200);
        expect(updaterRun.json()).resolves.toMatchObject({
            isSuccess: false,
            steps: [
                expect.objectContaining({
                    isOk: false,
                    stderr: expect.stringContaining("Compose apps root not found"),
                    step: "register-services",
                }),
            ],
        });
        const updaterRunRow = database
            .prepare(
                "SELECT status FROM scheduled_job_runs WHERE job_id = 'docker.updater' ORDER BY id DESC LIMIT 1"
            )
            .get() as
            | {
                  status?: string;
              }
            | undefined;
        expect(updaterRunRow).toEqual({
            status: "failed",
        });
        const missingUpdaterService = await dockerRoutes[
            "/api/docker/updater/services/:serviceId/update"
        ].POST(
            requestWithParameters("/api/docker/updater/services/999999/update", {
                serviceId: "999999",
            })
        );
        expect(missingUpdaterService.status).toBe(404);
        const cronList = await cronRoutes["/api/cron/jobs"].GET();
        expect(cronList.json()).resolves.toEqual({
            jobs: [
                {
                    disableIntent: {
                        mode: "indefinite",
                        comment: "Paused during chat work",
                    },
                    enabled: false,
                    id: "item-cron",
                    name: "Coverage cron",
                    state: {
                        lastRunAtMs: 1_721_465_940_000,
                        lastRunStatus: "ok",
                    },
                    taskLinks: [
                        {
                            number: expect.any(Number),
                            title: "Coverage heartbeat task",
                        },
                    ],
                },
            ],
        });
        const badCronToggleBody = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/toggle",
                {
                    id: "item-cron",
                },
                {
                    body: "null",
                    method: "POST",
                }
            )
        );
        expect(badCronToggleBody.status).toBe(400);
        const badCronToggleValue = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/toggle",
                {
                    id: "item-cron",
                },
                {
                    body: JSON.stringify({
                        enabled: "yes",
                    }),
                    method: "POST",
                }
            )
        );
        expect(badCronToggleValue.status).toBe(400);
        const routeConfusingCronId = await cronRoutes["/api/cron/jobs/:id/run"].POST(
            requestWithParameters("/api/cron/jobs/victim/delete?/run", {
                id: "victim/delete?",
            })
        );
        expect(routeConfusingCronId.status).toBe(400);
        expect(routeConfusingCronId.json()).resolves.toEqual(
            apiErrorExpectation("Invalid cron job ID", "invalid_cron_job_id")
        );
        const failedCronRun = await cronRoutes["/api/cron/jobs/:id/run"].POST(
            requestWithParameters("/api/cron/jobs/item-cron/run", {
                id: "item-cron",
            })
        );
        expect(failedCronRun.status).toBe(502);
        expect(failedCronRun.json()).resolves.toEqual(
            apiErrorExpectation("gateway failed for cron.run")
        );
        const badCronUpdateBody = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/update",
                {
                    id: "item-cron",
                },
                {
                    body: JSON.stringify([]),
                    method: "POST",
                }
            )
        );
        expect(badCronUpdateBody.status).toBe(400);
        const badCronUpdatePatch = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            requestWithParameters(
                "/api/cron/jobs/item-cron/update",
                {
                    id: "item-cron",
                },
                {
                    body: JSON.stringify({}),
                    method: "POST",
                }
            )
        );
        expect(badCronUpdatePatch.status).toBe(400);
        for (const [route, handler] of [
            ["/api/moltbook/home", moltbookRoutes["/api/moltbook/home"].GET],
            [
                "/api/moltbook/feed?sort=new",
                (request?: Request) =>
                    moltbookRoutes["/api/moltbook/feed"].GET(
                        request ?? new Request("https://test.local/api/moltbook/feed")
                    ),
            ],
            ["/api/moltbook/profile", moltbookRoutes["/api/moltbook/profile"].GET],
            ["/api/moltbook/my-posts", moltbookRoutes["/api/moltbook/my-posts"].GET],
        ] as const) {
            const response = handler(new Request(`https://test.local${route}`));
            expect(response.status).toBe(503);
            expect(response.json()).resolves.toEqual(
                apiErrorExpectation(expect.any(String))
            );
        }
        for (const [route, handler] of [
            [
                "/api/pull-requests/:number/approve",
                pullRequestRoutes["/api/pull-requests/:number/approve"].POST,
            ],
            [
                "/api/pull-requests/:number/reject",
                pullRequestRoutes["/api/pull-requests/:number/reject"].POST,
            ],
            [
                "/api/pull-requests/:number/review-approval",
                pullRequestRoutes["/api/pull-requests/:number/review-approval"].POST,
            ],
            [
                "/api/pull-requests/:number/update-branch",
                pullRequestRoutes["/api/pull-requests/:number/update-branch"].POST,
            ],
        ] as const) {
            const response = await handler(
                requestWithParameters(route.replace(":number", "bad"), {
                    number: "bad",
                })
            );
            expect(response.status).toBe(400);
        }
        const invalidPullRequestStack = await pullRequestRoutes[
            "/api/pull-requests/stacks"
        ].POST(
            new Request("https://test.local/api/pull-requests/stacks", {
                body: JSON.stringify({
                    pullRequests: [1],
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "POST",
            })
        );
        expect(invalidPullRequestStack.status).toBe(400);
    });
    it("aggregates metrics tokens by model, display label, and session type", async () => {
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const getSessionsSpy = jest.spyOn(gateway, "getSessions").mockReturnValue([
            {
                displayLabel: "Main chat",
                label: "main",
                model: "openai/gpt-5.5",
                tokenCount: 120,
                type: "chat",
            },
            {
                displayLabel: "",
                label: "coder",
                model: "anthropic/claude-sonnet",
                tokenCount: 80,
                type: "agent",
            },
            {
                displayLabel: "Untyped",
                label: "fallback",
                model: "",
                tokenCount: 5,
                type: "",
            },
        ] as ReturnType<typeof gateway.getSessions>);
        cleanupCallbacks.push(() => getSessionsSpy.mockRestore());
        const { metricsRoutes } = await import("../../src/routes/metricsRoutes.ts");
        const response = await metricsRoutes["/api/metrics"].GET();
        expect(response.status).toBe(200);
        expect(response.json()).resolves.toMatchObject({
            polling: {
                snapshots: expect.arrayContaining([
                    expect.objectContaining({
                        activeLoads: 1,
                        loads: 1,
                        name: "system.metrics",
                        requests: 1,
                    }),
                ]),
            },
            processes: expect.objectContaining({
                active: expect.any(Number),
                failed: expect.any(Number),
                started: expect.any(Number),
                succeeded: expect.any(Number),
            }),
            tokens: {
                byAgent: [
                    {
                        label: "Main chat",
                        model: "openai/gpt-5.5",
                        tokens: 120,
                        type: "chat",
                    },
                    {
                        label: "coder",
                        model: "anthropic/claude-sonnet",
                        tokens: 80,
                        type: "agent",
                    },
                    {
                        label: "Untyped",
                        model: "unknown",
                        tokens: 5,
                        type: "Unknown",
                    },
                ],
                byModel: {
                    "anthropic/claude-sonnet": 80,
                    "openai/gpt-5.5": 120,
                    unknown: 5,
                },
                sessionsByModel: {
                    "claude-sonnet": 1,
                    "gpt-5.5": 1,
                    unknown: 1,
                },
                total: 205,
            },
        });
    });
});
