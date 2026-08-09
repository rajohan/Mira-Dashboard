import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    type SystemMetrics,
    systemMetricsContract,
    systemMetricsSchema,
} from "./system.ts";

const metrics = Object.freeze({
    cpu: {
        loadAverage: [2, 1, 0.5],
        loadPercent: 50,
        logicalCoreCount: 4,
    },
    disk: {
        freeBytes: 400,
        totalBytes: 1000,
        usedBytes: 600,
        usedPercent: 60,
    },
    freshness: "fresh",
    memory: {
        freeBytes: 250,
        totalBytes: 1000,
        usedBytes: 750,
        usedPercent: 75,
    },
    network: {
        downloadBitsPerSecond: 800,
        state: "ready",
        uploadBitsPerSecond: 400,
    },
    sampledAtMs: 1_800_000_000_000,
    uptimeSeconds: 12,
} as const satisfies SystemMetrics);

describe("system metrics contract", () => {
    test("accepts only the bounded identity-free operational projection", () => {
        expect(v.parse(systemMetricsSchema, metrics)).toEqual(metrics);
        expect(() =>
            v.parse(systemMetricsSchema, { ...metrics, hostname: "private-host" })
        ).toThrow();
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                cpu: { ...metrics.cpu, model: "private-model" },
            })
        ).toThrow();
    });

    test("rejects inconsistent capacities and invalid rates", () => {
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                memory: { ...metrics.memory, usedBytes: 749 },
            })
        ).toThrow("capacity fields are inconsistent");
        expect(() =>
            v.parse(systemMetricsSchema, {
                ...metrics,
                network: { ...metrics.network, downloadBitsPerSecond: -1 },
            })
        ).toThrow();
    });

    test("is browser-session-only without an automation capability", () => {
        expect(systemMetricsContract.access).toEqual({
            capabilities: [],
            capabilityPolicy: "all",
            kind: "authenticated",
            principalKinds: ["session"],
        });
        expect(systemMetricsContract.errors).toEqual([
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ]);
    });
});
