import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { withEnv } from "../testUtils/env.js";

const originalFetch = globalThis.fetch;
const originalDbPath = process.env.MIRA_DASHBOARD_DB_PATH;

let db: Awaited<typeof import("../db.js")>["db"];
let __testing: Awaited<typeof import("./cacheRefresh.js")>["__testing"];
let refreshCacheProducer: Awaited<
    typeof import("./cacheRefresh.js")
>["refreshCacheProducer"];
let refreshMoltbookCache: Awaited<
    typeof import("./cacheRefresh.js")
>["refreshMoltbookCache"];
let registerCacheRefreshScheduledJobs: Awaited<
    typeof import("./cacheRefresh.js")
>["registerCacheRefreshScheduledJobs"];
let runScheduledJob: Awaited<typeof import("./scheduledJobs.js")>["runScheduledJob"];
let scheduledJobsTesting: Awaited<typeof import("./scheduledJobs.js")>["__testing"];
let writeCacheFailure: Awaited<typeof import("./cacheRefresh.js")>["writeCacheFailure"];
let writeCacheSuccess: Awaited<typeof import("./cacheRefresh.js")>["writeCacheSuccess"];

function cacheRow(key: string) {
    const row = db
        .prepare("SELECT * FROM cache_entries WHERE key = ? LIMIT 1")
        .get(key) as
        | {
              key: string;
              data_json: string | null;
              source: string;
              status: string;
              updated_at: string | null;
              error_message: string | null;
              consecutive_failures: number;
              metadata_json: string;
          }
        | undefined;
    assert.ok(row);
    return {
        ...row,
        data: row.data_json ? (JSON.parse(row.data_json) as unknown) : null,
        metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    };
}

function seedFreshCacheEntries(keys: string[]): void {
    for (const key of keys) {
        writeCacheSuccess({
            key,
            data: { seeded: true },
            source: "test",
            ttl: 1,
            ttlUnit: "hours",
            metadata: {},
        });
    }
}

