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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("Expected the promise to reject");
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
                usage_monthly: 0.1344,
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
                nextTickAt: "2026-08-23T13:16:00.000Z",
                remaining: 8,
                tickPercent: 0.05,
            },
            weeklyTokenLimit: {
                maxCredits: "$100",
                nextRegenAt: "2026-08-23T14:39:00.000Z",
                nextRegenCredits: "$2",
                percentRemaining: 72,
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
    test("does no quota provider work when collection is already aborted", async () => {
        const controller = new AbortController();
        const failure = new DOMException("quota collection cancelled", "AbortError");
        let clockReads = 0;
        let fetches = 0;
        let launches = 0;
        controller.abort(failure);

        expect(
            await rejectionOf(
                collectQuotaPayload(
                    {
                        elevenLabs: Redacted.make("eleven-secret"),
                        openRouter: Redacted.make("router-secret"),
                        synthetic: Redacted.make("synthetic-secret"),
                    },
                    controller.signal,
                    {
                        codex: {
                            codexHome: "/operator/.codex",
                            executable: "/operator/bin/codex",
                            home: "/operator",
                            launch: () => {
                                launches += 1;
                                return validCodexLaunch();
                            },
                        },
                        fetch: ((_input) => {
                            fetches += 1;
                            return Promise.reject(new Error("must not fetch"));
                        }) as typeof fetch,
                        nowMs: () => {
                            clockReads += 1;
                            return 5000;
                        },
                    }
                )
            )
        ).toBe(failure);

        expect({ clockReads, fetches, launches }).toEqual({
            clockReads: 0,
            fetches: 0,
            launches: 0,
        });
    });

    test("does not launch Codex quota collection when already aborted", async () => {
        const controller = new AbortController();
        const failure = new DOMException("Codex quota cancelled", "AbortError");
        let launches = 0;
        controller.abort(failure);

        expect(
            await rejectionOf(
                collectCodexQuota(
                    {
                        codexHome: "/operator/.codex",
                        executable: "/operator/bin/codex",
                        home: "/operator",
                        launch: () => {
                            launches += 1;
                            return validCodexLaunch();
                        },
                    },
                    controller.signal
                )
            )
        ).toBe(failure);

        expect(launches).toBe(0);
    });

    test("propagates parent cancellation from in-flight Codex quota collection", async () => {
        const controller = new AbortController();
        const failure = new DOMException("Codex quota cancelled", "AbortError");
        const exited = Promise.withResolvers<number>();
        const launched = Promise.withResolvers<void>();
        const kills: Array<number | NodeJS.Signals | undefined> = [];
        let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let settled = false;
        const collecting = collectCodexQuota(
            {
                codexHome: "/operator/.codex",
                executable: "/operator/bin/codex",
                home: "/operator",
                launch: () => {
                    launched.resolve();
                    return {
                        exited: exited.promise,
                        kill(signal) {
                            kills.push(signal);
                            if (settled) return;
                            settled = true;
                            stdoutController?.close();
                            exited.resolve(signal === "SIGKILL" ? 137 : 0);
                        },
                        stdin: {
                            end() {},
                            write(value) {
                                return value.byteLength;
                            },
                        },
                        stdout: new ReadableStream<Uint8Array>({
                            start(streamController) {
                                stdoutController = streamController;
                            },
                        }),
                    };
                },
            },
            controller.signal
        );
        await launched.promise;

        controller.abort(failure);

        expect(await rejectionOf(collecting)).toBe(failure);
        expect(kills[0]).toBe("SIGKILL");
        expect(kills).toContain("SIGTERM");
    });

    test("propagates parent cancellation from an in-flight HTTP quota request", async () => {
        const controller = new AbortController();
        const failure = new DOMException("HTTP quota cancelled", "AbortError");
        const requestStarted = Promise.withResolvers<AbortSignal>();
        let clockReads = 0;
        const collecting = collectQuotaPayload(
            { elevenLabs: Redacted.make("eleven-secret") },
            controller.signal,
            {
                fetch: ((_input, init) =>
                    new Promise<Response>((_resolve, reject) => {
                        const requestSignal = init?.signal;
                        if (!(requestSignal instanceof AbortSignal)) {
                            reject(new Error("quota request must be abortable"));
                            return;
                        }
                        requestSignal.addEventListener(
                            "abort",
                            () =>
                                reject(
                                    new DOMException(
                                        "bounded quota request aborted",
                                        "AbortError"
                                    )
                                ),
                            { once: true }
                        );
                        requestStarted.resolve(requestSignal);
                    })) as typeof fetch,
                nowMs: () => {
                    clockReads += 1;
                    return 5000;
                },
            }
        );

        const requestSignal = await requestStarted.promise;
        controller.abort(failure);

        expect(await rejectionOf(collecting)).toBe(failure);
        expect(requestSignal.aborted).toBeTrue();
        expect(clockReads).toBe(0);
    });

    test("keeps provider-local HTTP aborts isolated as unavailable", async () => {
        const payload = await collectQuotaPayload(
            { elevenLabs: Redacted.make("eleven-secret") },
            undefined,
            {
                fetch: ((_input) =>
                    Promise.reject(
                        new DOMException("provider deadline elapsed", "TimeoutError")
                    )) as typeof fetch,
                nowMs: () => 5000,
            }
        );

        expect(payload.providers).toEqual([
            { id: "elevenlabs", label: "ElevenLabs", status: "unavailable" },
            { id: "openai", label: "OpenAI / Codex", status: "unavailable" },
            { id: "openrouter", label: "OpenRouter", status: "not-configured" },
            { id: "synthetic", label: "Synthetic.new", status: "not-configured" },
        ]);
    });

    test("does not publish a quota payload cancelled after provider settlement", async () => {
        const controller = new AbortController();
        const failure = new DOMException("quota snapshot cancelled", "AbortError");

        expect(
            await rejectionOf(
                collectQuotaPayload({}, controller.signal, {
                    nowMs: () => {
                        controller.abort(failure);
                        return 5000;
                    },
                })
            )
        ).toBe(failure);
    });

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
            { id: "openai", label: "OpenAI / Codex", status: "unavailable" },
            expect.objectContaining({ id: "openrouter", status: "available" }),
            expect.objectContaining({ id: "synthetic", status: "available" }),
        ]);
        expect(payload.providers[3]?.windows).toEqual([
            {
                regenerationPercent: 5,
                resetsAtMs: Date.parse("2026-08-23T13:16:00.000Z"),
                usedPercent: 20,
                windowDurationMinutes: 300,
            },
            {
                regenerationPercent: 2,
                resetsAtMs: Date.parse("2026-08-23T14:39:00.000Z"),
                usedPercent: 28,
                windowDurationMinutes: 10_080,
            },
        ]);
        expect(payload.providers[2]).toMatchObject({
            balance: 8,
            periodUsage: 0.1344,
        });
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
            { id: "synthetic", label: "Synthetic.new", status: "not-configured" },
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

    test("propagates a pre-existing Git collection cancellation without work", async () => {
        const controller = new AbortController();
        const failure = new DOMException("Git collection cancelled", "AbortError");
        controller.abort(failure);
        let clockReads = 0;
        let processCalls = 0;

        const rejection = await rejectionOf(
            collectGitWorkspacePayload(
                [
                    { id: "dashboard", root: "/dashboard" },
                    { id: "docker", root: "/docker" },
                    { id: "openclaw", root: "/openclaw" },
                ],
                controller.signal,
                {
                    nowMs: () => {
                        clockReads += 1;
                        return 9000;
                    },
                    process: () => {
                        processCalls += 1;
                        throw new Error("must not launch");
                    },
                }
            )
        );

        expect(rejection).toBe(failure);
        expect(processCalls).toBe(0);
        expect(clockReads).toBe(0);
    });

    test("propagates parent cancellation from in-flight Git processes", async () => {
        const controller = new AbortController();
        const failure = new DOMException("Git refresh cancelled", "AbortError");
        const allProcessesStarted = Promise.withResolvers<void>();
        const childSignals: AbortSignal[] = [];
        let clockReads = 0;

        const collection = collectGitWorkspacePayload(
            [
                { id: "dashboard", root: "/dashboard" },
                { id: "docker", root: "/docker" },
                { id: "openclaw", root: "/openclaw" },
            ],
            controller.signal,
            {
                nowMs: () => {
                    clockReads += 1;
                    return 9000;
                },
                process: (_executable, _arguments, childSignal) => {
                    childSignals.push(childSignal);
                    if (childSignals.length === 3) allProcessesStarted.resolve();
                    return new Promise((_resolve, reject) => {
                        childSignal.addEventListener(
                            "abort",
                            () => reject(new Error("Git child stopped")),
                            { once: true }
                        );
                    });
                },
            }
        );
        await allProcessesStarted.promise;
        controller.abort(failure);

        expect(await rejectionOf(collection)).toBe(failure);
        expect(childSignals).toHaveLength(3);
        expect(
            childSignals.every(
                (childSignal) => childSignal.aborted && childSignal.reason === failure
            )
        ).toBeTrue();
        expect(clockReads).toBe(0);
    });

    test("does not publish a Git payload cancelled after repository settlement", async () => {
        const controller = new AbortController();
        const failure = new DOMException("Git snapshot cancelled", "AbortError");
        let processCalls = 0;

        const rejection = await rejectionOf(
            collectGitWorkspacePayload(
                [
                    { id: "dashboard", root: "/dashboard" },
                    { id: "docker", root: "/docker" },
                    { id: "openclaw", root: "/openclaw" },
                ],
                controller.signal,
                {
                    nowMs: () => {
                        controller.abort(failure);
                        return 9000;
                    },
                    process: () => {
                        processCalls += 1;
                        return Promise.resolve({
                            exitCode: 0,
                            stdout: new Uint8Array(),
                        });
                    },
                }
            )
        );

        expect(rejection).toBe(failure);
        expect(processCalls).toBe(3);
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
