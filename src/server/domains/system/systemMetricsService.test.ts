import { describe, expect, test } from "bun:test";

import type { SystemHostMetrics } from "../../../contracts/system.ts";
import {
    createSystemMetricsRuntimeService,
    SystemMetricsUnavailableError,
} from "./systemMetricsService.ts";

function metrics(sampledAtMs = 1000): SystemHostMetrics {
    return {
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
        sampledAtMs,
        uptimeSeconds: 12,
    };
}

describe("system metrics runtime service", () => {
    test("coalesces concurrent demand into one sample", async () => {
        const sampleResult = Promise.withResolvers<SystemHostMetrics>();
        let sampleCount = 0;
        const service = createSystemMetricsRuntimeService({
            sample: () => {
                sampleCount += 1;
                return sampleResult.promise;
            },
        });

        const first = service.read();
        const second = service.read();
        expect(first).toBe(second);
        expect(sampleCount).toBe(1);

        sampleResult.resolve(metrics());
        const firstValue = await first;
        expect(firstValue).toMatchObject(metrics());
        expect(firstValue.application.cache.state).toBe("unavailable");
        expect(await second).toEqual(firstValue);
        expect(Object.isFrozen(service)).toBe(true);
    });

    test("serves a marked last-known-good sample for at most thirty seconds", async () => {
        const rawFailure = new TypeError("private collector failure");
        const fallbackTimes = [31_000, 31_001];
        let sampleCount = 0;
        let fallbackIndex = 0;
        const service = createSystemMetricsRuntimeService({
            nowMs: () => fallbackTimes[fallbackIndex++]!,
            sample: () => {
                sampleCount += 1;
                return sampleCount === 1
                    ? Promise.resolve(metrics())
                    : Promise.reject(rawFailure);
            },
        });

        const fresh = await service.read();
        expect(fresh.freshness).toBe("fresh");
        expect(await service.read()).toEqual({ ...fresh, freshness: "stale" });

        const failure = await service.read().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(SystemMetricsUnavailableError);
        expect((failure as Error).message).not.toContain(rawFailure.message);
        expect(sampleCount).toBe(3);
    });

    test("fails with one typed error when no valid sample exists", async () => {
        const service = createSystemMetricsRuntimeService({
            sample: () =>
                Promise.resolve({
                    ...metrics(),
                    freshness: "stale",
                }),
        });

        const failure = await service.read().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(SystemMetricsUnavailableError);
    });

    test("contains malformed application components without hiding a fresh host sample", async () => {
        const service = createSystemMetricsRuntimeService({
            applicationReader: () =>
                Promise.resolve({
                    cache: { state: "unavailable" },
                    chat: { state: "unavailable" },
                    gateway: { state: "unavailable" },
                    jobs: {
                        claimingPaused: false,
                        queuedRuns: 1,
                        runningRuns: 0,
                        scheduleLagMs: 0,
                        state: "observed",
                        workers: { capacity: 1, draining: 1, online: 1 },
                    },
                    operations: { state: "unavailable" },
                    realtime: { state: "unavailable" },
                    sqlite: { state: "unavailable" },
                    web: {
                        eventLoopDelayMs: 1,
                        externalBytes: 5,
                        heapTotalBytes: 20,
                        heapUsedBytes: 10,
                        rssBytes: 30,
                        state: "observed",
                        uptimeSeconds: 2,
                    },
                }) as never,
            httpMetrics: {
                record() {},
                snapshot: () => ({ state: "observed", procedures: [] }) as never,
            },
            sample: () => Promise.resolve(metrics()),
        });

        const result = await service.read();
        expect(result.freshness).toBe("fresh");
        expect(result.application.jobs).toEqual({ state: "unavailable" });
        expect(result.application.web).toMatchObject({ state: "observed" });
        expect(result.application.http.procedures.length).toBeGreaterThan(1);
    });
});
