import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { collectCodexQuota } from "./codexQuotaCollector.ts";
import { collectGitWorkspacePayload } from "./gitWorkspaceCollector.ts";
import { collectQuotaPayload } from "./quotaCollector.ts";
import { collectWeatherPayload, weatherConditionFromCode } from "./weatherCollector.ts";

function jsonResponse(value: unknown): Response {
    return Response.json(value, {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
    return input instanceof Request ? input.url : input.toString();
}

function quotaProviderResponse(
    url: string,
    invalidProvider?: "elevenlabs" | "openai" | "openrouter" | "synthetic"
): Response {
    if (url.endsWith("/v1/user")) {
        return jsonResponse({
            subscription: {
                character_count: 25,
                character_limit: 100,
                next_character_count_reset_unix_ms:
                    invalidProvider === "elevenlabs" ? 8_640_000_000_000_001 : 2000,
            },
        });
    }
    if (url.endsWith("/api/v1/key")) {
        return jsonResponse({
            data: {
                limit:
                    invalidProvider === "openrouter" ? Number.MAX_SAFE_INTEGER + 1 : 10,
                limit_remaining: 8,
                usage: 2,
            },
        });
    }
    if (url.endsWith("/api/v1/credits")) {
        return jsonResponse({ data: { total_credits: 10 } });
    }
    if (url.endsWith("/v2/quotas")) {
        return jsonResponse({
            rollingFiveHourLimit: {
                max: invalidProvider === "synthetic" ? Number.MAX_SAFE_INTEGER + 1 : 10,
                remaining: 8,
            },
        });
    }
    throw new Error("unexpected quota provider");
}

function validCodexLaunch(invalidProjection = false) {
    const response = [
        JSON.stringify({ id: 1, result: {} }),
        JSON.stringify({
            id: 2,
            result: {
                rateLimits: {
                    primary: {
                        resetsAt: invalidProjection ? 8_640_000_000_000_001 : 2000,
                        usedPercent: 25,
                        windowDurationMins: 300,
                    },
                    secondary: null,
                },
            },
        }),
        "",
    ].join("\n");
    return {
        exited: Promise.resolve(0),
        kill: () => {},
        stdin: {
            end: () => {},
            write: (value: Uint8Array) => value.byteLength,
        },
        stdout: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(response));
                controller.close();
            },
        }),
    };
}

