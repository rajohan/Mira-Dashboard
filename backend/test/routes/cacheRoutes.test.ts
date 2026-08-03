import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SystemHostSummary } from "../../../contracts/system.ts";
import { requestUrl } from "../../../test/support/fetch.ts";
import { database } from "../../src/database/connection.ts";
import { startTestScheduledJobExecutor } from "../support/scheduledJobExecutor.ts";
import { captureStructuredLogs } from "../support/structuredLogCapture.ts";
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
describe("backend cache and scheduler routes", () => {
    it("cached quota/system readers and notification checks", async () => {
        const { TASK_ASSIGNEE_IDS, TASK_ASSIGNEES } =
            await import("../../../contracts/tasks.ts");
        const { writeCacheSuccess } =
            await import("../../src/services/cacheEntryWriter.ts");
        const { fetchCachedQuotas, hasQuotaStatus } =
            await import("../../src/lib/quotasCache.ts");
        const { fetchCachedSystemHost } = await import("../../src/lib/systemCache.ts");
        const { evaluateQuotaNotifications } =
            await import("../../src/services/quotaNotifications.ts");
        const { evaluateOpenClawNotifications } =
            await import("../../src/services/openclawNotifications.ts");
        expect(TASK_ASSIGNEE_IDS).toContain(TASK_ASSIGNEES.mira.id);
        expect(
            hasQuotaStatus({
                status: "not_configured",
            })
        ).toBe(true);
        expect(
            hasQuotaStatus({
                status: "fresh",
            })
        ).toBe(false);
        expect(() => fetchCachedQuotas()).toThrow("Quota cache entry");
        expect(() => fetchCachedSystemHost()).toThrow("System host cache entry");
        const checkedAt = Date.now() - 1000;
        writeCacheSuccess({
            key: "quotas.summary",
            data: {
                checkedAt,
                cacheAgeMs: 0,
                openrouter: {
                    percentUsed: 91,
                    remaining: 4.25,
                    totalCredits: 100,
                    usage: 95.75,
                    usageMonthly: 95.75,
                },
                elevenlabs: {
                    percentUsed: 70,
                    remaining: 3000,
                    resetAt: undefined,
                    tier: "starter",
                    total: 10_000,
                    used: 7000,
                },
                synthetic: {
                    rollingFiveHourLimit: {
                        limited: false,
                        max: 100,
                        nextTickAt: undefined,
                        percentUsed: 96,
                        remaining: 4,
                    },
                    searchHourly: {
                        limit: 20,
                        percentUsed: 10,
                        remaining: 18,
                        renewsAt: undefined,
                        requests: 2,
                    },
                    subscription: {
                        limit: 100,
                        percentUsed: 50,
                        remaining: 50,
                        renewsAt: undefined,
                        requests: 50,
                    },
                    weeklyTokenLimit: {
                        nextRegenAt: undefined,
                        percentRemaining: 6,
                    },
                },
                openai: {
                    account: "codex",
                    fiveHourLeftPercent: 9,
                    fiveHourReset: undefined,
                    model: "gpt",
                    percentUsed: 91,
                    resetAt: undefined,
                    weeklyLeftPercent: 8,
                    weeklyReset: undefined,
                },
            },
            metadata: {
                source: "test",
            },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });
        const quotas = fetchCachedQuotas();
        expect(quotas.cacheAgeMs).toBeGreaterThanOrEqual(0);
        evaluateQuotaNotifications(quotas);
        const quotaNotifications = database
            .prepare(
                "SELECT title FROM notifications WHERE source = 'quota' ORDER BY title"
            )
            .all() as Array<{
            title: string;
        }>;
        expect(quotaNotifications.map((row) => row.title)).toEqual([
            "OpenAI / Codex usage high (80%)",
            "OpenAI / Codex usage high (90%)",
            "OpenRouter usage high (80%)",
            "OpenRouter usage high (90%)",
            "Synthetic.new usage high (80%)",
            "Synthetic.new usage high (90%)",
            "Synthetic.new usage high (95%)",
        ]);
        database
            .prepare(
                "UPDATE notifications SET is_read = 1 WHERE dedupe_key = 'quota:openrouter:80'"
            )
            .run();
        evaluateQuotaNotifications({
            ...quotas,
            checkedAt: checkedAt + 1,
            openrouter: {
                ...quotas.openrouter,
                percentUsed: 70,
            },
        });
        evaluateQuotaNotifications({
            ...quotas,
            checkedAt: checkedAt + 2,
            openrouter: {
                ...quotas.openrouter,
                percentUsed: 91,
            },
        });
        expect(
            database
                .prepare(
                    "SELECT is_read FROM notifications WHERE dedupe_key = 'quota:openrouter:80'"
                )
                .get()
        ).toEqual({
            is_read: 0,
        });
        const systemHostPayload = {
            checkedAt: "2026-06-25T10:00:00.000Z",
            disk: {
                percent: 50,
                totalBytes: 200,
                usedBytes: 100,
            },
            hostname: "test-host",
            memory: {
                freeBytes: 100,
                freeMb: 1,
                totalBytes: 200,
                usedBytes: 100,
            },
            platform: "linux",
            uptimeSeconds: 60,
            version: {
                checkedAt,
                current: "1.0.0",
                latest: "1.1.0",
                updateAvailable: true,
            },
        } satisfies SystemHostSummary;
        writeCacheSuccess({
            key: "system.host",
            data: systemHostPayload,
            metadata: {
                source: "test",
            },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });
        const systemHost = fetchCachedSystemHost();
        expect(systemHost.data).toEqual(systemHostPayload);
        expect(systemHost.meta).toEqual({
            source: "test",
        });
        evaluateOpenClawNotifications(systemHost.data);
        const openClawNotification = database
            .prepare(
                "SELECT title, description FROM notifications WHERE source = 'openclaw' LIMIT 1"
            )
            .get() as
            | {
                  description: string;
                  title: string;
              }
            | undefined;
        expect(openClawNotification).toEqual({
            description: "Current 1.0.0 \u{2192} latest 1.1.0.",
            title: "OpenClaw update available",
        });
        writeCacheSuccess({
            key: "system.host",
            data: {
                checkedAt: "2026-06-25T11:00:00.000Z",
                version: {
                    checkedAt,
                    current: "1.1.0",
                    latest: "1.1.0",
                    updateAvailable: false,
                },
            },
            metadata: {
                source: "test",
            },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });
        evaluateOpenClawNotifications({
            version: {
                checkedAt,
                current: "1.1.0",
                latest: "1.1.0",
                updateAvailable: false,
            },
        });
        writeCacheSuccess({
            key: "system.host",
            data: {
                checkedAt: "2026-06-25T12:00:00.000Z",
            },
            metadata: {
                source: "test",
            },
            source: "coverage",
            ttl: 1,
            ttlUnit: "hours",
        });
        const structuredLogs = captureStructuredLogs();
        try {
            evaluateOpenClawNotifications({});
            expect(structuredLogs.entries).toContainEqual(
                expect.objectContaining({
                    component: "openclaw-notifications",
                    event: "openclaw_notifications.check_failed",
                    level: "error",
                })
            );
        } finally {
            structuredLogs.stop();
        }
    });
    it("refreshes Moltbook cache entries through normalized API responses", async () => {
        rememberEnvironment("MOLTBOOK_API_KEY");
        process.env.MOLTBOOK_API_KEY = "test-key";
        const originalFetch = fetch;
        cleanupCallbacks.push(() => {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
        });
        const requestedUrls: string[] = [];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: (input: Parameters<typeof fetch>[0]) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    requestedUrls.push(url);
                    let body: unknown;
                    if (url.includes("/agents/profile")) {
                        body = {
                            agent: {
                                name: "mira_2026",
                            },
                            recentComments: [
                                {
                                    id: "comment-1",
                                },
                            ],
                            recentPosts: [
                                {
                                    id: "post-2",
                                },
                            ],
                        };
                    }
                    if (url.includes("/feed?sort=new")) {
                        body = {
                            feed_filter: "latest",
                            posts: [
                                {
                                    id: "new-1",
                                },
                            ],
                        };
                    }
                    if (url.includes("/feed?sort=hot")) {
                        body = {
                            feed_type: "hot",
                            has_more: true,
                            posts: [
                                {
                                    id: "hot-1",
                                },
                            ],
                            tip: "hot tip",
                        };
                    }
                    if (url.endsWith("/home")) {
                        body = {
                            your_direct_messages: {
                                pending_request_count: "2",
                                unread_message_count: 3,
                            },
                            activity_on_your_posts: [
                                {
                                    id: "activity",
                                },
                            ],
                            what_to_do_next: ["reply"],
                            latest_moltbook_announcement: {
                                author_name: "Moltbook",
                                created_at: "2026-06-25T10:00:00Z",
                                post_id: "post-1",
                                preview: "Hello",
                                title: "News",
                            },
                            posts_from_accounts_you_follow: [
                                {
                                    id: "followed",
                                },
                            ],
                            explore: [
                                {
                                    id: "explore",
                                },
                            ],
                        };
                    }
                    if (!body) {
                        return new Response("not found", {
                            status: 404,
                        });
                    }
                    return Response.json(body);
                });
            },
            writable: true,
        });
        const { refreshCacheProducer, refreshMoltbookCache } = await Promise.all([
            import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts"),
            import("../../src/services/cacheRefresh/moltbookCacheProducer.ts"),
        ]).then(([module0, module1]) => ({
            refreshCacheProducer: module0.refreshCacheProducer,
            refreshMoltbookCache: module1.refreshMoltbookCache,
        }));
        expect(refreshMoltbookCache()).resolves.toEqual({
            refreshed: [
                "moltbook.home",
                "moltbook.feed.hot",
                "moltbook.feed.new",
                "moltbook.profile",
                "moltbook.my-content",
            ],
        });
        expect(refreshCacheProducer("moltbook.feed.hot")).resolves.toEqual({
            refreshed: ["moltbook.feed.hot"],
        });
        expect(requestedUrls).toEqual(
            expect.arrayContaining([
                "https://www.moltbook.com/api/v1/home",
                "https://www.moltbook.com/api/v1/feed?sort=hot&limit=25",
                "https://www.moltbook.com/api/v1/feed?sort=new&limit=25",
                "https://www.moltbook.com/api/v1/agents/profile?name=mira_2026",
            ])
        );
        const rows = database
            .prepare(
                "SELECT key, data_json, source FROM cache_entries WHERE key LIKE 'moltbook.%' ORDER BY key"
            )
            .all() as Array<{
            data_json: string;
            key: string;
            source: string;
        }>;
        expect(rows.map((row) => row.key)).toEqual([
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.home",
            "moltbook.my-content",
            "moltbook.profile",
        ]);
        expect(rows.every((row) => row.source === "moltbook-api")).toBe(true);
        const home = JSON.parse(
            rows.find((row) => row.key === "moltbook.home")?.data_json ?? "{}"
        ) as Record<string, unknown>;
        expect(home).toMatchObject({
            activityOnYourPostsCount: 1,
            exploreCount: 1,
            pendingRequestCount: 2,
            unreadMessageCount: 3,
        });
        const profile = JSON.parse(
            rows.find((row) => row.key === "moltbook.profile")?.data_json ?? "{}"
        ) as Record<string, unknown>;
        expect(profile).toEqual({
            agent: {
                name: "mira_2026",
            },
        });
    });
    it("refreshes backup and log-rotation cache producers through fake CLI output", async () => {
        rememberEnvironment("MIRA_DOCKER_BIN");
        const binRoot = createTemporaryRoot("mira-cache-cli-");
        const now = new Date().toISOString();
        const dockerBin = path.join(binRoot, "docker");
        writeExecutable(
            dockerBin,
            `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == "exec kopia kopia snapshot list --all --json-verbose --json" ]]; then
  cat <<'JSON'
[
  {"id":"snap-docker","source":{"path":"/source/docker"},"stats":{"fileCount":2,"totalSize":200,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]},
  {"id":"snap-openclaw","source":{"path":"/source/openclaw"},"stats":{"fileCount":3,"totalSize":300,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]},
  {"id":"snap-projects","source":{"path":"/source/projects"},"stats":{"fileCount":4,"totalSize":400,"errorCount":0,"ignoredErrorCount":0},"startTime":"${now}","endTime":"${now}","retentionReason":["latest"]}
]
JSON
elif [[ "$args" == "exec walg wal-g backup-list --detail --json" ]]; then
  cat <<'JSON'
[
  {"backup_name":"base_0001","finish_time":"${now}","start_time":"${now}","wal_file_name":"000000010000000000000001","storage_name":"default"}
]
JSON
else
  echo "unexpected docker args: $*" >&2
  exit 2
fi
`
        );
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        database
            .prepare(
                "DELETE FROM cache_entries WHERE key IN ('backup.kopia.status', 'backup.walg.status', 'log_rotation.state')"
            )
            .run();
        async function refreshWithFakeDocker(key: string) {
            let lastError: unknown;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    process.env.MIRA_DOCKER_BIN = dockerBin;
                    return await refreshCacheProducer(key);
                } catch (error) {
                    lastError = error;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            }
            throw lastError;
        }
        expect(refreshWithFakeDocker("backup.kopia.status")).resolves.toEqual({
            refreshed: ["backup.kopia.status"],
        });
        expect(refreshWithFakeDocker("backup.walg.status")).resolves.toEqual({
            refreshed: ["backup.walg.status"],
        });
        expect(refreshCacheProducer("log_rotation.state")).resolves.toEqual({
            refreshed: ["log_rotation.state"],
        });
        const rows = database
            .prepare(
                "SELECT key, data_json, status FROM cache_entries WHERE key IN ('backup.kopia.status', 'backup.walg.status', 'log_rotation.state') ORDER BY key"
            )
            .all() as Array<{
            data_json: string;
            key: string;
            status: string;
        }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["backup.kopia.status", "fresh"],
            ["backup.walg.status", "fresh"],
            ["log_rotation.state", "fresh"],
        ]);
        const kopia = JSON.parse(
            rows.find((row) => row.key === "backup.kopia.status")?.data_json ?? "{}"
        ) as {
            isOk?: boolean;
            latest?: unknown[];
            stale?: unknown[];
        };
        expect(kopia).toMatchObject({
            isOk: true,
            latest: expect.arrayContaining([
                expect.objectContaining({
                    path: "/source/docker",
                }),
                expect.objectContaining({
                    path: "/source/openclaw",
                }),
                expect.objectContaining({
                    path: "/source/projects",
                }),
            ]),
            stale: [],
        });
        const walg = JSON.parse(
            rows.find((row) => row.key === "backup.walg.status")?.data_json ?? "{}"
        ) as {
            backupCount?: number;
            isOk?: boolean;
            latest?: {
                backupName?: string;
            };
        };
        expect(walg).toMatchObject({
            backupCount: 1,
            isOk: true,
            latest: {
                backupName: "base_0001",
            },
        });
    });
    it("normalizes nested log-rotation state during cache refresh", async () => {
        const timestamp = "2026-08-01T09:00:00.000Z";
        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES (?, ?, 'test', ?, ?, ?, 'stale', 0, '{}')"
            )
            .run(
                "log_rotation.state",
                JSON.stringify({
                    version: 9,
                    files: {
                        "/valid.log": {
                            ignored: true,
                            lastArchive: "/valid.log.1",
                            lastRotatedAt: timestamp,
                            lastSizeBytes: 42,
                        },
                        "/invalid-record.log": "not-an-object",
                        "/invalid-date.log": {
                            lastRotatedAt: "not-a-date",
                        },
                        "/invalid-size.log": {
                            lastSizeBytes: -1,
                        },
                        "/invalid-archive.log": {
                            lastArchive: " ",
                        },
                    },
                    lastRun: {
                        isOk: true,
                    },
                }),
                timestamp,
                timestamp,
                timestamp
            );
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        const refreshed = await refreshCacheProducer("log_rotation.state");
        expect(refreshed).toEqual({
            refreshed: ["log_rotation.state"],
        });
        const expectedState = {
            version: 1,
            files: {
                "/valid.log": {
                    lastArchive: "/valid.log.1",
                    lastRotatedAt: timestamp,
                    lastSizeBytes: 42,
                },
            },
            lastRun: {
                isOk: true,
            },
        };
        const row = database
            .prepare(
                "SELECT data_json FROM cache_entries WHERE key = 'log_rotation.state'"
            )
            .get() as {
            data_json: string;
        };
        expect(JSON.parse(row.data_json)).toEqual(expectedState);
        const { readLogRotationState } =
            await import("../../src/services/logRotation/state.ts");
        expect(readLogRotationState()).toEqual(expectedState);
    });
    it("refreshes quota cache with isolated missing-provider state", async () => {
        for (const key of [
            "OPENROUTER_API_KEY",
            "ELEVENLABS_API_KEY",
            "SYNTHETIC_API_KEY",
            "CODEX_BIN",
            "QUOTAS_CODEX_HOME",
        ]) {
            rememberEnvironment(key);
            delete process.env[key];
        }
        const codexHome = createTemporaryRoot("mira-quota-codex-home-");
        const codexConfig =
            '[projects."/home/ubuntu/projects"]\ntrust_level = "untrusted"\n';
        writeFileSync(path.join(codexHome, "auth.json"), '{"auth_mode":"test"}\n', {
            mode: 0o600,
        });
        writeFileSync(path.join(codexHome, "config.toml"), codexConfig, {
            mode: 0o600,
        });
        process.env.CODEX_BIN = path.join(codexHome, "missing-codex");
        process.env.QUOTAS_CODEX_HOME = codexHome;
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        expect(refreshCacheProducer("quotas.summary")).resolves.toEqual({
            refreshed: ["quotas.summary"],
        });
        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'quotas.summary' LIMIT 1"
            )
            .get() as
            | {
                  data_json: string;
                  metadata_json: string;
                  status: string;
              }
            | undefined;
        expect(row?.status).toBe("fresh");
        const data = JSON.parse(row?.data_json ?? "{}") as Record<
            string,
            Record<string, unknown>
        >;
        expect(data.openrouter).toEqual({
            status: "not_configured",
        });
        expect(data.elevenlabs).toEqual({
            status: "not_configured",
        });
        expect(data.synthetic).toEqual({
            status: "not_configured",
        });
        expect(["not_configured", "error"]).toContain(String(data.openai?.status));
        const metadata = JSON.parse(row?.metadata_json ?? "{}") as {
            missing?: string[];
        };
        expect(metadata.missing).toEqual(
            expect.arrayContaining(["openrouter", "elevenlabs", "synthetic"])
        );
        expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(
            codexConfig
        );
    });
    it("refreshes system cache through a fake OpenClaw binary", async () => {
        rememberEnvironment("OPENCLAW_BIN");
        const binRoot = createTemporaryRoot("mira-system-cache-bin-");
        const openclawBin = path.join(binRoot, "openclaw");
        writeExecutable(
            openclawBin,
            `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "status --json")
    cat <<'JSON'
{"runtimeVersion":"1.0.0","gateway":{"status":"ok"},"gatewayService":{"active":true},"nodeService":{"active":false},"heartbeat":{"ok":true},"tasks":{"queued":1},"taskAudit":{"stale":0}}
JSON
    ;;
  "update status --json")
    cat <<'JSON'
{"availability":{"latestVersion":"1.1.0"},"update":{"registry":{"latestVersion":"1.1.0"}}}
JSON
    ;;
  "doctor")
    printf '%s' "- WARNING: Gateway clients: informational"
    ;;
  "security audit --json")
    cat <<'JSON'
{"findings":[],"isOk":true}
JSON
    ;;
  *)
    echo "unexpected openclaw args: $*" >&2
    exit 2
    ;;
esac
`
        );
        process.env.OPENCLAW_BIN = openclawBin;
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        expect(refreshCacheProducer("system.host")).resolves.toEqual({
            refreshed: ["system.openclaw", "system.host"],
        });
        const rows = database
            .prepare(
                "SELECT key, data_json, status FROM cache_entries WHERE key IN ('system.openclaw', 'system.host') ORDER BY key"
            )
            .all() as Array<{
            data_json: string;
            key: string;
            status: string;
        }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["system.host", "fresh"],
            ["system.openclaw", "fresh"],
        ]);
        const openclaw = JSON.parse(
            rows.find((row) => row.key === "system.openclaw")?.data_json ?? "{}"
        ) as {
            doctorWarnings?: string[];
            security?: {
                isOk?: boolean;
            };
            version?: {
                latest?: string;
                updateAvailable?: boolean;
            };
        };
        expect(openclaw).toMatchObject({
            doctorWarnings: ["Gateway clients: informational"],
            security: {
                isOk: true,
            },
            version: {
                latest: "1.1.0",
                updateAvailable: true,
            },
        });
        const host = JSON.parse(
            rows.find((row) => row.key === "system.host")?.data_json ?? "{}"
        ) as {
            version?: {
                current?: string;
                latest?: string;
                updateAvailable?: boolean;
            };
        };
        expect(host.version).toMatchObject({
            current: "1.0.0",
            latest: "1.1.0",
            updateAvailable: true,
        });
        expect(
            database
                .prepare(
                    "SELECT title FROM notifications WHERE source = 'openclaw' LIMIT 1"
                )
                .get()
        ).toEqual({
            title: "OpenClaw update available",
        });
    });
    it("cache refresh scheduled job registration preserves disabled jobs", async () => {
        const {
            registerCacheRefreshScheduledJobs,
            seedMissingLocalCacheEntry,
            waitForLocalCacheSeed,
        } = await import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts");
        const { writeCacheSuccess } =
            await import("../../src/services/cacheEntryWriter.ts");
        const { runScheduledJob, upsertScheduledJob } = await Promise.all([
            import("../../src/services/scheduledJobs/enqueue.ts"),
            import("../../src/services/scheduledJobs/repository.ts"),
        ]).then(([module0, module1]) => ({
            runScheduledJob: module0.runScheduledJob,
            upsertScheduledJob: module1.upsertScheduledJob,
        }));
        const jobs = [
            ["cache.weather", "weather.spydeberg"],
            ["cache.quotas", "quotas.summary"],
            ["cache.system", "system.host"],
            ["cache.git", "git.workspace"],
            ["cache.moltbook", "moltbook"],
            ["cache.backup.kopia", "backup.kopia.status"],
            ["cache.backup.walg", "backup.walg.status"],
            ["cache.docker.summary", "docker.summary"],
            ["cache.database.summary", "database.summary"],
        ] as const;
        for (const [id, key] of jobs) {
            upsertScheduledJob({
                id,
                name: `Existing ${id}`,
                description: "Existing disabled cache refresh job.",
                enabled: false,
                scheduleType: "interval",
                intervalSeconds: 123,
                actionKey: "cache.refresh",
                actionPayload: {
                    key,
                },
            });
        }
        registerCacheRefreshScheduledJobs();
        await startTestScheduledExecutor();
        const rows = database
            .prepare(
                "SELECT id, enabled, interval_seconds FROM scheduled_jobs WHERE id LIKE 'cache.%' ORDER BY id"
            )
            .all() as Array<{
            enabled: number;
            id: string;
            interval_seconds: number;
        }>;
        expect(rows).toHaveLength(jobs.length);
        expect(rows.every((row) => row.enabled === 0)).toBe(true);
        expect(rows.every((row) => row.interval_seconds === 123)).toBe(true);
        expect(waitForLocalCacheSeed("weather.spydeberg")).resolves.toBeUndefined();
        const freshKey = `test.cache.fresh.${Bun.randomUUIDv7()}`;
        try {
            writeCacheSuccess({
                data: {
                    isFresh: true,
                },
                key: freshKey,
                metadata: {
                    source: "coverage",
                },
                source: "unit",
                ttl: 10,
                ttlUnit: "minutes",
            });
            seedMissingLocalCacheEntry(freshKey);
            expect(waitForLocalCacheSeed(freshKey)).resolves.toBeUndefined();
            expect(
                database
                    .prepare("SELECT status FROM cache_entries WHERE key = ?")
                    .get(freshKey)
            ).toEqual({
                status: "fresh",
            });
        } finally {
            database.prepare("DELETE FROM cache_entries WHERE key = ?").run(freshKey);
        }
        upsertScheduledJob({
            id: "cache.invalid-payload",
            name: "Invalid cache refresh payload",
            description: "Coverage for cache.refresh payload validation.",
            enabled: false,
            scheduleType: "interval",
            intervalSeconds: 3600,
            actionKey: "cache.refresh",
            actionPayload: {},
        });
        expect(runScheduledJob("cache.invalid-payload")).resolves.toMatchObject({
            jobId: "cache.invalid-payload",
            message:
                "Scheduled cache job cache.invalid-payload is missing actionPayload.key",
            status: "failed",
        });
    });
    it("limits isolated cache jobs and execution to the database-local producer", async () => {
        const { registerCacheRefreshScheduledJobs } =
            await import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts");
        const { runScheduledJob, upsertScheduledJob } = await Promise.all([
            import("../../src/services/scheduledJobs/enqueue.ts"),
            import("../../src/services/scheduledJobs/repository.ts"),
        ]).then(([module0, module1]) => ({
            runScheduledJob: module0.runScheduledJob,
            upsertScheduledJob: module1.upsertScheduledJob,
        }));
        registerCacheRefreshScheduledJobs({
            allowedKeys: ["database.summary"],
            seedStrategy: "none",
        });
        expect(
            database
                .prepare(
                    "SELECT id, enabled FROM scheduled_jobs WHERE action_key = 'cache.refresh' ORDER BY id"
                )
                .all()
        ).toEqual([
            {
                id: "cache.backup.kopia",
                enabled: 0,
            },
            {
                id: "cache.backup.walg",
                enabled: 0,
            },
            {
                id: "cache.database.summary",
                enabled: 1,
            },
            {
                id: "cache.docker.summary",
                enabled: 0,
            },
            {
                id: "cache.git",
                enabled: 0,
            },
            {
                id: "cache.moltbook",
                enabled: 0,
            },
            {
                id: "cache.quotas",
                enabled: 0,
            },
            {
                id: "cache.system",
                enabled: 0,
            },
            {
                id: "cache.weather",
                enabled: 0,
            },
        ]);
        upsertScheduledJob({
            actionKey: "cache.refresh",
            actionPayload: {
                key: "quotas.summary",
            },
            description: "Unsafe in isolated development.",
            enabled: false,
            id: "cache.quotas",
            intervalSeconds: 3600,
            name: "Quota cache",
            scheduleType: "interval",
        });
        await startTestScheduledExecutor();
        expect(runScheduledJob("cache.quotas")).resolves.toMatchObject({
            jobId: "cache.quotas",
            message: "Cache refresh is not allowed in this job profile: quotas.summary",
            status: "failed",
        });
    });
    it("registers hourly git cache and daily OpenClaw workspace sync jobs", async () => {
        const { registerCacheRefreshScheduledJobs } =
            await import("../../src/services/cacheRefresh/cacheRefreshScheduler.ts");
        const { registerGitHygieneScheduledJobs } =
            await import("../../src/services/gitHygiene/scheduler.ts");
        registerCacheRefreshScheduledJobs();
        registerGitHygieneScheduledJobs();
        const rows = database
            .prepare(
                "SELECT id, schedule_type, interval_seconds, time_of_day, action_key FROM scheduled_jobs WHERE id IN ('cache.git', 'git.openclaw.workspace-sync') ORDER BY id"
            )
            .all() as Array<{
            action_key: string;
            id: string;
            interval_seconds: number;
            schedule_type: string;
            time_of_day: string | null;
        }>;
        expect(
            rows.map((row) => ({
                action_key: row.action_key,
                id: row.id,
                interval_seconds: row.interval_seconds,
                schedule_type: row.schedule_type,
            }))
        ).toEqual([
            {
                action_key: "cache.refresh",
                id: "cache.git",
                interval_seconds: 60 * 60,
                schedule_type: "interval",
            },
            {
                action_key: "git.openclaw.workspace-sync",
                id: "git.openclaw.workspace-sync",
                interval_seconds: 24 * 60 * 60,
                schedule_type: "daily",
            },
        ]);
        expect(rows.find((row) => row.id === "cache.git")?.time_of_day).toBeNull();
        expect(
            rows.find((row) => row.id === "git.openclaw.workspace-sync")?.time_of_day
        ).toBe("05:20");
    });
});