async function withFetch(
    handler: (url: string, init: RequestInit | undefined) => unknown,
    callback: () => Promise<void>
) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
            input instanceof Request
                ? input.url
                : input instanceof URL
                  ? input.toString()
                  : String(input);
        const body = handler(url, init);
        return {
            ok: !(body && typeof body === "object" && "httpStatus" in body),
            status:
                body && typeof body === "object" && "httpStatus" in body
                    ? Number((body as { httpStatus: number }).httpStatus)
                    : 200,
            headers: new Headers({ "docker-content-digest": "sha256:ghcr-latest" }),
            json: async () => body,
        } as Response;
    }) as typeof fetch;
    try {
        await callback();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function writeExecutable(filePath: string, script: string) {
    await writeFile(filePath, script, "utf8");
    await chmod(filePath, 0o755);
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2_000,
    intervalMs = 10
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        if (predicate()) {
            return;
        }
        if (Date.now() > deadline) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (predicate()) {
        return;
    }
    throw new Error("Timed out waiting for cache refresh test condition");
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

describe("backend cache refresh producers", { concurrency: false }, () => {
    let tempDir: string;
    let dbDir: string;
    let originalPath: string | undefined;

    before(async () => {
        dbDir = await mkdtemp(path.join(os.tmpdir(), "mira-cache-refresh-db-"));
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(dbDir, "test.db");
        ({ db } = await import("../db.js"));
        ({
            __testing,
            refreshCacheProducer,
            refreshMoltbookCache,
            registerCacheRefreshScheduledJobs,
            writeCacheFailure,
            writeCacheSuccess,
        } = await import("./cacheRefresh.js"));
        ({ __testing: scheduledJobsTesting, runScheduledJob } =
            await import("./scheduledJobs.js"));
    });

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-cache-refresh-"));
        originalPath = process.env.PATH;
        db.exec("DELETE FROM cache_entries;");
    });

    afterEach(async () => {
        globalThis.fetch = originalFetch;
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        await rm(tempDir, { recursive: true, force: true });
        db.exec("DELETE FROM cache_entries;");
    });

    after(async () => {
        db.close();
        if (originalDbPath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDbPath;
        }
        await rm(dbDir, { recursive: true, force: true });
    });

    it("records cache refresh failures with incrementing failure counts", () => {
        writeCacheSuccess({
            key: "weather.spydeberg",
            data: { ok: true },
            source: "backend-test",
            ttl: 5,
            ttlUnit: "minutes",
            metadata: { producer: "weather" },
        });
        const successfulUpdatedAt = cacheRow("weather.spydeberg").updated_at;
        assert.equal(typeof successfulUpdatedAt, "string");

        writeCacheFailure({
            key: "weather.spydeberg",
            source: "backend-test",
            ttl: 5,
            ttlUnit: "minutes",
            error: new Error("first failure"),
            metadata: { producer: "weather" },
        });
        writeCacheFailure({
            key: "weather.spydeberg",
            source: "backend-test",
            ttl: 1,
            ttlUnit: "hours",
            error: "second failure",
            metadata: { producer: "weather" },
        });

        const row = cacheRow("weather.spydeberg");
        assert.equal(row.status, "error");
        assert.equal(row.updated_at, successfulUpdatedAt);
        assert.equal(row.error_message, "second failure");
        assert.equal(row.consecutive_failures, 2);
        assert.equal(row.metadata.producer, "weather");
        assert.equal(typeof row.metadata.lastFailureAt, "string");
    });

    it("refreshes Moltbook home, feeds, profile, and own content caches", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            await withFetch(
                (url, init) => {
                    assert.equal(
                        (init?.headers as Record<string, string>).Authorization,
                        "Bearer test-key"
                    );
                    if (url.endsWith("/home")) {
                        return {
                            your_direct_messages: {
                                pending_request_count: "2",
                                unread_message_count: "3",
                            },
                            activity_on_your_posts: [{ id: 1 }],
                            what_to_do_next: ["reply"],
                            latest_moltbook_announcement: {
                                post_id: "post-1",
                                title: "News",
                                author_name: "Mira",
                                created_at: "2026-06-06T00:00:00.000Z",
                                preview: "Preview",
                            },
                            posts_from_accounts_you_follow: [{ id: 2 }],
                            explore: [{ id: 3 }, { id: 4 }],
                        };
                    }
                    if (url.includes("sort=hot")) {
                        return {
                            posts: [{ id: "hot" }],
                            feed_type: "hot",
                            has_more: true,
                        };
                    }
                    if (url.includes("sort=new")) {
                        return { posts: [{ id: "new" }], feed_filter: "following" };
                    }
                    return {
                        agent: { name: "mira_2026" },
                        recentPosts: [{ id: "mine" }],
                        recentComments: [{ id: "comment" }],
                    };
                },
                async () => {
                    assert.deepEqual(await refreshCacheProducer("moltbook"), {
                        refreshed: [
                            "moltbook.home",
                            "moltbook.feed.hot",
                            "moltbook.feed.new",
                            "moltbook.profile",
                            "moltbook.my-content",
                        ],
                    });
                    assert.deepEqual(await refreshCacheProducer("moltbook.home"), {
                        refreshed: ["moltbook.home"],
                    });
                    assert.deepEqual(await refreshCacheProducer("moltbook.profile"), {
                        refreshed: ["moltbook.profile"],
                    });
                }
            );
        });

        assert.equal(
            (cacheRow("moltbook.home").data as { unreadMessageCount: number })
                .unreadMessageCount,
            3
        );
        assert.deepEqual(
            (cacheRow("moltbook.my-content").data as { posts: unknown[] }).posts,
            [{ id: "mine" }]
        );
        assert.deepEqual(
            (cacheRow("moltbook.profile").data as { agent: { name: string } }).agent,
            { name: "mira_2026" }
        );

        await withEnv({ MOLTBOOK_API_KEY: " ".repeat(3) }, async () => {
            await assert.rejects(
                () => refreshMoltbookCache(),
                (error: unknown) => {
                    assert.match((error as Error).message, /Moltbook refresh failed/u);
                    assert.match(String((error as Error).cause), /MOLTBOOK_API_KEY/u);
                    return true;
                }
            );
            await assert.rejects(
                () => refreshCacheProducer("moltbook.home"),
                /Moltbook refresh failed/u
            );
        });
        const failureRow = cacheRow("moltbook.home");
        assert.equal(failureRow.status, "error");
        assert.match(failureRow.error_message ?? "", /MOLTBOOK_API_KEY/u);

        await assert.rejects(
            () => refreshCacheProducer("moltbook.unknown"),
            /Unsupported Moltbook cache key/u
        );
    });

    it("starts independent Moltbook upstream fetches concurrently", async () => {
        const home = createDeferred<unknown>();
        const hotFeed = createDeferred<unknown>();
        const newFeed = createDeferred<unknown>();
        const profile = createDeferred<unknown>();
        const calls: string[] = [];

        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            await withFetch(
                (url) => {
                    calls.push(url);
                    if (url.endsWith("/home")) return home.promise;
                    if (url.includes("sort=hot")) return hotFeed.promise;
                    if (url.includes("sort=new")) return newFeed.promise;
                    if (url.endsWith("/agents/profile?name=mira_2026")) {
                        return profile.promise;
                    }
                    throw new Error(`Unexpected Moltbook URL: ${url}`);
                },
                async () => {
                    const refresh = refreshMoltbookCache();
                    await new Promise<void>((resolve) => setImmediate(resolve));

                    let assertionError: unknown;
                    try {
                        assert.equal(calls.length, 4);
                        assert.ok(calls.some((url) => url.endsWith("/home")));
                        assert.ok(calls.some((url) => url.includes("sort=hot")));
                        assert.ok(calls.some((url) => url.includes("sort=new")));
                        assert.ok(
                            calls.some((url) =>
                                url.endsWith("/agents/profile?name=mira_2026")
                            )
                        );
                    } catch (error) {
                        assertionError = error;
                    } finally {
                        home.resolve({ latest_moltbook_announcement: {} });
                        hotFeed.resolve({ posts: [{ id: "hot" }] });
                        newFeed.resolve({ posts: [{ id: "new" }] });
                        profile.resolve({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        });
                        await refresh;
                    }

                    if (assertionError) throw assertionError;
                }
            );
        });
    });

    it("keeps successful Moltbook writes when one upstream call fails", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            await withFetch(
                (url) => {
                    if (url.endsWith("/home")) {
                        return { latest_moltbook_announcement: {} };
                    }
                    if (url.includes("sort=hot")) {
                        return { posts: [{ id: "hot" }] };
                    }
                    if (url.includes("sort=new")) {
                        return { httpStatus: 502 };
                    }
                    return {
                        agent: { name: "mira_2026" },
                        recentPosts: [{ id: "mine" }],
                        recentComments: [],
                    };
                },
                async () => {
                    await assert.rejects(
                        () => refreshMoltbookCache(),
                        /Moltbook refresh had sub-request failures/u
                    );
                }
            );
        });

        assert.equal(cacheRow("moltbook.home").status, "fresh");
        assert.equal(cacheRow("moltbook.feed.hot").status, "fresh");
        assert.equal(cacheRow("moltbook.profile").status, "fresh");
        assert.equal(cacheRow("moltbook.my-content").status, "fresh");
        assert.equal(
            (
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM cache_entries WHERE key = 'moltbook.feed.new'"
                    )
                    .get() as { count: number }
            ).count,
            0
        );
    });

    it("records only failed Moltbook subkeys after a partial grouped refresh", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            await withFetch(
                (url) => {
                    if (url.endsWith("/home")) {
                        return { latest_moltbook_announcement: {} };
                    }
                    if (url.includes("sort=hot")) {
                        return { posts: [{ id: "hot" }] };
                    }
                    if (url.includes("sort=new")) {
                        return { httpStatus: 502 };
                    }
                    return {
                        agent: { name: "mira_2026" },
                        recentPosts: [{ id: "mine" }],
                        recentComments: [],
                    };
                },
                async () => {
                    await assert.rejects(
                        () => refreshCacheProducer("moltbook"),
                        /Moltbook refresh had sub-request failures/u
                    );
                }
            );
        });

        assert.equal(cacheRow("moltbook.home").status, "fresh");
        assert.equal(cacheRow("moltbook.feed.hot").status, "fresh");
        assert.equal(cacheRow("moltbook.feed.new").status, "error");
        assert.equal(cacheRow("moltbook.profile").status, "fresh");
        assert.equal(cacheRow("moltbook.my-content").status, "fresh");
    });

    it("wraps non-Error Moltbook upstream failures", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            await withFetch(
                () => Promise.reject("offline"),
                async () => {
                    await assert.rejects(
                        () => refreshMoltbookCache("moltbook.home"),
                        /Moltbook refresh failed/u
                    );
                }
            );
        });
    });

    it("preserves failed Moltbook subkeys when every upstream call fails", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            await withFetch(
                () => ({ httpStatus: 502 }),
                async () => {
                    await assert.rejects(
                        () => refreshCacheProducer("moltbook"),
                        /Moltbook refresh failed/u
                    );
                }
            );
        });

        assert.deepEqual(
            (
                db
                    .prepare(
                        "SELECT key, status FROM cache_entries WHERE key LIKE 'moltbook.%' ORDER BY key"
                    )
                    .all() as Array<{ key: string; status: string }>
            ).map((row) => `${row.key}:${row.status}`),
            [
                "moltbook.feed.hot:error",
                "moltbook.feed.new:error",
                "moltbook.home:error",
                "moltbook.my-content:error",
                "moltbook.profile:error",
            ]
        );
    });

    it("records grouped Moltbook refresh failures without poisoning concrete cache keys", async () => {
        writeCacheSuccess({
            key: "moltbook.home",
            data: { ok: true },
            source: "backend-test",
            ttl: 5,
            ttlUnit: "minutes",
            metadata: { producer: "moltbook" },
        });

        await withEnv({ MOLTBOOK_API_KEY: undefined }, async () => {
            await assert.rejects(
                () => refreshCacheProducer("moltbook"),
                /Moltbook refresh failed/u
            );
        });

        const concreteRow = cacheRow("moltbook.home");
        assert.equal(concreteRow.status, "error");
        assert.deepEqual(concreteRow.data, { ok: true });
        assert.match(concreteRow.error_message ?? "", /MOLTBOOK_API_KEY/u);
        assert.equal(concreteRow.metadata.producer, "refreshCacheProducer");
    });

    it("rolls back full Moltbook cache writes when one cache row fails", async () => {
        db.exec(`
            CREATE TEMP TRIGGER fail_moltbook_feed_new
            BEFORE INSERT ON cache_entries
            WHEN NEW.key = 'moltbook.feed.new' AND NEW.error_code IS NULL
            BEGIN
                SELECT RAISE(FAIL, 'moltbook write failed');
            END;
        `);
        try {
            await withEnv({ MOLTBOOK_API_KEY: "token" }, async () => {
                await withFetch(
                    (url) => {
                        if (url.includes("/home")) {
                            return {
                                unread_messages: 1,
                                latest_moltbook_announcement: {},
                            };
                        }
                        if (url.includes("/posts?sort=")) {
                            return { posts: [{ id: "post" }] };
                        }
                        return {
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        };
                    },
                    async () => {
                        await assert.rejects(
                            () => refreshMoltbookCache(),
                            /moltbook write failed/u
                        );
                    }
                );
            });
        } finally {
            db.exec("DROP TRIGGER IF EXISTS fail_moltbook_feed_new");
        }

        for (const key of [
            "moltbook.home",
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.profile",
            "moltbook.my-content",
        ]) {
            assert.equal(
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM cache_entries WHERE key = ?"
                        )
                        .get(key) as { count: number }
                ).count,
                0
            );
        }
    });

    it("records all Moltbook keys when grouped writes fail without failed key metadata", async () => {
        db.exec(`
            CREATE TEMP TRIGGER fail_moltbook_grouped_write_new
            BEFORE INSERT ON cache_entries
            WHEN NEW.key = 'moltbook.feed.new' AND NEW.error_code IS NULL
            BEGIN
                SELECT RAISE(FAIL, 'moltbook write failed');
            END;
        `);
        try {
            await withEnv({ MOLTBOOK_API_KEY: "token" }, async () => {
                await withFetch(
                    (url) => {
                        if (url.includes("/home")) {
                            return {
                                unread_messages: 1,
                                latest_moltbook_announcement: {},
                            };
                        }
                        if (url.includes("/feed?sort=")) {
                            return { posts: [{ id: "post" }] };
                        }
                        return {
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        };
                    },
                    async () => {
                        await assert.rejects(
                            () => refreshCacheProducer("moltbook"),
                            /moltbook write failed/u
                        );
                    }
                );
            });
        } finally {
            db.exec("DROP TRIGGER IF EXISTS fail_moltbook_grouped_write_new");
        }

        assert.deepEqual(
            (
                db
                    .prepare(
                        "SELECT key, status FROM cache_entries WHERE key LIKE 'moltbook.%' ORDER BY key"
                    )
                    .all() as Array<{ key: string; status: string }>
            ).map((row) => `${row.key}:${row.status}`),
            [
                "moltbook.feed.hot:error",
                "moltbook.feed.new:error",
                "moltbook.home:error",
                "moltbook.my-content:error",
                "moltbook.profile:error",
            ]
        );
    });

    it("refreshes weather through wttr and falls back to Open-Meteo", async () => {
        await withFetch(
            (url) => {
                assert.ok(url.includes("wttr.in"));
                return {
                    current_condition: [
                        {
                            temp_C: "0",
                            FeelsLikeC: "0",
                            humidity: "0",
                            windspeedKmph: "0",
                            weatherDesc: [{ value: "Cloudy" }],
                        },
                    ],
                    weather: [
                        {
                            date: "2026-06-06",
                            mintempC: "0",
                            maxtempC: "0",
                            hourly: [{ weatherDesc: [{ value: "Rain" }] }],
                        },
                    ],
                };
            },
            async () => {
                await refreshCacheProducer("weather.spydeberg");
            }
        );
        const wttr = cacheRow("weather.spydeberg");
        assert.equal(wttr.source, "wttr.in");
        const weatherData = wttr.data as {
            feelsLikeC: number | null;
            forecast: Array<{ maxTempC: number | null; minTempC: number | null }>;
            humidityPercent: number | null;
            maxTempC: number | null;
            minTempC: number | null;
            temperatureC: number | null;
            windKph: number | null;
        };
        assert.equal(weatherData.temperatureC, 0);
        assert.equal(weatherData.feelsLikeC, 0);
        assert.equal(weatherData.humidityPercent, 0);
        assert.equal(weatherData.windKph, 0);
        assert.equal(weatherData.minTempC, 0);
        assert.equal(weatherData.maxTempC, 0);
        assert.equal(weatherData.forecast[0]?.minTempC, 0);
        assert.equal(weatherData.forecast[0]?.maxTempC, 0);

        await withFetch(
            (url) => {
                if (url.includes("wttr.in")) return { httpStatus: 503 };
                return {
                    current: {
                        temperature_2m: 5,
                        apparent_temperature: 3,
                        relative_humidity_2m: 70,
                        wind_speed_10m: 10,
                        weather_code: 95,
                    },
                    daily: {
                        time: ["2026-06-06", "2026-06-07", "2026-06-08"],
                        temperature_2m_min: [1, 2, 3],
                        temperature_2m_max: [7, 8, 9],
                        weather_code: [0, 45, 71],
                    },
                };
            },
            async () => {
                await refreshCacheProducer("weather.spydeberg");
            }
        );
        const fallback = cacheRow("weather.spydeberg");
        assert.equal(fallback.source, "open-meteo");
        assert.equal(
            (fallback.data as { description: string }).description,
            "Thunderstorm"
        );
        assert.equal(fallback.metadata.fallbackUsed, true);
    });

    it("deduplicates concurrent refreshes for the same cache scope", async () => {
        let fetches = 0;
        let releaseFetch: (() => void) | undefined;
        const fetchGate = new Promise<void>((resolve) => {
            releaseFetch = resolve;
        });
        globalThis.fetch = (async () => {
            fetches += 1;
            await fetchGate;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    current_condition: [
                        {
                            temp_C: "4",
                            FeelsLikeC: "1",
                            humidity: "80",
                            windspeedKmph: "12",
                            weatherDesc: [{ value: "Cloudy" }],
                        },
                    ],
                    weather: [],
                }),
            } as Response;
        }) as typeof fetch;

        const first = refreshCacheProducer("weather.spydeberg");
        const second = refreshCacheProducer("weather.spydeberg");
        releaseFetch?.();

        assert.deepEqual(await Promise.all([first, second]), [
            { refreshed: ["weather.spydeberg"] },
            { refreshed: ["weather.spydeberg"] },
        ]);
        assert.equal(fetches, 1);
    });

    it("does not deduplicate concurrent Moltbook subkey refreshes", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            let hotFetches = 0;
            let profileFetches = 0;
            const releases: Array<() => void> = [];
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = input instanceof Request ? input.url : String(input);
                await new Promise<void>((resolve) => {
                    releases.push(resolve);
                });
                if (url.includes("/feed?sort=hot")) {
                    hotFetches += 1;
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "hot" }] }),
                    } as Response;
                }
                if (url.includes("/agents/profile")) {
                    profileFetches += 1;
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        }),
                    } as Response;
                }
                throw new Error(`Unexpected Moltbook URL: ${url}`);
            }) as typeof fetch;

            const hot = refreshCacheProducer("moltbook.feed.hot");
            const profile = refreshCacheProducer("moltbook.profile");
            await waitFor(() => releases.length >= 2);
            for (const release of releases) {
                release();
            }

            assert.deepEqual(await Promise.all([hot, profile]), [
                { refreshed: ["moltbook.feed.hot"] },
                { refreshed: ["moltbook.profile"] },
            ]);
            assert.equal(hotFetches, 1);
            assert.equal(profileFetches, 1);
        });
    });

    it("reuses an in-flight full Moltbook refresh for subkey requests", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            let releaseHome: (() => void) | undefined;
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("/home")) {
                    await new Promise<void>((resolve) => {
                        releaseHome = resolve;
                    });
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ agent: { name: "mira_2026" } }),
                    } as Response;
                }
                if (url.includes("/feed?sort=hot")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "hot" }] }),
                    } as Response;
                }
                if (url.includes("/feed?sort=new")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "new" }] }),
                    } as Response;
                }
                if (url.includes("/agents/profile")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        }),
                    } as Response;
                }
                throw new Error(`Unexpected Moltbook URL: ${url}`);
            }) as typeof fetch;

            const fullRefresh = refreshCacheProducer("moltbook");
            await waitFor(() => Boolean(releaseHome));
            const subkeyRefresh = refreshCacheProducer("moltbook.feed.hot");
            assert.ok(releaseHome);
            releaseHome();

            const expected = {
                refreshed: [
                    "moltbook.home",
                    "moltbook.feed.hot",
                    "moltbook.feed.new",
                    "moltbook.profile",
                    "moltbook.my-content",
                ],
            };
            assert.deepEqual(await Promise.all([fullRefresh, subkeyRefresh]), [
                expected,
                expected,
            ]);
        });
    });

    it("resolves reused Moltbook subkey refreshes when unrelated full refresh keys fail", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            let releaseHome: (() => void) | undefined;
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("/home")) {
                    await new Promise<void>((resolve) => {
                        releaseHome = resolve;
                    });
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ latest_moltbook_announcement: {} }),
                    } as Response;
                }
                if (url.includes("/feed?sort=hot")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "hot" }] }),
                    } as Response;
                }
                if (url.includes("/feed?sort=new")) {
                    return {
                        ok: false,
                        status: 502,
                        headers: new Headers(),
                        json: async () => ({}),
                    } as Response;
                }
                if (url.includes("/agents/profile")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        }),
                    } as Response;
                }
                throw new Error(`Unexpected Moltbook URL: ${url}`);
            }) as typeof fetch;

            const fullRefresh = refreshCacheProducer("moltbook");
            await waitFor(() => Boolean(releaseHome));
            const hotRefresh = refreshCacheProducer("moltbook.feed.hot");
            assert.ok(releaseHome);
            releaseHome();

            await assert.rejects(
                () => fullRefresh,
                /Moltbook refresh had sub-request failures/u
            );
            assert.deepEqual(await hotRefresh, {
                refreshed: ["moltbook.feed.hot"],
            });
            assert.equal(cacheRow("moltbook.feed.hot").status, "fresh");
            assert.equal(cacheRow("moltbook.feed.new").status, "error");
        });
    });

    it("rejects reused Moltbook subkey refreshes when that subkey fails", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            let releaseHome: (() => void) | undefined;
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("/home")) {
                    await new Promise<void>((resolve) => {
                        releaseHome = resolve;
                    });
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ latest_moltbook_announcement: {} }),
                    } as Response;
                }
                if (url.includes("/feed?sort=hot")) {
                    return {
                        ok: false,
                        status: 502,
                        headers: new Headers(),
                        json: async () => ({}),
                    } as Response;
                }
                if (url.includes("/feed?sort=new")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "new" }] }),
                    } as Response;
                }
                if (url.includes("/agents/profile")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        }),
                    } as Response;
                }
                throw new Error(`Unexpected Moltbook URL: ${url}`);
            }) as typeof fetch;

            const fullRefresh = refreshCacheProducer("moltbook");
            await waitFor(() => Boolean(releaseHome));
            const hotRefresh = refreshCacheProducer("moltbook.feed.hot");
            assert.ok(releaseHome);
            releaseHome();

            await assert.rejects(
                () => fullRefresh,
                /Moltbook refresh had sub-request failures/u
            );
            await assert.rejects(
                () => hotRefresh,
                /Moltbook refresh had sub-request failures/u
            );
            assert.equal(cacheRow("moltbook.feed.hot").status, "error");
            assert.equal(cacheRow("moltbook.feed.new").status, "fresh");
        });
    });

    it("runs full Moltbook refresh after an in-flight home refresh", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            let homeFetches = 0;
            const releases: Array<() => void> = [];
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("/home")) {
                    homeFetches += 1;
                    if (homeFetches === 1) {
                        await new Promise<void>((resolve) => {
                            releases.push(resolve);
                        });
                    }
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ agent: { name: "mira_2026" } }),
                    } as Response;
                }
                if (url.includes("/feed?sort=hot")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "hot" }] }),
                    } as Response;
                }
                if (url.includes("/feed?sort=new")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "new" }] }),
                    } as Response;
                }
                if (url.includes("/agents/profile")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        }),
                    } as Response;
                }
                throw new Error(`Unexpected Moltbook URL: ${url}`);
            }) as typeof fetch;

            const homeRefresh = refreshCacheProducer("moltbook.home");
            await waitFor(() => releases.length > 0);
            const fullRefresh = refreshCacheProducer("moltbook");
            const hotRefresh = refreshCacheProducer("moltbook.feed.hot");
            for (const release of releases) {
                release();
            }

            const fullResult = {
                refreshed: [
                    "moltbook.home",
                    "moltbook.feed.hot",
                    "moltbook.feed.new",
                    "moltbook.profile",
                    "moltbook.my-content",
                ],
            };
            assert.deepEqual(await Promise.all([homeRefresh, fullRefresh, hotRefresh]), [
                { refreshed: ["moltbook.home"] },
                fullResult,
                fullResult,
            ]);
            assert.equal(homeFetches, 2);
        });
    });

    it("runs full Moltbook refresh after an in-flight subkey refresh", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            let hotFetches = 0;
            const hotReleases: Array<() => void> = [];
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("/home")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ agent: { name: "mira_2026" } }),
                    } as Response;
                }
                if (url.includes("/feed?sort=hot")) {
                    hotFetches += 1;
                    if (hotFetches === 1) {
                        await new Promise<void>((resolve) => {
                            hotReleases.push(resolve);
                        });
                    }
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "hot" }] }),
                    } as Response;
                }
                if (url.includes("/feed?sort=new")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [{ id: "new" }] }),
                    } as Response;
                }
                if (url.includes("/agents/profile")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        }),
                    } as Response;
                }
                throw new Error(`Unexpected Moltbook URL: ${url}`);
            }) as typeof fetch;

            const hotRefresh = refreshCacheProducer("moltbook.feed.hot");
            await waitFor(() => hotReleases.length > 0);
            const fullRefresh = refreshCacheProducer("moltbook");
            for (const release of hotReleases) {
                release();
            }

            assert.deepEqual(await Promise.all([hotRefresh, fullRefresh]), [
                { refreshed: ["moltbook.feed.hot"] },
                {
                    refreshed: [
                        "moltbook.home",
                        "moltbook.feed.hot",
                        "moltbook.feed.new",
                        "moltbook.profile",
                        "moltbook.my-content",
                    ],
                },
            ]);
            assert.equal(hotFetches, 2);
        });
    });

    it("rejects unsupported Moltbook subkeys while a full refresh is in flight", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            let releaseHome: (() => void) | undefined;
            globalThis.fetch = (async (input: string | URL | Request) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("/home")) {
                    await new Promise<void>((resolve) => {
                        releaseHome = resolve;
                    });
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ agent: { name: "mira_2026" } }),
                    } as Response;
                }
                if (url.includes("/feed?sort=hot") || url.includes("/feed?sort=new")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({ posts: [] }),
                    } as Response;
                }
                if (url.includes("/agents/profile")) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            agent: { name: "mira_2026" },
                            recentPosts: [],
                            recentComments: [],
                        }),
                    } as Response;
                }
                throw new Error(`Unexpected Moltbook URL: ${url}`);
            }) as typeof fetch;

            const fullRefresh = refreshCacheProducer("moltbook");
            await waitFor(() => Boolean(releaseHome));

            try {
                await assert.rejects(
                    () => refreshCacheProducer("moltbook.unknown"),
                    /Unsupported Moltbook cache key/u
                );
            } finally {
                assert.ok(releaseHome);
                releaseHome();
            }
            await fullRefresh;
        });
    });

    it("refreshes git workspace status with dirty, clean, and missing repos", async () => {
        const binDir = path.join(tempDir, "bin");
        await import("node:fs/promises").then((fs) => fs.mkdir(binDir));
        await writeExecutable(
            path.join(binDir, "git"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const repo = args[1];
const command = args.slice(2).join(" ");
if (command === "rev-parse --is-inside-work-tree") process.stdout.write(repo.includes("/opt/docker") ? "false\n" : "true\n");
else if (command === "branch --show-current") process.stdout.write(repo.includes(".openclaw") ? "main\n" : "\n");
else if (command === "rev-parse HEAD") process.stdout.write("abc123\n");
else if (command === "remote -v") process.stdout.write(repo.includes(".openclaw") ? "origin\thttps://user:pass@example.com/repo.git?token=secret (fetch)\n" : "origin\tghp_secret@github.com:rajohan/repo.git?token=secret (fetch)\n");
else if (command === "status --short") {
  if (repo.includes(".openclaw")) process.stdout.write(" M a.ts\nD  b.ts\n?? c.ts\nR  d.ts -> e.ts\nUU conflict.ts\n");
  else process.exit(2);
}
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;

        await refreshCacheProducer("git.workspace");

        const data = cacheRow("git.workspace").data as {
            dirtyRepos: string[];
            missingRepos: string[];
            repos: Array<{
                key: string;
                dirty: boolean;
                error?: string;
                exists?: boolean | null;
                remote?: string | null;
                statusSummary?: { total: number };
                statusError?: string;
            }>;
        };
        assert.deepEqual(data.dirtyRepos, ["openclaw", "mira-dashboard", "n8n"]);
        assert.deepEqual(data.missingRepos, ["docker"]);
        assert.equal(
            data.repos.find((repo) => repo.key === "mira-dashboard")?.dirty,
            true
        );
        assert.match(
            data.repos.find((repo) => repo.key === "mira-dashboard")?.statusError || "",
            /git -C .*mira-dashboard status --short/u
        );
        assert.equal(
            data.repos.find((repo) => repo.key === "mira-dashboard")?.statusSummary,
            undefined
        );
        assert.equal(
            data.repos.find((repo) => repo.key === "openclaw")?.statusSummary?.total,
            5
        );
        assert.equal(
            data.repos.find((repo) => repo.key === "openclaw")?.remote,
            "https://example.com/repo.git"
        );
        assert.equal(
            data.repos.find((repo) => repo.key === "mira-dashboard")?.remote,
            "github.com:rajohan/repo.git"
        );
        assert.equal(data.repos.find((repo) => repo.key === "docker")?.exists, false);
        assert.equal(
            data.repos.find((repo) => repo.key === "docker")?.error,
            "Not a git repository"
        );
    });

    it("covers git workspace command fallback fields", async () => {
        const binDir = path.join(tempDir, "git-fallback-bin");
        await import("node:fs/promises").then((fs) => fs.mkdir(binDir));
        await writeExecutable(
            path.join(binDir, "git"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const repo = args[1];
const command = args.slice(2).join(" ");
if (repo.includes("/opt/docker")) process.exit(1);
if (command === "rev-parse --is-inside-work-tree") process.stdout.write("true\n");
else if (repo.includes("mira-dashboard")) process.exit(2);
else if (command === "branch --show-current") process.stdout.write("\n");
else if (command === "rev-parse HEAD") process.stdout.write("\n");
else if (command === "remote -v") process.stdout.write("origin\n");
else if (command === "status --short") process.stdout.write("");
`
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;

        await refreshCacheProducer("git.workspace");

        const data = cacheRow("git.workspace").data as {
            dirtyRepos: string[];
            missingRepos: string[];
            repos: Array<{
                key: string;
                branch?: string | null;
                dirty?: boolean;
                error?: string;
                exists?: boolean;
                head?: string | null;
                remote?: string | null;
                statusSummary?: { total: number };
            }>;
        };
        const openclaw = data.repos.find((repo) => repo.key === "openclaw");
        const dashboard = data.repos.find((repo) => repo.key === "mira-dashboard");
        assert.equal(openclaw?.branch, null);
        assert.equal(openclaw?.head, null);
        assert.equal(openclaw?.remote, null);
        assert.equal(dashboard?.branch, null);
        assert.equal(dashboard?.head, null);
        assert.equal(dashboard?.remote, null);
        assert.equal(dashboard?.dirty, true);
        assert.equal(dashboard?.statusSummary, undefined);
        const docker = data.repos.find((repo) => repo.key === "docker");
        assert.equal(docker?.dirty, false);
        assert.equal(docker?.exists, false);
        assert.match(docker?.error ?? "", /git -C .* rev-parse --is-inside-work-tree/u);
        assert.deepEqual(docker?.statusSummary, {
            staged: 0,
            modified: 0,
            deleted: 0,
            untracked: 0,
            renamed: 0,
            conflicted: 0,
            total: 0,
        });
        assert.deepEqual(data.dirtyRepos, ["mira-dashboard"]);
        assert.deepEqual(data.missingRepos, ["docker"]);
    });

    it("refreshes system, quota, and producer-dispatch caches", async () => {
        const binDir = path.join(tempDir, "bin");
        await import("node:fs/promises").then((fs) => fs.mkdir(binDir));
        await writeExecutable(
            path.join(binDir, "openclaw"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "status --json") {
  process.stdout.write(JSON.stringify({ runtimeVersion: "2026.5.1", update: { registry: { latestVersion: "2026.5.2" } }, gateway: { ok: true } }));
} else if (args === "doctor") {
  if (process.env.FAIL_OPENCLAW_AUX === "1") throw new Error("doctor failed");
  process.stdout.write("- OK: fine\n- WARNING: Gateway clients warning\n");
} else if (args === "security audit --json") {
  if (process.env.FAIL_OPENCLAW_AUX === "1") throw new Error("security failed");
  if (process.env.MALFORMED_OPENCLAW_SECURITY === "1") {
    process.stdout.write("{");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ok: true, warnings: [] }));
}
`
        );
        await writeExecutable(
            path.join(binDir, "tmux"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("capture-pane")) {
  process.stdout.write("Account: raymond@example.test\nModel: gpt-5.5 (high)\n5h limit: 80% left (resets 12:00)\nWeekly limit: 50% left (resets Monday)\n");
}
`
        );
        await writeExecutable(path.join(binDir, "codex"), "#!/usr/bin/env node\n");

        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        await withEnv(
            {
                OPENCLAW_BIN: path.join(binDir, "openclaw"),
                CODEX_BIN: path.join(binDir, "codex"),
                QUOTAS_CODEX_HOME: path.join(tempDir, "codex-home"),
                OPENROUTER_API_KEY: "openrouter",
                ELEVENLABS_API_KEY: "eleven",
                SYNTHETIC_API_KEY: "synthetic",
            },
            async () => {
                await withFetch(
                    (url) => {
                        if (url.includes("openrouter.ai/api/v1/key")) {
                            return { data: { usage: "10", usage_monthly: "20" } };
                        }
                        if (url.includes("openrouter.ai/api/v1/credits")) {
                            return { data: { total_credits: "25" } };
                        }
                        if (url.includes("elevenlabs")) {
                            return {
                                subscription: {
                                    character_count: "100",
                                    character_limit: "200",
                                    next_character_count_reset_unix: "1893456000",
                                    tier: "pro",
                                },
                            };
                        }
                        return {
                            subscription: { limit: 10, requests: 4, renewsAt: "soon" },
                            search: {
                                hourly: { limit: 20, requests: 5, renewsAt: "later" },
                            },
                            weeklyTokenLimit: {
                                maxCredits: "$10.00",
                                nextRegenCredits: "$2.50",
                                percentRemaining: "75",
                            },
                            rollingFiveHourLimit: {
                                max: 100,
                                remaining: 80,
                                limited: false,
                                tickPercent: "10",
                            },
                        };
                    },
                    async () => {
                        assert.deepEqual(await refreshCacheProducer("system.host"), {
                            refreshed: ["system.openclaw", "system.host"],
                        });
                        assert.deepEqual(await refreshCacheProducer("system.openclaw"), {
                            refreshed: ["system.openclaw", "system.host"],
                        });
                        assert.deepEqual(await refreshCacheProducer("quotas.summary"), {
                            refreshed: ["quotas.summary"],
                        });
                    }
                );
            }
        );

        assert.equal(
            (cacheRow("system.host").data as { version: { updateAvailable: boolean } })
                .version.updateAvailable,
            true
        );
        assert.equal(
            (cacheRow("quotas.summary").data as { openai: { percentUsed: number } })
                .openai.percentUsed,
            50
        );
        assert.equal(
            "account" in
                (cacheRow("quotas.summary").data as { openai: Record<string, unknown> })
                    .openai,
            false
        );

        await withEnv(
            {
                FAIL_OPENCLAW_AUX: "1",
                OPENCLAW_BIN: path.join(binDir, "openclaw"),
            },
            async () => {
                assert.deepEqual(await refreshCacheProducer("system.host"), {
                    refreshed: ["system.openclaw", "system.host"],
                });
            }
        );

        const openclawSystem = cacheRow("system.openclaw").data as {
            doctorError: string | null;
            doctorWarnings: string[];
            security: unknown;
            securityError: string | null;
            version: { current: string };
        };
        assert.equal(openclawSystem.version.current, "2026.5.1");
        assert.match(openclawSystem.doctorError ?? "", /doctor failed/u);
        assert.deepEqual(openclawSystem.doctorWarnings, []);
        assert.equal(openclawSystem.security, null);
        assert.match(openclawSystem.securityError ?? "", /security failed/u);

        const warnMock = mock.method(console, "warn", () => {});
        try {
            await withEnv(
                {
                    MALFORMED_OPENCLAW_SECURITY: "1",
                    OPENCLAW_BIN: path.join(binDir, "openclaw"),
                },
                async () => {
                    assert.deepEqual(await refreshCacheProducer("system.host"), {
                        refreshed: ["system.openclaw", "system.host"],
                    });
                }
            );
        } finally {
            warnMock.mock.restore();
        }

        const malformedOpenclawSystem = cacheRow("system.openclaw").data as {
            security: unknown;
            securityError: string | null;
            version: { current: string };
        };
        assert.equal(malformedOpenclawSystem.version.current, "2026.5.1");
        assert.equal(malformedOpenclawSystem.security, null);
        assert.match(malformedOpenclawSystem.securityError ?? "", /JSON/u);
    });

    it("reports quota providers as missing or errored when credentials and calls fail", async () => {
        await withEnv(
            {
                OPENROUTER_API_KEY: undefined,
                ELEVENLABS_API_KEY: "eleven",
                SYNTHETIC_API_KEY: "synthetic",
                CODEX_BIN: path.join(tempDir, "missing-codex"),
                QUOTAS_CODEX_HOME: path.join(tempDir, "codex-home-existing"),
            },
            async () => {
                await withFetch(
                    (url) => {
                        if (url.includes("elevenlabs")) return { httpStatus: 500 };
                        return {
                            subscription: {},
                            search: {},
                            weeklyTokenLimit: {},
                            rollingFiveHourLimit: {},
                        };
                    },
                    async () => {
                        await refreshCacheProducer("quotas.summary");
                    }
                );
            }
        );

        const data = cacheRow("quotas.summary").data as {
            openrouter: { status: string };
            elevenlabs: { status: string };
            synthetic: { subscription: { percentUsed: number | null } };
            openai: { status: string };
        };
        assert.equal(data.openrouter.status, "not_configured");
        assert.equal(data.elevenlabs.status, "error");
        assert.equal(data.synthetic.subscription.percentUsed, null);
        assert.ok(["not_configured", "error"].includes(data.openai.status));
    });

    it("covers cache refresh normalizer fallback branches directly", async () => {
        assert.equal(__testing.toCurrencyNumber(12), 12);
        assert.equal(__testing.toCurrencyNumber(Number.NaN), null);
        assert.equal(__testing.toCurrencyNumber("USD 1,234.50"), 1234.5);
        assert.equal(__testing.toCurrencyNumber("USD nope"), null);
        assert.equal(__testing.toCurrencyNumber("USD -"), null);
        assert.equal(__testing.toCurrencyNumber("USD .-"), null);
        assert.equal(__testing.toCurrencyNumber("USD 1.2.3"), null);
        assert.equal(__testing.toCurrencyNumber("-"), null);
        assert.equal(__testing.toCurrencyNumber({}), null);
        const missingValue = undefined;
        assert.equal(__testing.toNullableNumber(null), null);
        assert.equal(__testing.toNullableNumber(missingValue), null);
        assert.equal(__testing.toNullableNumber(""), null);
        assert.equal(__testing.toNullableNumber(" ".repeat(3)), null);
        assert.equal(__testing.toNullableNumber("nope"), null);
        assert.equal(__testing.toNullableNumber("75"), 75);
        assert.equal(__testing.openMeteoCodeToDescription(2), "Partly cloudy");
        assert.equal(__testing.openMeteoCodeToDescription(48), "Fog");
        assert.equal(__testing.openMeteoCodeToDescription(53), "Drizzle");
        assert.equal(__testing.openMeteoCodeToDescription(63), "Rain");
        assert.equal(__testing.openMeteoCodeToDescription(77), "Snow");
        assert.equal(__testing.openMeteoCodeToDescription(999), "Unknown");
        assert.equal(__testing.openMeteoCodeToDescription("0"), "Clear");
        assert.equal(__testing.openMeteoCodeToDescription(null), "Unknown");
        assert.equal(__testing.openMeteoCodeToDescription(""), "Unknown");
        assert.equal(__testing.openMeteoCodeToDescription(" ".repeat(3)), "Unknown");
        assert.equal(__testing.openMeteoCodeToDescription("nope"), "Unknown");
        assert.equal(
            __testing.sanitizeRemoteUrl("https://example.com/repo.git?token=secret"),
            "https://example.com/repo.git"
        );
        assert.equal(__testing.sanitizeRemoteUrl("not a url?token=secret"), "not a url");
        assert.equal(__testing.cleanPanelText(""), null);
        assert.equal(__testing.cleanPanelText("╭ Account ╯"), "Account");
        assert.equal(__testing.cleanPanelText("╭╯"), null);
        assert.deepEqual(__testing.normalizeMoltbookFeed([], "new"), {
            posts: [],
            feedType: "new",
            feedFilter: null,
            hasMore: false,
            tip: null,
        });
        assert.equal(
            __testing.normalizeMoltbookHome({
                your_direct_messages: null,
                activity_on_your_posts: "bad",
                what_to_do_next: "bad",
                latest_moltbook_announcement: {},
                posts_from_accounts_you_follow: "bad",
                explore: "bad",
            }).latestAnnouncement,
            null
        );
        assert.deepEqual(
            __testing.normalizeMoltbookHome({
                latest_moltbook_announcement: {
                    post_id: "post",
                    title: "Title",
                    author_name: "Mira",
                    created_at: "now",
                    preview: "preview",
                },
            }).latestAnnouncement,
            {
                postId: "post",
                title: "Title",
                authorName: "Mira",
                createdAt: "now",
                preview: "preview",
            }
        );
        assert.deepEqual(
            __testing.normalizeMoltbookHome({
                latest_moltbook_announcement: {
                    post_id: "post",
                },
            }).latestAnnouncement,
            {
                postId: "post",
                title: null,
                authorName: null,
                createdAt: null,
                preview: null,
            }
        );
        assert.deepEqual(
            __testing.normalizeMoltbookHome({
                latest_moltbook_announcement: {
                    title: "Title",
                },
            }).latestAnnouncement,
            {
                postId: null,
                title: "Title",
                authorName: null,
                createdAt: null,
                preview: null,
            }
        );
        assert.equal(__testing.errorMessage("plain failure"), "plain failure");
        assert.equal(__testing.openMeteoCodeToDescription(0), "Clear");
        assert.deepEqual(
            __testing.summarizeStatus([
                "A  staged.ts",
                " M modified.ts",
                " D deleted.ts",
                "?? untracked.ts",
                "R  old.ts -> new.ts",
                "UU conflict.ts",
                "AA both-added.ts",
                "DD both-deleted.ts",
                " M dir/README_DELETED.md",
                "",
            ]),
            {
                staged: 2,
                modified: 2,
                deleted: 2,
                untracked: 1,
                renamed: 1,
                conflicted: 3,
                total: 10,
            }
        );
    });

    it("covers quota producer helper fallback branches directly", async () => {
        await withEnv(
            {
                OPENROUTER_API_KEY: " ".repeat(3),
                ELEVENLABS_API_KEY: " ".repeat(3),
                SYNTHETIC_API_KEY: " ".repeat(3),
                QUOTAS_CODEX_HOME: path.join(tempDir, "codex-home"),
            },
            async () => {
                assert.deepEqual(await __testing.checkOpenRouterQuota(), {
                    status: "not_configured",
                });
                assert.deepEqual(await __testing.checkElevenLabsQuota(), {
                    status: "not_configured",
                });
                assert.deepEqual(await __testing.checkSyntheticQuota(), {
                    status: "not_configured",
                });
            }
        );

        await withEnv(
            {
                ELEVENLABS_API_KEY: "eleven",
                SYNTHETIC_API_KEY: "synthetic",
            },
            async () => {
                await withFetch(
                    (url) => {
                        if (url.includes("elevenlabs")) {
                            return {
                                subscription: {
                                    character_count: 25,
                                    character_limit: 100,
                                    next_character_count_reset_unix_ms: " ".repeat(3),
                                    next_character_count_reset_unix: "1893456000",
                                },
                            };
                        }
                        return {
                            subscription: { limit: 0, requests: 0 },
                            search: { hourly: { limit: 0, requests: 0 } },
                            weeklyTokenLimit: {
                                maxCredits: "$0.00",
                                nextRegenCredits: "$0.00",
                            },
                            rollingFiveHourLimit: { max: 0, remaining: 0 },
                        };
                    },
                    async () => {
                        const elevenLabsQuota = await __testing.checkElevenLabsQuota();
                        assert.equal(elevenLabsQuota.resetAt, "2030-01-01T00:00:00.000Z");
                        const synthetic = (await __testing.checkSyntheticQuota()) as {
                            weeklyTokenLimit: {
                                nextRegenPercent: number | null;
                                percentRemaining: number | null;
                            };
                            rollingFiveHourLimit: { percentUsed: number | null };
                        };
                        assert.equal(synthetic.weeklyTokenLimit.nextRegenPercent, null);
                        assert.equal(synthetic.weeklyTokenLimit.percentRemaining, null);
                        assert.equal(synthetic.rollingFiveHourLimit.percentUsed, null);
                    }
                );

                await withFetch(
                    () => ({
                        subscription: {
                            character_count: 25,
                            character_limit: 100,
                            next_character_count_reset_unix_ms: "1893456000000",
                        },
                    }),
                    async () => {
                        const elevenLabsQuota = await __testing.checkElevenLabsQuota();
                        assert.equal(elevenLabsQuota.resetAt, "2030-01-01T00:00:00.000Z");
                    }
                );
            }
        );

        const codexHome = path.join(tempDir, "codex-home-existing");
        await import("node:fs/promises").then((fs) => fs.mkdir(codexHome));
        const configPath = path.join(codexHome, "config.toml");
        await writeFile(
            configPath,
            '[projects."/home/ubuntu/.openclaw"]\ntrust_level = "trusted"\n',
            "utf8"
        );
        await __testing.ensureCodexTrustConfig(codexHome);
        assert.match(
            await import("node:fs/promises").then((fs) =>
                fs.readFile(configPath, "utf8")
            ),
            /trust_level/u
        );

        const codexHomeUntrusted = path.join(tempDir, "codex-home-untrusted");
        await import("node:fs/promises").then((fs) => fs.mkdir(codexHomeUntrusted));
        const untrustedConfigPath = path.join(codexHomeUntrusted, "config.toml");
        await writeFile(
            untrustedConfigPath,
            [
                "[profile]",
                'model = "codex"',
                '[projects."/home/ubuntu/.openclaw"]',
                'trust_level = "untrusted"',
                "extra = true",
                '[projects."/tmp/unmanaged"]',
                'trust_level = "untrusted"',
                '[projects."/home/ubuntu/projects"]',
                "extra = true",
                "",
            ].join("\n"),
            "utf8"
        );
        await __testing.ensureCodexTrustConfig(codexHomeUntrusted);
        const normalizedTrustConfig = await import("node:fs/promises").then((fs) =>
            fs.readFile(untrustedConfigPath, "utf8")
        );
        assert.match(
            normalizedTrustConfig,
            /\[projects\."\/home\/ubuntu\/\.openclaw"\]\ntrust_level = "trusted"\nextra = true/u
        );
        assert.match(
            normalizedTrustConfig,
            /\[projects\."\/home\/ubuntu\/projects"\]\ntrust_level = "trusted"\nextra = true/u
        );
        assert.match(
            normalizedTrustConfig,
            /\[projects\."\/tmp\/unmanaged"\]\ntrust_level = "untrusted"/u
        );
        assert.match(
            normalizedTrustConfig,
            /\[projects\."\/home\/ubuntu\/projects\/mira-dashboard"\]\ntrust_level = "trusted"/u
        );

        const codexHomeNoNewline = path.join(tempDir, "codex-home-no-newline");
        await import("node:fs/promises").then((fs) => fs.mkdir(codexHomeNoNewline));
        const noNewlineConfigPath = path.join(codexHomeNoNewline, "config.toml");
        await writeFile(noNewlineConfigPath, '[profile]\nmodel = "codex"', "utf8");
        await __testing.ensureCodexTrustConfig(codexHomeNoNewline);
        assert.match(
            await import("node:fs/promises").then((fs) =>
                fs.readFile(noNewlineConfigPath, "utf8")
            ),
            /model = "codex"\n\n\[projects/u
        );
        await __testing.ensureCodexTrustConfig(codexHomeNoNewline);
        const noNewlineUpdatedConfig = await import("node:fs/promises").then((fs) =>
            fs.readFile(noNewlineConfigPath, "utf8")
        );
        assert.equal(noNewlineUpdatedConfig.match(/\[projects\./gu)?.length, 3);
        let unlocked = false;
        const locked = new Promise<void>((resolve) => {
            setTimeout(() => {
                unlocked = true;
                resolve();
            }, 1);
        });
        __testing.codexTrustConfigLocks.set(codexHomeNoNewline, locked);
        try {
            await __testing.ensureCodexTrustConfig(codexHomeNoNewline);
            assert.equal(unlocked, true);
        } finally {
            __testing.codexTrustConfigLocks.delete(codexHomeNoNewline);
        }

        const codexHomeBadConfig = path.join(tempDir, "codex-home-bad-config");
        await mkdir(path.join(codexHomeBadConfig, "config.toml"), { recursive: true });
        await assert.rejects(
            () => __testing.ensureCodexTrustConfig(codexHomeBadConfig),
            /EISDIR|illegal operation/u
        );

        const asyncLockPath = path.join(tempDir, "codex-async.lock");
        await writeFile(asyncLockPath, "held", "utf8");
        let timerFired = false;
        const pendingLock = __testing.acquireCodexTrustConfigLockAsync(asyncLockPath);
        setTimeout(() => {
            timerFired = true;
        }, 0);
        await waitFor(() => timerFired);
        await rm(asyncLockPath, { force: true });
        const asyncLock = await pendingLock;
        await asyncLock.close();
        await rm(asyncLockPath, { force: true });

        await withEnv(
            {
                OPENCLAW_BIN: undefined,
                QUOTAS_CODEX_HOME: undefined,
            },
            async () => {
                assert.equal(
                    __testing.getOpenclawBin(),
                    "/home/ubuntu/.npm-global/bin/openclaw"
                );
                assert.equal(__testing.getQuotaCodexHome(), "/home/ubuntu/.codex");
            }
        );
    });

    it("covers empty provider payloads and Codex status error branches", async () => {
        await withFetch(
            (url) => {
                if (url.includes("wttr.in")) {
                    return { current_condition: null, weather: null };
                }
                return {};
            },
            async () => {
                const weather = await __testing.fetchSpydebergWeather();
                assert.equal(weather.source, "wttr.in");
                assert.equal(weather.data.temperatureC, null);
                assert.equal(weather.data.description, "Unknown");
            }
        );

        await withFetch(
            (url) => {
                if (url.includes("wttr.in")) return { httpStatus: 500 };
                return { current: {}, daily: {} };
            },
            async () => {
                const weather = await __testing.fetchSpydebergWeather();
                assert.equal(weather.source, "open-meteo");
                assert.equal(weather.data.minTempC, null);
                assert.deepEqual(weather.data.forecast, []);
            }
        );

        await withEnv(
            {
                OPENROUTER_API_KEY: "openrouter",
                ELEVENLABS_API_KEY: undefined,
                SYNTHETIC_API_KEY: "synthetic",
                CODEX_BIN: path.join(tempDir, "missing-codex"),
                QUOTAS_CODEX_HOME: path.join(tempDir, "quota-home"),
            },
            async () => {
                await withFetch(
                    (url) => {
                        if (url.includes("openrouter") || url.includes("synthetic")) {
                            return { httpStatus: 500 };
                        }
                        return {};
                    },
                    async () => {
                        await refreshCacheProducer("quotas.summary");
                    }
                );
            }
        );
        const quotas = cacheRow("quotas.summary").data as {
            openrouter: { status: string };
            elevenlabs: { status: string };
            synthetic: { status: string };
        };
        assert.equal(quotas.openrouter.status, "error");
        assert.equal(quotas.elevenlabs.status, "not_configured");
        assert.equal(quotas.synthetic.status, "error");

        assert.deepEqual(__testing.parseOpenAiQuotaOutput("__ERR__:tmux_not_found"), {
            status: "error",
            note: "tmux not found",
        });
        assert.deepEqual(__testing.parseOpenAiQuotaOutput("__ERR__:codex_not_found"), {
            status: "not_configured",
            note: "codex binary not found",
        });
        assert.deepEqual(__testing.parseOpenAiQuotaOutput("Account: test\n"), {
            status: "error",
            note: "Could not parse Codex /status output",
        });
        const badCodexHome = path.join(tempDir, "quota-codex-home-file");
        await writeFile(badCodexHome, "not a directory", "utf8");
        await withEnv({ QUOTAS_CODEX_HOME: badCodexHome }, async () => {
            const quota = await __testing.checkOpenAiQuota();
            assert.equal(quota.status, "error");
        });
        const pathCodexBin = path.join(tempDir, "path-codex-bin");
        await import("node:fs/promises").then((fs) => fs.mkdir(pathCodexBin));
        await writeExecutable(path.join(pathCodexBin, "codex"), "#!/usr/bin/env node\n");
        await writeExecutable(
            path.join(pathCodexBin, "tmux"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("capture-pane")) {
  process.stdout.write("Account: path@example.test\nModel: gpt-5.5 (high)\n5h limit: 70% left\nWeekly limit: 60% left\n");
}
`
        );
        process.env.PATH = `${pathCodexBin}${path.delimiter}${originalPath || ""}`;
        await withEnv(
            {
                CODEX_BIN: "codex",
                QUOTAS_CODEX_HOME: path.join(tempDir, "path-codex-home"),
            },
            async () => {
                const quota = await __testing.checkOpenAiQuota();
                assert.equal(quota.status, undefined);
                assert.equal(quota.account, "path@example.test");
                assert.equal(quota.percentUsed, 40);
            }
        );
        assert.deepEqual(
            __testing.parseOpenAiQuotaOutput(
                "Account: raymond@example.test\nModel: gpt-5.5 (high)\n5h limit: 80% left (resets 12:00)\nWeekly limit: 50% left (resets Monday)\n"
            ),
            {
                account: "raymond@example.test",
                model: "gpt-5.5",
                fiveHourLeftPercent: 80,
                weeklyLeftPercent: 50,
                fiveHourReset: "12:00",
                weeklyReset: "Monday",
                percentUsed: 50,
                resetAt: "Monday",
            }
        );
        assert.deepEqual(
            __testing.parseOpenAiQuotaOutput(
                "5h limit: 80% left\nWeekly limit: 50% left\n"
            ),
            {
                account: null,
                model: null,
                fiveHourLeftPercent: 80,
                weeklyLeftPercent: 50,
                fiveHourReset: null,
                weeklyReset: null,
                percentUsed: 50,
                resetAt: null,
            }
        );
        assert.deepEqual(__testing.parseOpenAiQuotaOutput("5h limit: left\n"), {
            status: "error",
            note: "Could not parse Codex /status output",
        });
        assert.deepEqual(
            __testing.buildQuotaMissingProviders(
                { status: "not_configured" },
                { status: "ok" },
                { status: "not_configured" },
                { status: "not_configured" }
            ),
            ["openrouter", "synthetic", "openai"]
        );

        await withEnv({ OPENROUTER_API_KEY: "openrouter" }, async () => {
            await withFetch(
                () => ({
                    data: {
                        usage: 0,
                        usage_monthly: 0,
                        total_credits: 0,
                    },
                }),
                async () => {
                    const openRouterQuota = await __testing.checkOpenRouterQuota();
                    assert.equal(openRouterQuota.percentUsed, null);
                }
            );
        });
    });

    it("recovers stale Codex trust config locks", async () => {
        const codexHome = path.join(tempDir, "codex-lock");
        await mkdir(codexHome, { recursive: true });
        const lockPath = path.join(codexHome, "config.toml.lock");
        await writeFile(lockPath, "stale", "utf8");
        const staleTime = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(lockPath, staleTime, staleTime);
        const originalNow = Date.now.bind(Date);
        let calls = 0;
        const nowMock = mock.method(Date, "now", () => {
            calls += 1;
            return originalNow() + (calls > 1 ? 10_000 : 0);
        });
        let handle: number | null = null;
        try {
            handle = __testing.acquireCodexTrustConfigLock(lockPath);
            assert.equal(typeof handle, "number");
        } finally {
            nowMock.mock.restore();
            if (handle !== null) {
                const { closeSync, rmSync } = await import("node:fs");
                closeSync(handle);
                rmSync(lockPath, { force: true });
            }
        }
    });

    it("rethrows unexpected Codex trust lock acquisition errors", () => {
        assert.throws(
            () =>
                __testing.acquireCodexTrustConfigLock(
                    path.join(tempDir, "missing-parent", "config.toml.lock")
                ),
            /ENOENT/u
        );
    });

    it("covers Codex trust lock retry and stale-lock edge cases", () => {
        const lockPath = path.join(tempDir, "config.toml.lock");
        const existsError = Object.assign(new Error("exists"), { code: "EEXIST" });
        let openCalls = 0;
        let sleepCalls = 0;
        assert.equal(
            __testing.acquireCodexTrustConfigLock(lockPath, {
                now: () => 1_000,
                open: () => {
                    openCalls += 1;
                    if (openCalls === 1) throw existsError;
                    return 123;
                },
                sleep: () => {
                    sleepCalls += 1;
                },
            }),
            123
        );
        assert.equal(sleepCalls, 1);

        let missingLockOpenCalls = 0;
        assert.equal(
            __testing.acquireCodexTrustConfigLock(lockPath, {
                now: (() => {
                    let calls = 0;
                    return () => {
                        calls += 1;
                        return calls === 1 ? 0 : 10_000;
                    };
                })(),
                open: () => {
                    missingLockOpenCalls += 1;
                    if (missingLockOpenCalls === 1) throw existsError;
                    return 456;
                },
                stat: () => {
                    throw Object.assign(new Error("gone"), { code: "ENOENT" });
                },
            }),
            456
        );

        let reclaimedOpenCalls = 0;
        let reclaimedRemovedPath: string | null = null;
        let reclaimedStatCalls = 0;
        assert.equal(
            __testing.acquireCodexTrustConfigLock(lockPath, {
                now: (() => {
                    let calls = 0;
                    return () => {
                        calls += 1;
                        return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                    };
                })(),
                open: () => {
                    reclaimedOpenCalls += 1;
                    if (reclaimedOpenCalls === 1) throw existsError;
                    return 567;
                },
                remove: (reclaimedPath) => {
                    reclaimedRemovedPath = String(reclaimedPath);
                },
                rename: () => {},
                stat: () => {
                    reclaimedStatCalls += 1;
                    return { dev: 1, ino: 2, mtimeMs: 1 } as never;
                },
            }),
            567
        );
        assert.equal(reclaimedRemovedPath, `${lockPath}.reclaimed.${process.pid}`);
        assert.equal(reclaimedStatCalls, 2);

        assert.throws(
            () =>
                __testing.acquireCodexTrustConfigLock(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000;
                        };
                    })(),
                    open: () => {
                        throw existsError;
                    },
                    stat: () => ({ mtimeMs: 9_999 }) as never,
                }),
            /exists/u
        );
        assert.throws(
            () =>
                __testing.acquireCodexTrustConfigLock(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: () => {
                        throw existsError;
                    },
                    rename: () => {
                        throw Object.assign(new Error("rename denied"), {
                            code: "EACCES",
                        });
                    },
                    stat: () => ({ dev: 1, ino: 2, mtimeMs: 1 }) as never,
                }),
            /exists/u
        );
        const mismatchRenameCalls: Array<[string, string]> = [];
        let mismatchStatCalls = 0;
        assert.throws(
            () =>
                __testing.acquireCodexTrustConfigLock(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: () => {
                        throw existsError;
                    },
                    rename: (from, to) => {
                        mismatchRenameCalls.push([String(from), String(to)]);
                    },
                    stat: () => {
                        mismatchStatCalls += 1;
                        if (mismatchStatCalls === 2) {
                            return { dev: 9, ino: 9, mtimeMs: 1 } as never;
                        }
                        return { dev: 1, ino: 2, mtimeMs: 1 } as never;
                    },
                }),
            /exists/u
        );
        assert.deepEqual(mismatchRenameCalls, [
            [lockPath, `${lockPath}.reclaimed.${process.pid}`],
            [`${lockPath}.reclaimed.${process.pid}`, lockPath],
        ]);
        const failedRestoreRenameCalls: Array<[string, string]> = [];
        assert.throws(
            () =>
                __testing.acquireCodexTrustConfigLock(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: () => {
                        throw existsError;
                    },
                    rename: (from, to) => {
                        failedRestoreRenameCalls.push([String(from), String(to)]);
                        if (failedRestoreRenameCalls.length === 2) {
                            throw new Error("restore denied");
                        }
                    },
                    stat: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return {
                                dev: calls === 2 ? 9 : 1,
                                ino: calls === 2 ? 9 : 2,
                                mtimeMs: 1,
                            } as never;
                        };
                    })(),
                }),
            /exists/u
        );
        assert.deepEqual(failedRestoreRenameCalls, [
            [lockPath, `${lockPath}.reclaimed.${process.pid}`],
            [`${lockPath}.reclaimed.${process.pid}`, lockPath],
        ]);
        let statCalls = 0;
        assert.throws(
            () =>
                __testing.acquireCodexTrustConfigLock(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: () => {
                        throw existsError;
                    },
                    rename: () => {},
                    stat: () => {
                        statCalls += 1;
                        return {
                            dev: statCalls === 1 ? 1 : 3,
                            ino: statCalls === 1 ? 2 : 4,
                            mtimeMs: 1,
                        } as never;
                    },
                }),
            /exists/u
        );
        let renameMissingOpenCalls = 0;
        assert.equal(
            __testing.acquireCodexTrustConfigLock(lockPath, {
                now: (() => {
                    let calls = 0;
                    return () => {
                        calls += 1;
                        return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                    };
                })(),
                open: () => {
                    renameMissingOpenCalls += 1;
                    if (renameMissingOpenCalls === 1) throw existsError;
                    return 789;
                },
                rename: () => {
                    throw Object.assign(new Error("gone"), { code: "ENOENT" });
                },
                stat: () => ({ dev: 1, ino: 2, mtimeMs: 1 }) as never,
            }),
            789
        );
        assert.throws(
            () =>
                __testing.acquireCodexTrustConfigLock(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000;
                        };
                    })(),
                    open: () => {
                        throw existsError;
                    },
                    stat: () => {
                        throw Object.assign(new Error("stat failed"), { code: "EACCES" });
                    },
                }),
            /stat failed/u
        );
        __testing.sleepSync(0);
    });

    it("covers async Codex trust lock retry and stale-lock edge cases", async () => {
        const lockPath = path.join(tempDir, "config.toml.lock");
        const existsError = Object.assign(new Error("exists"), { code: "EEXIST" });
        const handle = { close: async () => {} };
        let openCalls = 0;
        let sleepCalls = 0;
        assert.equal(
            await __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                now: () => 1_000,
                open: async () => {
                    openCalls += 1;
                    if (openCalls === 1) throw existsError;
                    return handle;
                },
                sleep: async () => {
                    sleepCalls += 1;
                },
            }),
            handle
        );
        assert.equal(sleepCalls, 1);

        await assert.rejects(
            () =>
                __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                    open: async () => {
                        throw Object.assign(new Error("open denied"), { code: "EACCES" });
                    },
                }),
            /open denied/u
        );

        let missingLockOpenCalls = 0;
        assert.equal(
            await __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                now: (() => {
                    let calls = 0;
                    return () => {
                        calls += 1;
                        return calls === 1 ? 0 : 10_000;
                    };
                })(),
                open: async () => {
                    missingLockOpenCalls += 1;
                    if (missingLockOpenCalls === 1) throw existsError;
                    return handle;
                },
                stat: async () => {
                    throw Object.assign(new Error("gone"), { code: "ENOENT" });
                },
            }),
            handle
        );

        let reclaimedOpenCalls = 0;
        let reclaimedRemovedPath: string | null = null;
        let reclaimedStatCalls = 0;
        assert.equal(
            await __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                now: (() => {
                    let calls = 0;
                    return () => {
                        calls += 1;
                        return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                    };
                })(),
                open: async () => {
                    reclaimedOpenCalls += 1;
                    if (reclaimedOpenCalls === 1) throw existsError;
                    return handle;
                },
                remove: async (reclaimedPath) => {
                    reclaimedRemovedPath = String(reclaimedPath);
                },
                rename: async () => {},
                stat: async () => {
                    reclaimedStatCalls += 1;
                    return { dev: 1, ino: 2, mtimeMs: 1 } as never;
                },
            }),
            handle
        );
        assert.equal(reclaimedRemovedPath, `${lockPath}.reclaimed.${process.pid}`);
        assert.equal(reclaimedStatCalls, 2);

        await assert.rejects(
            () =>
                __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000;
                        };
                    })(),
                    open: async () => {
                        throw existsError;
                    },
                    stat: async () => ({ mtimeMs: 9_999 }) as never,
                }),
            /exists/u
        );
        await assert.rejects(
            () =>
                __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: async () => {
                        throw existsError;
                    },
                    rename: async () => {
                        throw Object.assign(new Error("rename denied"), {
                            code: "EACCES",
                        });
                    },
                    stat: async () => ({ dev: 1, ino: 2, mtimeMs: 1 }) as never,
                }),
            /exists/u
        );
        const asyncMismatchRenameCalls: Array<[string, string]> = [];
        let asyncMismatchStatCalls = 0;
        await assert.rejects(
            () =>
                __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: async () => {
                        throw existsError;
                    },
                    rename: async (from, to) => {
                        asyncMismatchRenameCalls.push([String(from), String(to)]);
                    },
                    stat: async () => {
                        asyncMismatchStatCalls += 1;
                        if (asyncMismatchStatCalls === 2) {
                            return { dev: 9, ino: 9, mtimeMs: 1 } as never;
                        }
                        return { dev: 1, ino: 2, mtimeMs: 1 } as never;
                    },
                }),
            /exists/u
        );
        assert.deepEqual(asyncMismatchRenameCalls, [
            [lockPath, `${lockPath}.reclaimed.${process.pid}`],
            [`${lockPath}.reclaimed.${process.pid}`, lockPath],
        ]);
        const asyncFailedRestoreRenameCalls: Array<[string, string]> = [];
        await assert.rejects(
            () =>
                __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: async () => {
                        throw existsError;
                    },
                    rename: async (from, to) => {
                        asyncFailedRestoreRenameCalls.push([String(from), String(to)]);
                        if (asyncFailedRestoreRenameCalls.length === 2) {
                            throw new Error("restore denied");
                        }
                    },
                    stat: (() => {
                        let calls = 0;
                        return async () => {
                            calls += 1;
                            return {
                                dev: calls === 2 ? 9 : 1,
                                ino: calls === 2 ? 9 : 2,
                                mtimeMs: 1,
                            } as never;
                        };
                    })(),
                }),
            /exists/u
        );
        assert.deepEqual(asyncFailedRestoreRenameCalls, [
            [lockPath, `${lockPath}.reclaimed.${process.pid}`],
            [`${lockPath}.reclaimed.${process.pid}`, lockPath],
        ]);
        let statCalls = 0;
        await assert.rejects(
            () =>
                __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                        };
                    })(),
                    open: async () => {
                        throw existsError;
                    },
                    rename: async () => {},
                    stat: async () => {
                        statCalls += 1;
                        return {
                            dev: statCalls === 1 ? 1 : 3,
                            ino: statCalls === 1 ? 2 : 4,
                            mtimeMs: 1,
                        } as never;
                    },
                }),
            /exists/u
        );
        let renameMissingOpenCalls = 0;
        assert.equal(
            await __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                now: (() => {
                    let calls = 0;
                    return () => {
                        calls += 1;
                        return calls === 1 ? 0 : 10_000 + 5 * 60 * 1000;
                    };
                })(),
                open: async () => {
                    renameMissingOpenCalls += 1;
                    if (renameMissingOpenCalls === 1) throw existsError;
                    return handle;
                },
                rename: async () => {
                    throw Object.assign(new Error("gone"), { code: "ENOENT" });
                },
                stat: async () => ({ dev: 1, ino: 2, mtimeMs: 1 }) as never,
            }),
            handle
        );
        await assert.rejects(
            () =>
                __testing.acquireCodexTrustConfigLockAsync(lockPath, {
                    now: (() => {
                        let calls = 0;
                        return () => {
                            calls += 1;
                            return calls === 1 ? 0 : 10_000;
                        };
                    })(),
                    open: async () => {
                        throw existsError;
                    },
                    stat: async () => {
                        throw Object.assign(new Error("stat failed"), { code: "EACCES" });
                    },
                }),
            /stat failed/u
        );
    });

    it("covers remaining producer fallback lines", async () => {
        await withFetch(
            (url) => {
                if (url.includes("wttr.in")) {
                    return {
                        current_condition: [{}],
                        weather: [
                            {
                                date: "2026-06-06",
                                hourly: [{}],
                            },
                        ],
                    };
                }
                return {};
            },
            async () => {
                const weather = await __testing.fetchSpydebergWeather();
                assert.equal(weather.data.forecast[0]?.description, "Unknown");
            }
        );

        const binDir = path.join(tempDir, "remaining-bin");
        await import("node:fs/promises").then((fs) => fs.mkdir(binDir));
        await writeExecutable(
            path.join(binDir, "tmux"),
            "#!/usr/bin/env node\nif (process.argv.includes('capture-pane')) process.stdout.write('__ERR__:codex_not_found\\n');\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        await withEnv(
            {
                CODEX_BIN: path.join(tempDir, "missing-codex"),
                ELEVENLABS_API_KEY: "eleven",
                OPENROUTER_API_KEY: undefined,
                SYNTHETIC_API_KEY: undefined,
                QUOTAS_CODEX_HOME: path.join(tempDir, "remaining-codex-home"),
            },
            async () => {
                await withFetch(
                    (url) => {
                        if (url.includes("elevenlabs")) {
                            return {
                                subscription: {
                                    character_count: 0,
                                    character_limit: 0,
                                },
                            };
                        }
                        return {};
                    },
                    async () => {
                        await refreshCacheProducer("quotas.summary");
                    }
                );
            }
        );

        const quotas = cacheRow("quotas.summary");
        assert.ok((quotas.metadata.missing as string[]).includes("openrouter"));
        assert.ok((quotas.metadata.missing as string[]).includes("synthetic"));
    });

    it("covers system and Codex default fallbacks", async () => {
        const binDir = path.join(tempDir, "system-fallback-bin");
        await import("node:fs/promises").then((fs) => fs.mkdir(binDir));
        await writeExecutable(
            path.join(binDir, "openclaw"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "status --json") process.stdout.write(JSON.stringify({}));
else if (args === "doctor") process.stdout.write("- OK: fine\n");
else if (args === "security audit --json") process.stdout.write(JSON.stringify({}));
`
        );
        await writeExecutable(
            path.join(binDir, "df"),
            "#!/usr/bin/env node\nprocess.stderr.write('df unavailable\\n'); process.exit(1);\n"
        );
        process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
        const warnMock = mock.method(console, "warn", () => {});
        await withEnv(
            {
                OPENCLAW_BIN: path.join(binDir, "openclaw"),
                CODEX_BIN: undefined,
                QUOTAS_CODEX_HOME: path.join(tempDir, "default-codex-home"),
            },
            async () => {
                await refreshCacheProducer("system.host");
                assert.equal(
                    __testing.getCodexBin(),
                    "/home/ubuntu/.npm-global/bin/codex"
                );
            }
        );
        assert.equal(warnMock.mock.callCount(), 1);
        warnMock.mock.restore();
        const system = cacheRow("system.host").data as {
            version: { current: string; latest: string | null; updateAvailable: boolean };
            disk: { totalBytes: number; usedBytes: number; percent: number };
        };
        assert.equal(system.version.current, "unknown");
        assert.equal(system.version.latest, null);
        assert.equal(system.version.updateAvailable, false);
        assert.deepEqual(system.disk, { totalBytes: 0, usedBytes: 0, percent: 0 });
        assert.deepEqual(
            __testing.buildFallbackHostSummary("2026-06-06T00:00:00.000Z").disk,
            { totalBytes: 0, usedBytes: 0, percent: 0 }
        );
        await writeExecutable(
            path.join(binDir, "df"),
            "#!/usr/bin/env node\nprocess.stdout.write('\\n');\n"
        );
        await withEnv(
            {
                OPENCLAW_BIN: path.join(binDir, "openclaw"),
            },
            async () => {
                await refreshCacheProducer("system.host");
            }
        );
        assert.deepEqual((cacheRow("system.host").data as { disk: unknown }).disk, {
            totalBytes: 0,
            usedBytes: 0,
            percent: 0,
        });

        let hostnameCalls = 0;
        const hostnameMock = mock.method(os, "hostname", () => {
            hostnameCalls += 1;
            if (hostnameCalls === 1) {
                throw new Error("hostname unavailable");
            }
            return "fallback-host";
        });
        try {
            await withEnv(
                {
                    OPENCLAW_BIN: path.join(binDir, "openclaw"),
                },
                async () => {
                    await refreshCacheProducer("system.host");
                }
            );
        } finally {
            hostnameMock.mock.restore();
        }
        const fallbackSystem = cacheRow("system.host").data as {
            hostname: string;
            version: { hostError: string | null };
        };
        assert.equal(fallbackSystem.hostname, "fallback-host");
        assert.match(fallbackSystem.version.hostError ?? "", /hostname unavailable/u);
    });

    it("records cache producer failures before rethrowing", async () => {
        globalThis.fetch = (async () => {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }) as typeof fetch;

        await assert.rejects(
            () => refreshCacheProducer("weather.spydeberg"),
            /Request timeout/u
        );

        const row = cacheRow("weather.spydeberg");
        assert.equal(row.status, "error");
        assert.match(row.error_message ?? "", /Request timeout/u);
        assert.equal(row.consecutive_failures, 1);
    });

    it("handles aborted cache producer signals", async () => {
        const preAborted = new AbortController();
        preAborted.abort();
        await assert.rejects(
            () => refreshCacheProducer("weather.spydeberg", preAborted.signal),
            /Cache refresh aborted/u
        );

        let abortChecks = 0;
        let resolveRaceFetch: (() => void) | undefined;
        globalThis.fetch = (async () => {
            return await new Promise<Response>((resolve) => {
                resolveRaceFetch = () =>
                    resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            current_condition: [
                                {
                                    temp_C: "0",
                                    FeelsLikeC: "0",
                                    humidity: "0",
                                    windspeedKmph: "0",
                                    weatherDesc: [{ value: "Cloudy" }],
                                },
                            ],
                            weather: [],
                        }),
                    } as Response);
            });
        }) as typeof fetch;
        const racingAbortSignal = {
            get aborted() {
                abortChecks += 1;
                return abortChecks > 1;
            },
            addEventListener() {
                throw new Error("abort listener should not be registered");
            },
        } as unknown as AbortSignal;
        const racedRefresh = refreshCacheProducer("weather.spydeberg", racingAbortSignal);
        await assert.rejects(() => racedRefresh, /Cache refresh aborted/u);
        assert.ok(resolveRaceFetch);
        const reusedRefresh = refreshCacheProducer("weather.spydeberg");
        resolveRaceFetch();
        await reusedRefresh;

        const inFlightAbort = new AbortController();
        let fetchCalls = 0;
        let resolveFetch: (() => void) | undefined;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return await new Promise<Response>((resolve) => {
                resolveFetch = () =>
                    resolve({
                        ok: true,
                        status: 200,
                        headers: new Headers(),
                        json: async () => ({
                            current_condition: [
                                {
                                    temp_C: "0",
                                    FeelsLikeC: "0",
                                    humidity: "0",
                                    windspeedKmph: "0",
                                    weatherDesc: [{ value: "Cloudy" }],
                                },
                            ],
                            weather: [],
                        }),
                    } as Response);
            });
        }) as typeof fetch;
        try {
            const refresh = refreshCacheProducer(
                "weather.spydeberg",
                inFlightAbort.signal
            );
            inFlightAbort.abort();
            await assert.rejects(() => refresh, /Cache refresh aborted/u);
            const secondRefresh = refreshCacheProducer("weather.spydeberg");
            assert.equal(fetchCalls, 1);
            assert.ok(resolveFetch);
            resolveFetch();
            await secondRefresh;
            assert.equal(fetchCalls, 1);
        } finally {
            globalThis.fetch = originalFetch;
        }

        await assert.rejects(
            () => refreshCacheProducer("unsupported.cache", new AbortController().signal),
            /No backend refresh producer configured/u
        );
    });

    it("registers scheduled cache refresh jobs and validates job payloads", async () => {
        scheduledJobsTesting.clearActionHandlers();
        scheduledJobsTesting.resetSchedulerState();
        seedFreshCacheEntries([
            "weather.spydeberg",
            "quotas.summary",
            "system.openclaw",
            "system.host",
            "git.workspace",
            "moltbook.home",
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.profile",
            "moltbook.my-content",
        ]);
        try {
            registerCacheRefreshScheduledJobs();
            await withFetch(
                (url) => {
                    assert.ok(url.includes("wttr.in"));
                    return {
                        current_condition: [
                            {
                                temp_C: "7",
                                FeelsLikeC: "6",
                                humidity: "70",
                                windspeedKmph: "9",
                                weatherDesc: [{ value: "Cloudy" }],
                            },
                        ],
                        weather: [],
                    };
                },
                async () => {
                    const run = await runScheduledJob("cache.weather");
                    assert.deepEqual(run.output, {
                        key: "weather.spydeberg",
                        refreshed: ["weather.spydeberg"],
                    });
                }
            );

            db.prepare(
                "UPDATE scheduled_jobs SET action_payload_json = '{}' WHERE id = ?"
            ).run("cache.weather");
            const failedRun = await runScheduledJob("cache.weather");
            assert.equal(failedRun.status, "failed");
            assert.match(
                failedRun.message ?? "",
                /Scheduled cache job cache\.weather is missing actionPayload\.key/u
            );
        } finally {
            scheduledJobsTesting.clearActionHandlers();
            scheduledJobsTesting.resetSchedulerState();
        }
    });

    it("seeds missing enabled cache entries when scheduled jobs are registered", async () => {
        const binDir = path.join(tempDir, "registration-seed-bin");
        await mkdir(binDir);
        await writeExecutable(
            path.join(binDir, "openclaw"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "status --json") process.stdout.write(JSON.stringify({ runtimeVersion: "2026.6.6" }));
else if (args === "doctor") process.stdout.write("- OK: fine\n");
else if (args === "security audit --json") process.stdout.write(JSON.stringify({ ok: true }));
`
        );
        await writeExecutable(
            path.join(binDir, "git"),
            String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.slice(2).join(" ");
if (command === "status --short") process.stdout.write("");
else if (command === "rev-parse --abbrev-ref HEAD") process.stdout.write("main\n");
else if (command === "rev-parse --show-toplevel") process.stdout.write(args[1] + "\n");
else if (command === "rev-list --left-right --count @{upstream}...HEAD") process.stdout.write("0\t0\n");
else process.stdout.write("");
`
        );
        await writeExecutable(
            path.join(binDir, "df"),
            String.raw`#!/usr/bin/env node
process.stdout.write("Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/root 1000 250 750 25% /\n");
`
        );
        db.exec("DELETE FROM cache_entries;");
        seedFreshCacheEntries([
            "weather.spydeberg",
            "quotas.summary",
            "moltbook.home",
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.profile",
            "moltbook.my-content",
        ]);
        scheduledJobsTesting.clearActionHandlers();
        scheduledJobsTesting.resetSchedulerState();
        await withEnv({ OPENCLAW_BIN: path.join(binDir, "openclaw") }, async () => {
            const savedPath = process.env.PATH;
            process.env.PATH = `${binDir}${path.delimiter}${savedPath || ""}`;
            try {
                registerCacheRefreshScheduledJobs();
                await waitFor(
                    () =>
                        Boolean(
                            db
                                .prepare(
                                    "SELECT 1 FROM cache_entries WHERE key = 'system.openclaw'"
                                )
                                .get()
                        ) &&
                        Boolean(
                            db
                                .prepare(
                                    "SELECT 1 FROM cache_entries WHERE key = 'system.host'"
                                )
                                .get()
                        ) &&
                        Boolean(
                            db
                                .prepare(
                                    "SELECT 1 FROM cache_entries WHERE key = 'git.workspace'"
                                )
                                .get()
                        )
                );
            } finally {
                process.env.PATH = savedPath;
                scheduledJobsTesting.clearActionHandlers();
                scheduledJobsTesting.resetSchedulerState();
            }
        });

        assert.equal(cacheRow("system.openclaw").status, "fresh");
        assert.equal(cacheRow("system.host").status, "fresh");
        assert.equal(cacheRow("git.workspace").status, "fresh");
    });

    it("seeds missing interval cache entries when scheduled jobs are registered", async () => {
        db.exec("DELETE FROM cache_entries;");
        seedFreshCacheEntries([
            "quotas.summary",
            "system.openclaw",
            "system.host",
            "git.workspace",
            "moltbook.home",
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.profile",
            "moltbook.my-content",
        ]);
        scheduledJobsTesting.clearActionHandlers();
        scheduledJobsTesting.resetSchedulerState();
        try {
            await withFetch(
                (url) => {
                    assert.ok(url.includes("wttr.in"));
                    return {
                        current_condition: [
                            {
                                temp_C: "8",
                                FeelsLikeC: "7",
                                humidity: "75",
                                windspeedKmph: "10",
                                weatherDesc: [{ value: "Cloudy" }],
                            },
                        ],
                        weather: [],
                    };
                },
                async () => {
                    registerCacheRefreshScheduledJobs();
                    await waitFor(() =>
                        Boolean(
                            db
                                .prepare(
                                    "SELECT 1 FROM cache_entries WHERE key = 'weather.spydeberg'"
                                )
                                .get()
                        )
                    );
                }
            );
        } finally {
            scheduledJobsTesting.clearActionHandlers();
            scheduledJobsTesting.resetSchedulerState();
        }

        assert.equal(cacheRow("weather.spydeberg").status, "fresh");
    });

    it("does not seed disabled cache jobs when scheduled jobs are registered", () => {
        scheduledJobsTesting.clearActionHandlers();
        scheduledJobsTesting.resetSchedulerState();
        seedFreshCacheEntries([
            "weather.spydeberg",
            "quotas.summary",
            "system.openclaw",
            "system.host",
            "git.workspace",
            "moltbook.home",
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.profile",
            "moltbook.my-content",
        ]);
        registerCacheRefreshScheduledJobs();
        db.prepare("UPDATE scheduled_jobs SET enabled = 0 WHERE id = ?").run(
            "cache.weather"
        );
        db.exec("DELETE FROM cache_entries;");
        seedFreshCacheEntries([
            "quotas.summary",
            "system.openclaw",
            "system.host",
            "git.workspace",
            "moltbook.home",
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.profile",
            "moltbook.my-content",
        ]);
        try {
            registerCacheRefreshScheduledJobs();
            assert.equal(
                db
                    .prepare("SELECT 1 FROM cache_entries WHERE key = 'weather.spydeberg'")
                    .get(),
                undefined
            );
        } finally {
            scheduledJobsTesting.clearActionHandlers();
            scheduledJobsTesting.resetSchedulerState();
        }
    });

    it("records seed failures without blocking scheduled job registration", async () => {
        const warn = mock.method(console, "warn", () => {});
        db.exec("DELETE FROM cache_entries;");
        seedFreshCacheEntries([
            "weather.spydeberg",
            "quotas.summary",
            "git.workspace",
            "moltbook.home",
            "moltbook.feed.hot",
            "moltbook.feed.new",
            "moltbook.profile",
            "moltbook.my-content",
        ]);
        scheduledJobsTesting.clearActionHandlers();
        scheduledJobsTesting.resetSchedulerState();
        await withEnv(
            { OPENCLAW_BIN: path.join(tempDir, "missing-openclaw") },
            async () => {
                registerCacheRefreshScheduledJobs();
                await waitFor(() => warn.mock.callCount() > 0);
            }
        );
        try {
            assert.ok(warn.mock.callCount() > 0);
            assert.ok(
                db.prepare("SELECT 1 FROM scheduled_jobs WHERE id = 'cache.system'").get()
            );
        } finally {
            warn.mock.restore();
            scheduledJobsTesting.clearActionHandlers();
            scheduledJobsTesting.resetSchedulerState();
        }
    });

    it("covers backup producer empty and malformed timestamp fallbacks", async () => {
        const binDir = path.join(tempDir, "backup-fallback-bin");
        await mkdir(binDir);
        await writeExecutable(
            path.join(binDir, "docker"),
            `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "exec kopia kopia snapshot list --all --json") {
  if (process.env.EMPTY_BACKUP_OUTPUT === "1") process.exit(0);
  process.stdout.write(JSON.stringify([
    { id: "ignored" },
    { id: "invalid-end", source: { path: "/source/openclaw" }, endTime: "not-a-date", stats: {}, retentionReason: "latest" },
    { id: "invalid-start", source: { path: "/source/openclaw" }, startTime: "also-not-a-date", stats: {}, retentionReason: [] },
    { id: "start-only", source: { path: "/source/docker" }, startTime: "2099-01-01T00:00:00.000Z", stats: {}, retentionReason: [] },
    { id: "older-end", source: { path: "/source/docker" }, endTime: "2098-01-01T00:00:00.000Z", stats: { fileCount: 1 }, retentionReason: [] },
    { id: "latest-end", source: { path: "/source/docker" }, endTime: "2099-01-02T00:00:00.000Z", stats: { fileCount: 2 }, retentionReason: ["latest"] },
    { id: "untimed", source: { path: "/source/projects" }, stats: {}, retentionReason: "latest" }
  ]));
} else if (args === "exec walg wal-g backup-list --detail --json") {
  if (process.env.EMPTY_BACKUP_OUTPUT === "1") process.exit(0);
  process.stdout.write(process.env.EMPTY_WALG === "1" ? "[]" : JSON.stringify([
    { backup_name: "finish", finish_time: "2099-01-02T00:00:00.000Z" },
    { backup_name: "time", time: "2099-01-01T00:00:00.000Z" }
  ]));
}
`
        );

        await withEnv({ MIRA_DOCKER_BIN: path.join(binDir, "docker") }, async () => {
            await refreshCacheProducer("backup.kopia.status");
            await refreshCacheProducer("backup.walg.status");
        });
        const kopia = cacheRow("backup.kopia.status").data as {
            latest: Array<{
                id: string;
                endTime: string | null;
                retentionReason: unknown[];
            }>;
            snapshotsByPath: Array<{
                path: string;
                snapshots: Array<{ id: string; fileCount: number | null }>;
            }>;
            stale: Array<{ path: string }>;
        };
        assert.equal(kopia.latest[0]?.id, "latest-end");
        assert.equal(kopia.latest[0]?.endTime, "2099-01-02T00:00:00.000Z");
        assert.deepEqual(kopia.latest[0]?.retentionReason, ["latest"]);
        assert.deepEqual(
            kopia.snapshotsByPath
                .find((group) => group.path === "/source/docker")
                ?.snapshots.map((snapshot) => [snapshot.id, snapshot.fileCount]),
            [
                ["latest-end", 2],
                ["start-only", null],
                ["older-end", 1],
            ]
        );
        assert.deepEqual(kopia.stale, [
            { path: "/source/openclaw", endTime: "not-a-date" },
            { path: "/source/projects", endTime: null },
        ]);

        const walg = cacheRow("backup.walg.status").data as {
            latest: { backupName: string | null; modified: string | null };
            stale: boolean;
        };
        assert.equal(walg.latest.backupName, "finish");
        assert.equal(walg.latest.modified, "2099-01-02T00:00:00.000Z");
        assert.equal(walg.stale, false);

        await withEnv(
            { EMPTY_WALG: "1", MIRA_DOCKER_BIN: path.join(binDir, "docker") },
            async () => {
                await refreshCacheProducer("backup.walg.status");
            }
        );
        const emptyWalg = cacheRow("backup.walg.status").data as {
            latestAgeHours: number | null;
            stale: boolean;
        };
        assert.equal(emptyWalg.latestAgeHours, null);
        assert.equal(emptyWalg.stale, true);

        await withEnv(
            { EMPTY_BACKUP_OUTPUT: "1", MIRA_DOCKER_BIN: path.join(binDir, "docker") },
            async () => {
                await refreshCacheProducer("backup.kopia.status");
                await refreshCacheProducer("backup.walg.status");
            }
        );
        assert.deepEqual(
            (cacheRow("backup.kopia.status").data as { latest: unknown[] }).latest,
            []
        );
        assert.equal(
            (cacheRow("backup.walg.status").data as { latest: unknown }).latest,
            null
        );
    });

    it("covers additional producer fallback branches", async () => {
        await withEnv({ MOLTBOOK_API_KEY: "test-key" }, async () => {
            await withFetch(
                (url) => {
                    if (url.endsWith("/home")) return {};
                    if (url.includes("feed")) return {};
                    return { recentPosts: "bad", recentComments: "bad" };
                },
                async () => {
                    await refreshCacheProducer("moltbook.my-content");
                    await refreshCacheProducer("moltbook.profile");
                }
            );
        });
        assert.deepEqual(
            (cacheRow("moltbook.my-content").data as { comments: unknown[] }).comments,
            []
        );
        assert.equal(
            (cacheRow("moltbook.profile").data as { agent: unknown }).agent,
            null
        );

        await withFetch(
            (url) => {
                if (url.includes("wttr.in")) {
                    return {
                        current_condition: [{}],
                        weather: [{ date: "2026-06-06", hourly: "bad" }],
                    };
                }
                return {};
            },
            async () => {
                const weather = await __testing.fetchSpydebergWeather();
                assert.equal(weather.data.forecast[0]?.description, "Unknown");
            }
        );

        await withFetch(
            (url) => {
                if (url.includes("wttr.in")) return { httpStatus: 500 };
                return { current: {}, daily: { time: ["2026-06-06"] } };
            },
            async () => {
                const weather = await __testing.fetchSpydebergWeather();
                assert.equal(weather.data.forecast[0]?.minTempC, null);
                assert.equal(weather.data.forecast[0]?.maxTempC, null);
            }
        );
    });
});
