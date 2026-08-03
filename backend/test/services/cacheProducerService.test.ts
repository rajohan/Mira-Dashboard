import { describe, expect, it, jest } from "bun:test";
import path from "node:path";

import { parseGitWorkspaceSummary } from "../../../contracts/git.ts";
import { parseJsonText, requestUrl } from "../../../test/support/fetch.ts";
import { database } from "../../src/database/connection.ts";
import * as processModule from "../../src/lib/processes.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend cache producer and Gateway services", () => {
    const {
        FakeGatewayWebSocket,
        cleanupCallbacks,
        createTemporaryRoot,
        rememberEnvironment,
        waitFor,
    } = createServiceBehaviorHarness();
    it("refreshes weather cache through the Open-Meteo fallback when wttr fails", async () => {
        const originalFetch = fetch;
        const calls: string[] = [];
        cleanupCallbacks.push(() => {
            Object.defineProperty(globalThis, "fetch", {
                configurable: true,
                value: originalFetch,
                writable: true,
            });
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'weather.spydeberg'")
                .run();
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: (input: Parameters<typeof fetch>[0]) => {
                return Promise.try(() => {
                    const url = requestUrl(input);
                    calls.push(url);
                    if (url.includes("wttr.in")) {
                        return new Response("unavailable", {
                            status: 503,
                        });
                    }
                    return Response.json({
                        current: {
                            apparent_temperature: -2,
                            relative_humidity_2m: 80,
                            temperature_2m: 1,
                            weather_code: 61,
                            wind_speed_10m: 12,
                        },
                        daily: {
                            time: ["2026-06-24", "2026-06-25"],
                            temperature_2m_max: [4, 5],
                            temperature_2m_min: [-1, 0],
                            weather_code: [61, 0],
                        },
                    });
                });
            },
            writable: true,
        });
        const { refreshWeatherCache } =
            await import("../../src/services/cacheRefresh/weatherCacheProducer.ts");
        expect(refreshWeatherCache()).resolves.toEqual({
            refreshed: ["weather.spydeberg"],
        });
        expect(calls.some((url) => url.includes("wttr.in"))).toBe(true);
        expect(calls.some((url) => url.includes("api.open-meteo.com"))).toBe(true);
        const row = database
            .prepare(
                "SELECT data_json, source, metadata_json, status FROM cache_entries WHERE key = 'weather.spydeberg'"
            )
            .get() as
            | {
                  data_json: string;
                  metadata_json: string;
                  source: string;
                  status: string;
              }
            | undefined;
        expect(row).toMatchObject({
            source: "open-meteo",
            status: "fresh",
        });
        expect(JSON.parse(row!.data_json)).toMatchObject({
            description: "Rain",
            location: "Spydeberg",
            temperatureC: 1,
        });
        expect(JSON.parse(row!.metadata_json)).toMatchObject({
            fallbackUsed: true,
            providerPriority: ["wttr.in", "open-meteo"],
        });
    });
    it("refreshes git cache from sanitized command output", async () => {
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'git.workspace'")
                .run();
        });
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((file, arguments_) => {
                return Promise.try(() => {
                    expect(file).toBe("git");
                    const gitArguments = [...arguments_];
                    let repo = "";
                    let commandArguments = gitArguments;
                    if (gitArguments[0] === "-C") {
                        repo = String(gitArguments[1]);
                        commandArguments = gitArguments.slice(2);
                    }
                    const command = commandArguments.join(" ");
                    if (command === "rev-parse --is-inside-work-tree") {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "true\n",
                        };
                    }
                    if (command === "branch --show-current") {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "main\n",
                        };
                    }
                    if (command === "rev-parse HEAD") {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: "abcdef1234567890\n",
                        };
                    }
                    if (command === "remote -v") {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: [
                                `origin\thttps://token@example.com/${path.basename(repo)}.git (fetch)`,
                                `origin\tgit@example.com:${path.basename(repo)}.git (push)`,
                                "",
                            ].join("\n"),
                        };
                    }
                    if (command === "status --short") {
                        return {
                            code: 0,
                            stderr: "",
                            stdout: [
                                " M modified.txt",
                                "A  staged.txt",
                                "D  deleted.txt",
                                "R  old.txt -> new.txt",
                                "?? untracked.txt",
                                "UU conflicted.txt",
                                "",
                            ].join("\n"),
                        };
                    }
                    return {
                        code: 2,
                        stderr: `unexpected git args for ${repo}: ${command}`,
                        stdout: "",
                    };
                });
            });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        const { refreshGitCache } =
            await import("../../src/services/cacheRefresh/gitCacheProducer.ts");
        const result = await refreshGitCache();
        expect(result).toEqual({
            refreshed: ["git.workspace"],
        });
        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'git.workspace'"
            )
            .get() as {
            data_json: string;
            metadata_json: string;
            status: string;
        };
        expect(row.status).toBe("fresh");
        const data = parseGitWorkspaceSummary(JSON.parse(row.data_json));
        expect(data.dirtyRepos).toEqual(["openclaw", "mira-dashboard", "docker"]);
        expect(data.missingRepos).toEqual([]);
        expect(data.dirtyCount).toBe(3);
        expect(data.repos.find((repo) => repo.key === "mira-dashboard")).toMatchObject({
            branch: "main",
            category: "project",
            checkedAt: expect.any(String),
            dirty: true,
            exists: true,
            path: expect.any(String),
            remote: "https://example.com/checkout.git",
            statusSummary: {
                conflicted: 1,
                deleted: 1,
                modified: 1,
                renamed: 1,
                staged: 3,
                total: 6,
                untracked: 1,
            },
            statusTruncated: false,
        });
        expect(JSON.parse(row.metadata_json)).toMatchObject({
            summary: {
                dirtyCount: 3,
                dirtyRepos: ["openclaw", "mira-dashboard", "docker"],
                missingRepos: [],
                repoCount: 3,
            },
        });
    });
    it("refreshes quota cache from provider and Codex status output", async () => {
        for (const key of [
            "OPENROUTER_API_KEY",
            "ELEVENLABS_API_KEY",
            "SYNTHETIC_API_KEY",
            "QUOTAS_CODEX_HOME",
            "CODEX_BIN",
        ]) {
            rememberEnvironment(key);
        }
        const codexHome = createTemporaryRoot("mira-quota-codex-home-");
        process.env.OPENROUTER_API_KEY = "openrouter-key";
        process.env.ELEVENLABS_API_KEY = "elevenlabs-key";
        process.env.SYNTHETIC_API_KEY = "synthetic-key";
        process.env.QUOTAS_CODEX_HOME = codexHome;
        process.env.CODEX_BIN = "/usr/local/bin/codex";
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'quotas.summary'")
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(((
            input: Request | string | URL
        ) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                if (url === "https://openrouter.ai/api/v1/key") {
                    return Response.json({
                        data: {
                            usage: 2,
                            usage_monthly: 7,
                        },
                    });
                }
                if (url === "https://openrouter.ai/api/v1/credits") {
                    return Response.json({
                        data: {
                            total_credits: 10,
                        },
                    });
                }
                if (url === "https://api.elevenlabs.io/v1/user") {
                    return Response.json({
                        subscription: {
                            character_count: 250,
                            character_limit: 1000,
                            next_character_count_reset_unix: 1_800_000_000,
                            tier: "creator",
                        },
                    });
                }
                if (url === "https://api.synthetic.new/v2/quotas") {
                    return Response.json({
                        rollingFiveHourLimit: {
                            limited: false,
                            max: 100,
                            nextTickAt: "soon",
                            remaining: 75,
                            tickPercent: 10,
                        },
                        search: {
                            hourly: {
                                limit: 20,
                                renewsAt: "later",
                                requests: 5,
                            },
                        },
                        subscription: {
                            limit: 50,
                            renewsAt: "tomorrow",
                            requests: 10,
                        },
                        weeklyTokenLimit: {
                            maxCredits: "$100.00",
                            nextRegenAt: "weekly",
                            nextRegenCredits: "$20.00",
                            remainingCredits: "$40.00",
                        },
                    });
                }
                return new Response("not found", {
                    status: 404,
                });
            });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockResolvedValueOnce({
                code: 0,
                stderr: "",
                stdout: [
                    "5h limit: loading",
                    "Weekly limit: 65% left (resets Monday)",
                ].join("\n"),
            })
            .mockResolvedValue({
                code: 0,
                stderr: "",
                stdout: [
                    "Account: raymond@example.com",
                    "Model: gpt-5.5 (high)",
                    "5h limit: 80% left (resets 13:00)",
                    "Weekly limit: 65% left (resets Monday)",
                    "",
                ].join("\n"),
            });
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        expect(
            await refreshCacheProducer("quotas.summary", undefined, {
                force: true,
            })
        ).toEqual({
            refreshed: ["quotas.summary"],
        });
        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'quotas.summary'"
            )
            .get() as {
            data_json: string;
            metadata_json: string;
            status: string;
        };
        expect(row.status).toBe("fresh");
        const initialBashCalls = runProcessSpy.mock.calls.filter(
            ([file]) => file === "bash"
        );
        const initialTmuxCalls = runProcessSpy.mock.calls.filter(
            ([file]) => file === "tmux"
        );
        expect(initialBashCalls).toHaveLength(2);
        expect(initialTmuxCalls).toHaveLength(2);
        expect(initialTmuxCalls.map(([, arguments_]) => arguments_.at(-1))).toEqual(
            initialBashCalls.map((call) => call[2]?.env?.MIRA_QUOTA_CODEX_SESSION)
        );
        expect(runProcessSpy.mock.calls[0]?.[1]?.[1]).toContain(
            'grep -Eiq "Weekly limit:"'
        );
        const data = parseJsonText(row.data_json);
        expect(data).toMatchObject({
            elevenlabs: {
                percentUsed: 25,
                remaining: 750,
                tier: "creator",
                total: 1000,
                used: 250,
            },
            openai: {
                fiveHourLeftPercent: 80,
                percentUsed: 35,
                weeklyLeftPercent: 65,
            },
            openrouter: {
                percentUsed: 20,
                remaining: 8,
                totalCredits: 10,
                usage: 2,
                usageMonthly: 7,
            },
            synthetic: {
                rollingFiveHourLimit: {
                    percentUsed: 25,
                    remaining: 75,
                },
                searchHourly: {
                    percentUsed: 25,
                    remaining: 15,
                },
                subscription: {
                    percentUsed: 20,
                    remaining: 40,
                },
                weeklyTokenLimit: {
                    nextRegenPercent: 20,
                    percentRemaining: 40,
                },
            },
        });
        expect(data).not.toMatchObject({
            openai: {
                account: expect.anything(),
            },
        });
        expect(parseJsonText(row.metadata_json)).toMatchObject({
            missing: [],
            producers: ["openrouter", "elevenlabs", "synthetic", "openai"],
        });
        runProcessSpy.mockReset().mockResolvedValue({
            code: 0,
            stderr: "",
            stdout: [
                "Account: raymond@example.com",
                "Model: gpt-5.6-sol (max)",
                "Weekly limit: 65% left (resets Monday)",
                "",
            ].join("\n"),
        });
        await refreshCacheProducer("quotas.summary", undefined, {
            force: true,
        });
        expect(runProcessSpy.mock.calls.filter(([file]) => file === "bash")).toHaveLength(
            1
        );
        expect(runProcessSpy.mock.calls.filter(([file]) => file === "tmux")).toHaveLength(
            1
        );
        const weeklyOnlyQuota = parseJsonText(
            (
                database
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'quotas.summary'"
                    )
                    .get() as {
                    data_json: string;
                }
            ).data_json
        );
        expect(weeklyOnlyQuota).toMatchObject({
            openai: {
                percentUsed: 35,
                weeklyLeftPercent: 65,
            },
        });
        expect(weeklyOnlyQuota).not.toMatchObject({
            openai: {
                fiveHourLeftPercent: expect.anything(),
            },
        });
        runProcessSpy.mockReset().mockResolvedValue({
            code: 0,
            stderr: "",
            stdout: "Codex update screen without quota limits",
        });
        await refreshCacheProducer("quotas.summary", undefined, {
            force: true,
        });
        expect(runProcessSpy.mock.calls.filter(([file]) => file === "bash")).toHaveLength(
            2
        );
        expect(runProcessSpy.mock.calls.filter(([file]) => file === "tmux")).toHaveLength(
            2
        );
        const repeatedParseFailure = parseJsonText(
            (
                database
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'quotas.summary'"
                    )
                    .get() as {
                    data_json: string;
                }
            ).data_json
        );
        expect(repeatedParseFailure).toMatchObject({
            openai: {
                note: "Could not parse Codex /status output",
                status: "error",
            },
        });
        runProcessSpy.mockReset().mockResolvedValue({
            code: 1,
            stderr: "Account: private@example.test\nupdate failed",
            stdout: "",
        });
        await refreshCacheProducer("quotas.summary", undefined, {
            force: true,
        });
        expect(runProcessSpy.mock.calls.filter(([file]) => file === "bash")).toHaveLength(
            1
        );
        expect(runProcessSpy.mock.calls.filter(([file]) => file === "tmux")).toHaveLength(
            1
        );
        const commandFailure = parseJsonText(
            (
                database
                    .prepare(
                        "SELECT data_json FROM cache_entries WHERE key = 'quotas.summary'"
                    )
                    .get() as {
                    data_json: string;
                }
            ).data_json
        );
        expect(commandFailure).toMatchObject({
            openai: {
                note: "codex quota exited 1: update failed",
                status: "error",
            },
        });
    });
    it("refreshes weather through the Open-Meteo fallback when wttr.in fails", async () => {
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'weather.spydeberg'")
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(((
            input: Request | string | URL
        ) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                if (url.startsWith("https://wttr.in/Spydeberg")) {
                    return new Response("upstream unavailable", {
                        status: 503,
                    });
                }
                if (url.startsWith("https://api.open-meteo.com/")) {
                    return Response.json({
                        current: {
                            apparent_temperature: 12.5,
                            relative_humidity_2m: 94,
                            temperature_2m: 13,
                            weather_code: 61,
                            wind_speed_10m: 5,
                        },
                        daily: {
                            temperature_2m_max: [21, 22, 20],
                            temperature_2m_min: [14, 15, 13],
                            time: ["2026-06-26", "2026-06-27", "2026-06-28"],
                            weather_code: [0, 95, "bad"],
                        },
                    });
                }
                return new Response("not found", {
                    status: 404,
                });
            });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        expect(
            refreshCacheProducer("weather.spydeberg", undefined, {
                force: true,
            })
        ).resolves.toEqual({
            refreshed: ["weather.spydeberg"],
        });
        const row = database
            .prepare(
                "SELECT data_json, metadata_json, status FROM cache_entries WHERE key = 'weather.spydeberg'"
            )
            .get() as {
            data_json: string;
            metadata_json: string;
            status: string;
        };
        expect(row.status).toBe("fresh");
        const data = parseJsonText(row.data_json);
        expect(data).toMatchObject({
            description: "Rain",
            forecast: [
                {
                    date: "2026-06-26",
                    description: "Clear",
                },
                {
                    date: "2026-06-27",
                    description: "Thunderstorm",
                },
                {
                    date: "2026-06-28",
                    description: "Unknown",
                },
            ],
            humidityPercent: 94,
            location: "Spydeberg",
            temperatureC: 13,
        });
        expect(parseJsonText(row.metadata_json)).toMatchObject({
            fallbackReason: expect.stringContaining("HTTP 503"),
            fallbackUsed: true,
            providerPriority: ["wttr.in", "open-meteo"],
        });
    });
    it("records Moltbook sub-request failures without discarding successful cache writes", async () => {
        rememberEnvironment("MOLTBOOK_API_KEY");
        process.env.MOLTBOOK_API_KEY = "moltbook-key";
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'")
                .run();
        });
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(((
            input: Request | string | URL
        ) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                if (url.endsWith("/home")) {
                    return Response.json({
                        activity_on_your_posts: [
                            {
                                id: "activity-1",
                            },
                        ],
                        latest_moltbook_announcement: {
                            author_name: "OpenClaw",
                            created_at: "2026-06-25T10:00:00.000Z",
                            post_id: "post-1",
                            preview: "Hello",
                            title: "Announcement",
                        },
                        posts_from_accounts_you_follow: [
                            {
                                id: "followed-1",
                            },
                        ],
                        what_to_do_next: [
                            {
                                label: "reply",
                            },
                        ],
                        your_direct_messages: {
                            pending_request_count: "2",
                            unread_message_count: "3",
                        },
                    });
                }
                if (url.endsWith("/feed?sort=hot&limit=25")) {
                    return Response.json({
                        feed_filter: "all",
                        feed_type: "hot",
                        has_more: true,
                        posts: [
                            {
                                id: "hot-1",
                            },
                        ],
                        tip: "keep going",
                    });
                }
                if (url.endsWith("/feed?sort=new&limit=25")) {
                    return new Response("feed failed", {
                        status: 502,
                    });
                }
                if (url.endsWith("/agents/profile?name=mira_2026")) {
                    return Response.json({
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
                    });
                }
                return new Response("not found", {
                    status: 404,
                });
            });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        expect(
            refreshCacheProducer("moltbook", undefined, {
                force: true,
            })
        ).rejects.toThrow("Moltbook refresh had sub-request failures");
        const rows = database
            .prepare(
                "SELECT key, data_json, error_message, status FROM cache_entries WHERE key LIKE 'moltbook.%' ORDER BY key"
            )
            .all() as Array<{
            data_json: string | null;
            error_message: string | null;
            key: string;
            status: string;
        }>;
        expect(rows.map((row) => [row.key, row.status])).toEqual([
            ["moltbook.feed.hot", "fresh"],
            ["moltbook.feed.new", "error"],
            ["moltbook.home", "fresh"],
            ["moltbook.my-content", "fresh"],
            ["moltbook.profile", "fresh"],
        ]);
        expect(
            JSON.parse(rows.find((row) => row.key === "moltbook.home")?.data_json ?? "{}")
        ).toMatchObject({
            activityOnYourPostsCount: 1,
            pendingRequestCount: 2,
            unreadMessageCount: 3,
        });
        expect(
            rows.find((row) => row.key === "moltbook.feed.new")?.error_message
        ).toContain("Moltbook refresh had sub-request failures");
    });
    it("coordinates cache refresh in-flight sharing and abort handling", async () => {
        cleanupCallbacks.push(() => {
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'weather.spydeberg'")
                .run();
        });
        let weatherResponses = 0;
        let releaseWeather: (() => void) | undefined;
        const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation((async (
            input: Request | string | URL
        ) => {
            const url = requestUrl(input);
            if (url.startsWith("https://wttr.in/Spydeberg")) {
                weatherResponses += 1;
                const gate = Promise.withResolvers<void>();
                releaseWeather = gate.resolve;
                await gate.promise;
                return Response.json({
                    current_condition: [
                        {
                            FeelsLikeC: "13",
                            humidity: "80",
                            temp_C: "14",
                            weatherDesc: [
                                {
                                    value: "Clear",
                                },
                            ],
                            windspeedKmph: "5",
                        },
                    ],
                    weather: [
                        {
                            date: "2026-06-26",
                            hourly: [
                                {
                                    weatherDesc: [
                                        {
                                            value: "Clear",
                                        },
                                    ],
                                },
                            ],
                            maxtempC: "21",
                            mintempC: "14",
                        },
                    ],
                });
            }
            return new Response("not found", {
                status: 404,
            });
        }) as typeof fetch);
        cleanupCallbacks.push(() => fetchSpy.mockRestore());
        const { refreshCacheProducer } =
            await import("../../src/services/cacheRefresh/cacheRefreshRuntime.ts");
        const firstRefresh = refreshCacheProducer("weather.spydeberg", undefined, {
            force: true,
        });
        await waitFor(() => weatherResponses === 1);
        const secondRefresh = refreshCacheProducer("weather.spydeberg");
        const abortController = new AbortController();
        const abortedRefresh = refreshCacheProducer(
            "weather.spydeberg",
            abortController.signal
        );
        abortController.abort();
        const abortedRefreshState = (async () => {
            try {
                await abortedRefresh;
                return "resolved" as const;
            } catch (error) {
                return error instanceof Error ? error.message : "rejected without error";
            }
        })();
        expect(
            await Promise.race([
                abortedRefreshState,
                (async () => {
                    await Bun.sleep(10);
                    return "pending" as const;
                })(),
            ])
        ).toBe("pending");
        releaseWeather?.();
        expect(firstRefresh).resolves.toEqual({
            refreshed: ["weather.spydeberg"],
        });
        expect(secondRefresh).resolves.toEqual({
            refreshed: ["weather.spydeberg"],
        });
        expect(abortedRefreshState).resolves.toBe("Cache refresh aborted");
        expect(weatherResponses).toBe(1);
    });
    it("drives OpenClaw Gateway client connect and request lifecycle with a fake socket", async () => {
        const originalWebSocket = WebSocket;
        cleanupCallbacks.push(() => {
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
            FakeGatewayWebSocket.instances = [];
        });
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeGatewayWebSocket,
            writable: true,
        });
        const helloPayloads: unknown[] = [];
        const events: unknown[] = [];
        const connectErrors: string[] = [];
        const closeEvents: Array<{
            code: number;
            reason: string;
        }> = [];
        const identityRoot = createTemporaryRoot("mira-gateway-device-identity-");
        const { loadOrCreateDeviceIdentity, OpenClawGatewayClient } =
            await import("../../src/lib/openclawGatewayClient/client.ts");
        const deviceIdentity = loadOrCreateDeviceIdentity(
            path.join(identityRoot, "device.json")
        );
        const client = new OpenClawGatewayClient({
            clientName: "dashboard-client",
            deviceFamily: "SERVER",
            deviceIdentity,
            onClose: (code, reason) => {
                closeEvents.push({
                    code,
                    reason,
                });
            },
            onConnectError: (error) => {
                connectErrors.push(error.message);
            },
            onEvent: (event) => {
                events.push(event);
            },
            onHelloOk: (payload) => {
                helloPayloads.push(payload);
            },
            platform: "LINUX",
            requestTimeoutMs: 100,
            token: " gateway-token ",
            url: "ws://gateway.test",
        });
        client.start();
        const socket = FakeGatewayWebSocket.instances.at(-1);
        expect(socket).toBeDefined();
        expect(socket?.url).toBe("ws://gateway.test");
        socket?.open();
        socket?.message("{");
        socket?.message(
            JSON.stringify({
                type: "noop",
            })
        );
        expect(socket?.sent).toHaveLength(0);
        socket?.message(
            JSON.stringify({
                event: "connect.challenge",
                payload: {
                    nonce: "nonce-1",
                },
                type: "event",
            })
        );
        await waitFor(() => socket?.sent.length === 1);
        const connectFrame = JSON.parse(socket!.sent[0]!) as {
            id: string;
            method: string;
            params: {
                auth: {
                    token: string;
                };
                client: {
                    deviceFamily: string;
                    id: string;
                    platform: string;
                };
                device: {
                    id: string;
                    nonce: string;
                    publicKey: string;
                    signature: string;
                };
                role: string;
            };
            type: string;
        };
        expect(connectFrame).toMatchObject({
            method: "connect",
            params: {
                auth: {
                    token: "gateway-token",
                },
                client: {
                    deviceFamily: "SERVER",
                    id: "dashboard-client",
                    platform: "LINUX",
                },
                device: {
                    id: deviceIdentity.deviceId,
                    nonce: "nonce-1",
                    publicKey: expect.any(String),
                    signature: expect.any(String),
                },
                role: "operator",
            },
            type: "req",
        });
        socket?.message(
            JSON.stringify({
                id: connectFrame.id,
                isOk: true,
                payload: {
                    policy: {
                        tickIntervalMs: 5,
                    },
                    type: "hello-ok",
                },
                type: "response",
            })
        );
        await waitFor(() => helloPayloads.length === 1);
        socket?.message(
            JSON.stringify({
                event: "tick",
                seq: 2,
                type: "event",
            })
        );
        await waitFor(() => events.length === 1);
        expect(events).toContainEqual(
            expect.objectContaining({
                event: "tick",
                seq: 2,
            })
        );
        const success = client.request("demo.method", {
            value: 1,
        });
        await waitFor(() => socket!.sent.length === 2);
        const successFrame = JSON.parse(socket!.sent[1]!) as {
            id: string;
        };
        socket?.message(
            JSON.stringify({
                id: successFrame.id,
                ok: true,
                payload: {
                    value: 2,
                },
                type: "res",
            })
        );
        expect(success).resolves.toEqual({
            value: 2,
        });
        const failure = client.request("demo.fail");
        await waitFor(() => socket!.sent.length === 3);
        const failureFrame = JSON.parse(socket!.sent[2]!) as {
            id: string;
        };
        socket?.message(
            JSON.stringify({
                error: {
                    message: "gateway rejected",
                },
                id: failureFrame.id,
                isOk: false,
                type: "response",
            })
        );
        expect(failure).rejects.toThrow("gateway rejected");
        const extendedRequest = client.request(
            "demo.extended",
            {},
            {
                timeoutMs: 500,
            }
        );
        await waitFor(() => socket!.sent.length === 4);
        const extendedFrame = JSON.parse(socket!.sent[3]!) as {
            id: string;
        };
        await Bun.sleep(150);
        socket?.message(
            JSON.stringify({
                id: extendedFrame.id,
                isOk: true,
                payload: {
                    extended: true,
                },
                type: "response",
            })
        );
        expect(extendedRequest).resolves.toEqual({
            extended: true,
        });
        const timeoutSpy = jest.spyOn(globalThis, "setTimeout");
        try {
            const fractionalRequest = client.request(
                "demo.fractional",
                {},
                {
                    timeoutMs: 0.5,
                }
            );
            expect(timeoutSpy.mock.calls.at(-1)?.[1]).toBe(1);
            await waitFor(() => socket!.sent.length === 5);
            const fractionalFrame = JSON.parse(socket!.sent[4]!) as {
                id: string;
            };
            socket?.message(
                JSON.stringify({
                    id: fractionalFrame.id,
                    ok: true,
                    payload: {
                        fractional: true,
                    },
                    type: "res",
                })
            );
            expect(fractionalRequest).resolves.toEqual({
                fractional: true,
            });
            const boundedRequest = client.request(
                "demo.bounded",
                {},
                {
                    timeoutMs: Number.MAX_SAFE_INTEGER,
                }
            );
            expect(timeoutSpy.mock.calls.at(-1)?.[1]).toBe(2_147_483_647);
            const boundedFrame = JSON.parse(socket!.sent[5]!) as {
                id: string;
            };
            socket?.message(
                JSON.stringify({
                    id: boundedFrame.id,
                    ok: true,
                    payload: {
                        bounded: true,
                    },
                    type: "res",
                })
            );
            expect(await boundedRequest).toEqual({
                bounded: true,
            });
        } finally {
            timeoutSpy.mockRestore();
        }
        socket!.sendError = new Error("send failed");
        expect(client.request("demo.send-fail")).rejects.toThrow("send failed");
        socket!.sendError = undefined;
        const closedRequest = client.request("demo.closed");
        await waitFor(() => socket!.sent.length === 7);
        socket?.close(4001, "gone");
        expect(closedRequest).rejects.toThrow("gateway closed (4001): gone");
        expect(closeEvents).toContainEqual({
            code: 4001,
            reason: "gone",
        });
        const missingNonceClient = new OpenClawGatewayClient({
            onConnectError: (error) => {
                connectErrors.push(error.message);
            },
            requestTimeoutMs: 100,
            url: "ws://gateway.test/missing-nonce",
        });
        missingNonceClient.start();
        const missingNonceSocket = FakeGatewayWebSocket.instances.at(-1);
        missingNonceSocket?.open();
        missingNonceSocket?.message(
            JSON.stringify({
                event: "connect.challenge",
                payload: {},
                type: "event",
            })
        );
        await waitFor(
            () => missingNonceSocket?.closeReason === "connect challenge missing nonce"
        );
        expect(connectErrors).toContain("gateway connect challenge missing nonce");
        missingNonceClient.stop();
        client.stop();
        expect(socket?.closeCode).toBe(4001);
    });
    it("reports disconnected gateway state without starting a Gateway client", async () => {
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        gateway.shutdown();
        expect(gateway.isConnected()).toBe(false);
        expect(gateway.getStatus()).toEqual({
            gateway: "disconnected",
            sessions: 0,
        });
        expect(gateway.getGatewayWs()).toBeUndefined();
        expect(gateway.request("sessions.list", {})).rejects.toThrow(
            "Gateway not connected"
        );
        expect(gateway.sendSessionMessage("agent:main:main", "hello")).rejects.toThrow(
            "Gateway not connected"
        );
        expect(gateway.abortSessionRun("agent:main:main")).rejects.toThrow(
            "Gateway not connected"
        );
        expect(gateway.deleteSession("agent:main:main")).rejects.toThrow(
            "Gateway not connected"
        );
    });
});
