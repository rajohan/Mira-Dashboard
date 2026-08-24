import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { gitWorkspaceCachePayloadSchema } from "./gitWorkspace.ts";
import { quotaCachePayloadSchema } from "./quota.ts";
import { weatherCachePayloadSchema } from "./weather.ts";

describe("overview provider contracts", () => {
    test("accepts bounded canonical weather, quota, and Git projections", () => {
        expect(
            v.parse(weatherCachePayloadSchema, {
                apparentTemperatureC: 11,
                condition: "rain",
                forecast: [
                    {
                        condition: "rain",
                        date: "2026-08-13",
                        maximumTemperatureC: 14,
                        minimumTemperatureC: 8,
                    },
                    {
                        condition: "cloudy",
                        date: "2026-08-14",
                        maximumTemperatureC: 16,
                        minimumTemperatureC: 9,
                    },
                    {
                        condition: "clear",
                        date: "2026-08-15",
                        maximumTemperatureC: 18,
                        minimumTemperatureC: 10,
                    },
                ],
                humidityPercent: 72,
                location: "Spydeberg",
                observedAtMs: 1000,
                temperatureC: 12,
                timezone: "Europe/Oslo",
                windKilometresPerHour: 9,
            }).condition
        ).toBe("rain");
        expect(
            v.parse(quotaCachePayloadSchema, {
                observedAtMs: 1000,
                providers: [
                    { id: "elevenlabs", label: "ElevenLabs", status: "not-configured" },
                    { id: "openai", label: "OpenAI", status: "unavailable" },
                    {
                        id: "openrouter",
                        label: "OpenRouter",
                        remaining: 8,
                        remainingPercent: 80,
                        status: "available",
                        unit: "currency-usd",
                    },
                    { id: "synthetic", label: "Synthetic", status: "unavailable" },
                ],
            }).providers[2]?.status
        ).toBe("available");
        expect(
            v.parse(gitWorkspaceCachePayloadSchema, {
                observedAtMs: 1000,
                repositories: [
                    {
                        branch: "main",
                        changedFileCount: 0,
                        detached: false,
                        headSha: "a".repeat(40),
                        id: "dashboard",
                        stagedFileCount: 0,
                        state: "available",
                        untrackedFileCount: 0,
                    },
                    {
                        changedFileCount: 0,
                        detached: false,
                        id: "docker",
                        stagedFileCount: 0,
                        state: "missing",
                        untrackedFileCount: 0,
                    },
                    {
                        changedFileCount: 0,
                        detached: false,
                        id: "openclaw",
                        stagedFileCount: 0,
                        state: "unavailable",
                        untrackedFileCount: 0,
                    },
                ],
            }).repositories.length
        ).toBe(3);
    });

    test("rejects reordered identities and inconsistent authority-free states", () => {
        expect(
            v.safeParse(quotaCachePayloadSchema, {
                observedAtMs: 1000,
                providers: [
                    { id: "openai", label: "OpenAI", status: "unavailable" },
                    { id: "elevenlabs", label: "ElevenLabs", status: "not-configured" },
                    { id: "openrouter", label: "OpenRouter", status: "not-configured" },
                    { id: "synthetic", label: "Synthetic", status: "not-configured" },
                ],
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(gitWorkspaceCachePayloadSchema, {
                observedAtMs: 1000,
                repositories: [
                    {
                        branch: "main",
                        changedFileCount: 0,
                        detached: false,
                        id: "dashboard",
                        stagedFileCount: 0,
                        state: "missing",
                        untrackedFileCount: 0,
                    },
                    ...["docker", "openclaw"].map((id) => ({
                        changedFileCount: 0,
                        detached: false,
                        id,
                        stagedFileCount: 0,
                        state: "missing",
                        untrackedFileCount: 0,
                    })),
                ],
            }).success
        ).toBeFalse();
    });

    test("rejects quota timestamps beyond the JavaScript Date range", () => {
        const invalidTimestampMs = 8_640_000_000_000_001;
        const unavailableProviders = [
            { id: "elevenlabs", label: "ElevenLabs", status: "unavailable" },
            { id: "openai", label: "OpenAI", status: "unavailable" },
            { id: "openrouter", label: "OpenRouter", status: "unavailable" },
            { id: "synthetic", label: "Synthetic", status: "unavailable" },
        ] as const;

        expect(
            v.safeParse(quotaCachePayloadSchema, {
                observedAtMs: invalidTimestampMs,
                providers: unavailableProviders,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(quotaCachePayloadSchema, {
                observedAtMs: 1000,
                providers: [
                    {
                        id: "elevenlabs",
                        label: "ElevenLabs",
                        remaining: 1,
                        resetsAtMs: invalidTimestampMs,
                        status: "available",
                    },
                    ...unavailableProviders.slice(1),
                ],
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(quotaCachePayloadSchema, {
                observedAtMs: 1000,
                providers: [
                    unavailableProviders[0],
                    {
                        id: "openai",
                        label: "OpenAI",
                        status: "available",
                        windows: [
                            {
                                resetsAtMs: invalidTimestampMs,
                                usedPercent: 25,
                                windowDurationMinutes: 300,
                            },
                        ],
                    },
                    ...unavailableProviders.slice(2),
                ],
            }).success
        ).toBeFalse();
    });
});
