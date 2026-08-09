import { describe, expect, test } from "bun:test";

import type { SystemMetrics } from "../../../contracts/system.ts";
import {
    createSystemMetricsRuntimeService,
    SystemMetricsUnavailableError,
} from "./systemMetricsService.ts";

function metrics(sampledAtMs = 1000): SystemMetrics {
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
        const sampleResult = Promise.withResolvers<SystemMetrics>();
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
        expect(await first).toEqual(metrics());
        expect(await second).toEqual(metrics());
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
        expect(await service.read()).toEqual({ ...metrics(), freshness: "stale" });

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
});