describe("overview collectors", () => {
    test("bounds Codex app-server teardown after a successful quota response", async () => {
        const exit = Promise.withResolvers<number>();
        const signals: Array<number | NodeJS.Signals | undefined> = [];
        const payload = await collectCodexQuota({
            codexHome: "/operator/.codex",
            executable: "/operator/bin/codex",
            home: "/operator",
            launch: () => ({
                exited: exit.promise,
                kill(signal) {
                    signals.push(signal);
                    if (signal === "SIGKILL") exit.resolve(137);
                },
                stdin: {
                    end() {},
                    write(value) {
                        return value.byteLength;
                    },
                },
                stdout: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                `${JSON.stringify({
                                    id: 2,
                                    result: {
                                        rateLimits: {
                                            primary: {
                                                resetsAt: 2000,
                                                usedPercent: 25,
                                                windowDurationMins: 300,
                                            },
                                            secondary: null,
                                        },
                                    },
                                })}\n`
                            )
                        );
                        controller.close();
                    },
                }),
            }),
        });

        expect(payload).toMatchObject({ id: "openai", status: "available" });
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    test("isolates a synchronous Codex launch failure from the other quota providers", async () => {
        const payload = await collectQuotaPayload(
            {
                elevenLabs: Redacted.make("eleven-secret"),
                openRouter: Redacted.make("router-secret"),
                synthetic: Redacted.make("synthetic-secret"),
            },
            undefined,
            {
                codex: {
                    codexHome: "/operator/.codex",
                    executable: "/operator/bin/codex",
                    home: "/operator",
                    launch: () => {
                        throw new Error("private synchronous launch failure");
                    },
                },
                fetch: ((input) =>
                    Promise.resolve(
                        quotaProviderResponse(inputUrl(input))
                    )) as typeof fetch,
                nowMs: () => 5000,
            }
        );

        expect(payload.providers).toEqual([
            expect.objectContaining({ id: "elevenlabs", status: "available" }),
            { id: "openai", label: "OpenAI", status: "unavailable" },
            expect.objectContaining({ id: "openrouter", status: "available" }),
            expect.objectContaining({ id: "synthetic", status: "available" }),
        ]);
        expect(JSON.stringify(payload)).not.toContain("private synchronous");
    });

    for (const invalidProvider of [
        "elevenlabs",
        "openai",
        "openrouter",
        "synthetic",
    ] as const) {
        test(`isolates an invalid ${invalidProvider} projection after provider-local validation`, async () => {
            const payload = await collectQuotaPayload(
                {
                    elevenLabs: Redacted.make("eleven-secret"),
                    openRouter: Redacted.make("router-secret"),
                    synthetic: Redacted.make("synthetic-secret"),
                },
                undefined,
                {
                    codex: {
                        codexHome: "/operator/.codex",
                        executable: "/operator/bin/codex",
                        home: "/operator",
                        launch: () => validCodexLaunch(invalidProvider === "openai"),
                    },
                    fetch: ((input) =>
                        Promise.resolve(
                            quotaProviderResponse(inputUrl(input), invalidProvider)
                        )) as typeof fetch,
                    nowMs: () => 5000,
                }
            );

            expect(payload.providers).toHaveLength(4);
            for (const provider of payload.providers) {
                expect(provider.status).toBe(
                    provider.id === invalidProvider ? "unavailable" : "available"
                );
            }
        });
    }

    test("normalizes the bounded Open-Meteo projection", async () => {
        const fetchCalls: string[] = [];
        const payload = await collectWeatherPayload(undefined, {
            fetch: ((input) => {
                fetchCalls.push(inputUrl(input));
                return Promise.resolve(
                    jsonResponse({
                        current: {
                            apparent_temperature: 10.5,
                            relative_humidity_2m: 70,
                            temperature_2m: 12,
                            weather_code: 61,
                            wind_speed_10m: 8,
                        },
                        daily: {
                            temperature_2m_max: [14, 15, 16],
                            temperature_2m_min: [7, 8, 9],
                            time: ["2026-08-13", "2026-08-14", "2026-08-15"],
                            weather_code: [61, 3, 0],
                        },
                    })
                );
            }) as typeof fetch,
            nowMs: () => 1234,
        });

        expect(fetchCalls).toHaveLength(1);
        expect(payload).toMatchObject({
            condition: "rain",
            location: "Spydeberg",
            observedAtMs: 1234,
            timezone: "Europe/Oslo",
        });
        expect(payload.forecast.map(({ condition }) => condition)).toEqual([
            "rain",
            "cloudy",
            "clear",
        ]);
        expect(weatherConditionFromCode(999)).toBe("unknown");
    });

    test("isolates providers and reads OpenAI through the documented app server", async () => {
        const requested: string[] = [];
        const appServerInput: string[] = [];
        const payload = await collectQuotaPayload(
            {
                elevenLabs: Redacted.make("eleven-secret"),
                openRouter: Redacted.make("router-secret"),
            },
            undefined,
            {
                codex: {
                    codexHome: "/operator/.codex",
                    executable: "/operator/bin/codex",
                    home: "/operator",
                    launch: (_executable, environment) => {
                        expect(environment.CODEX_HOME).toBe("/operator/.codex");
                        const response = [
                            JSON.stringify({ id: 1, result: {} }),
                            JSON.stringify({
                                id: 2,
                                result: {
                                    rateLimitsByLimitId: {
                                        codex: {
                                            primary: {
                                                resetsAt: 2000,
                                                usedPercent: 25,
                                                windowDurationMins: 300,
                                            },
                                            secondary: {
                                                resetsAt: 3000,
                                                usedPercent: 40,
                                                windowDurationMins: 10_080,
                                            },
                                        },
                                    },
                                },
                            }),
                            "",
                        ].join("\n");
                        return {
                            exited: Promise.resolve(0),
                            kill: () => {},
                            stdin: {
                                end: () => {},
                                write: (value: Uint8Array) => {
                                    appServerInput.push(new TextDecoder().decode(value));
                                    return value.byteLength;
                                },
                            },
                            stdout: new ReadableStream<Uint8Array>({
                                start(controller) {
                                    controller.enqueue(
                                        new TextEncoder().encode(response)
                                    );
                                    controller.close();
                                },
                            }),
                        };
                    },
                },
                fetch: ((input, init) => {
                    const url = inputUrl(input);
                    requested.push(url);
                    expect(JSON.stringify(init?.headers)).not.toContain(
                        "synthetic-secret"
                    );
                    if (url.endsWith("/v1/user")) {
                        return Promise.resolve(
                            jsonResponse({
                                subscription: {
                                    character_count: 25,
                                    character_limit: 100,
                                    next_character_count_reset_unix: 2,
                                },
                            })
                        );
                    }
                    if (url.endsWith("/api/v1/key")) {
                        return Promise.resolve(
                            jsonResponse({
                                data: {
                                    limit: 10,
                                    limit_remaining: 8,
                                    usage: 2,
                                },
                            })
                        );
                    }
                    if (url.endsWith("/api/v1/credits")) {
                        return Promise.resolve(
                            jsonResponse({ data: { total_credits: 10 } })
                        );
                    }
                    throw new Error("unexpected provider");
                }) as typeof fetch,
                nowMs: () => 5000,
            }
        );

        expect(requested).toHaveLength(3);
        expect(payload.providers).toEqual([
            expect.objectContaining({
                id: "elevenlabs",
                remaining: 75,
                resetsAtMs: 2000,
                status: "available",
            }),
            expect.objectContaining({
                id: "openai",
                remainingPercent: 60,
                status: "available",
                usedPercent: 40,
                windows: [
                    {
                        resetsAtMs: 2_000_000,
                        usedPercent: 25,
                        windowDurationMinutes: 300,
                    },
                    {
                        resetsAtMs: 3_000_000,
                        usedPercent: 40,
                        windowDurationMinutes: 10_080,
                    },
                ],
            }),
            expect.objectContaining({
                id: "openrouter",
                remaining: 8,
                status: "available",
            }),
            { id: "synthetic", label: "Synthetic", status: "not-configured" },
        ]);
        expect(appServerInput.join("\n")).toContain('"account/rateLimits/read"');
        expect(appServerInput.join("\n")).not.toContain("/status");
    });

    test("projects Git status without paths, remotes, filenames, or raw failures", async () => {
        const calls: readonly string[][] = [];
        const mutableCalls = calls as string[][];
        const process = (executable: string, arguments_: readonly string[]) => {
            mutableCalls.push([executable, ...arguments_]);
            const root = arguments_[1];
            if (root === "/docker") {
                return Promise.resolve({ exitCode: 128, stdout: new Uint8Array() });
            }
            if (root === "/openclaw") throw new Error("secret raw failure");
            return Promise.resolve({
                exitCode: 0,
                stdout: new TextEncoder().encode(
                    [
                        `# branch.oid ${"a".repeat(40)}`,
                        "# branch.head main",
                        `1 M. N... 100644 100644 100644 ${"b".repeat(40)} ${"c".repeat(40)} private.txt`,
                        "? secret.env",
                        "",
                    ].join("\0")
                ),
            });
        };
        const payload = await collectGitWorkspacePayload(
            [
                { id: "dashboard", root: "/dashboard" },
                { id: "docker", root: "/docker" },
                { id: "openclaw", root: "/openclaw" },
            ],
            undefined,
            { nowMs: () => 9000, process }
        );

        expect(calls).toHaveLength(3);
        expect(payload.repositories).toEqual([
            expect.objectContaining({
                branch: "main",
                changedFileCount: 2,
                id: "dashboard",
                stagedFileCount: 1,
                state: "available",
                untrackedFileCount: 1,
            }),
            expect.objectContaining({ id: "docker", state: "missing" }),
            expect.objectContaining({ id: "openclaw", state: "unavailable" }),
        ]);
        const serialized = JSON.stringify(payload);
        for (const forbidden of [
            "/dashboard",
            "/docker",
            "/openclaw",
            "private.txt",
            "secret.env",
            "secret raw failure",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    test("does not launch Git when collection is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        let launches = 0;

        const payload = await collectGitWorkspacePayload(
            [
                { id: "dashboard", root: "/dashboard" },
                { id: "docker", root: "/docker" },
                { id: "openclaw", root: "/openclaw" },
            ],
            controller.signal,
            {
                launch: () => {
                    launches += 1;
                    throw new Error("must not launch");
                },
                nowMs: () => 9000,
            }
        );

        expect(launches).toBe(0);
        expect(payload.repositories).toEqual([
            expect.objectContaining({ id: "dashboard", state: "unavailable" }),
            expect.objectContaining({ id: "docker", state: "unavailable" }),
            expect.objectContaining({ id: "openclaw", state: "unavailable" }),
        ]);
    });

    test("kills Git children after stream or process failures and bounds exit waits", async () => {
        const kills: string[] = [];
        let launches = 0;

        const payload = await collectGitWorkspacePayload(
            [
                { id: "dashboard", root: "/dashboard" },
                { id: "docker", root: "/docker" },
                { id: "openclaw", root: "/openclaw" },
            ],
            undefined,
            {
                launch: () => {
                    launches += 1;
                    const stdout = new ReadableStream<Uint8Array>({
                        start(controller) {
                            if (launches === 1) {
                                controller.enqueue(new Uint8Array(256 * 1024 + 1));
                                controller.close();
                                return;
                            }
                            if (launches === 2) {
                                controller.close();
                                return;
                            }
                            controller.error(new Error("private stream failure"));
                        },
                    });
                    return {
                        exited:
                            launches === 2
                                ? Promise.reject(new Error("private child failure"))
                                : new Promise<number>(() => {}),
                        kill: (signal) => {
                            kills.push(signal);
                        },
                        stdout,
                    };
                },
                nowMs: () => 9000,
            }
        );

        expect(launches).toBe(3);
        expect(kills).toHaveLength(3);
        expect(kills.every((signal) => signal === "SIGKILL")).toBeTrue();
        expect(
            payload.repositories.every(({ state }) => state === "unavailable")
        ).toBeTrue();
        expect(JSON.stringify(payload)).not.toContain("private");
    });
});
