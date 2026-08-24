import { describe, expect, test } from "bun:test";

import {
    createSystemMetricsSampler,
    parseLinuxNetworkCounters,
    type SystemMetricsAdapter,
} from "./systemMetricsCollector.ts";

function adapter(overrides: Partial<SystemMetricsAdapter> = {}): SystemMetricsAdapter {
    return {
        freeMemoryBytes: () => 250,
        loadAverage: () => [2, 1, 0.5],
        logicalCoreCount: () => 4,
        networkCounters: () =>
            Promise.resolve({ downloadBytes: 100n, uploadBytes: 200n }),
        nowMs: () => 1000,
        rootFilesystem: () => Promise.resolve({ bavail: 4n, blocks: 10n, bsize: 100n }),
        totalMemoryBytes: () => 1000,
        uptimeSeconds: () => 12.9,
        ...overrides,
    };
}

describe("system metrics collector", () => {
    test("collects bounded gauges and warms aggregate network rates without identity", async () => {
        const times = [1000, 6000];
        const counters = [
            { downloadBytes: 100n, uploadBytes: 200n },
            { downloadBytes: 600n, uploadBytes: 450n },
        ];
        let index = 0;
        const sample = createSystemMetricsSampler(
            adapter({
                networkCounters: () => Promise.resolve(counters[index]!),
                nowMs: () => times[index++]!,
            })
        );

        const first = await sample();
        const second = await sample();

        expect(first).toEqual({
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
                downloadBitsPerSecond: 0,
                state: "warming",
                uploadBitsPerSecond: 0,
            },
            sampledAtMs: 1000,
            uptimeSeconds: 12,
        });
        expect(second.network).toEqual({
            downloadBitsPerSecond: 800,
            state: "ready",
            uploadBitsPerSecond: 400,
        });
        expect("hostname" in second).toBe(false);
        expect("model" in second.cpu).toBe(false);
    });

    test("aggregates non-loopback Linux counters without retaining names", () => {
        expect(
            parseLinuxNetworkCounters(`Inter-| Receive | Transmit
 lo: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0
 eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0
 docker0: 50 0 0 0 0 0 0 0 75 0 0 0 0 0 0 0`)
        ).toEqual({ downloadBytes: 150n, uploadBytes: 275n });
        expect(() => parseLinuxNetworkCounters("eth0: invalid")).toThrow();
        expect(() =>
            parseLinuxNetworkCounters("lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0")
        ).toThrow("unavailable");
    });

    test("warms after counter resets and clock regressions before recovering", async () => {
        const times = [1000, 2000, 3000, 3000, 2500, 3500];
        const counters = [100n, 200n, 50n, 100n, 150n, 250n].map((value) => ({
            downloadBytes: value,
            uploadBytes: value,
        }));
        let index = 0;
        const sample = createSystemMetricsSampler(
            adapter({
                networkCounters: () => Promise.resolve(counters[index]!),
                nowMs: () => times[index++]!,
            })
        );

        const first = await sample();
        const second = await sample();
        const reset = await sample();
        const equalClock = await sample();
        const regressedClock = await sample();
        const recovered = await sample();

        expect([
            first.network.state,
            second.network.state,
            reset.network.state,
            equalClock.network.state,
            regressedClock.network.state,
        ]).toEqual(["warming", "ready", "warming", "warming", "warming"]);
        expect(recovered.network).toEqual({
            downloadBitsPerSecond: 800,
            state: "ready",
            uploadBitsPerSecond: 800,
        });
    });

    test("rejects a network rate outside the safe integer range", async () => {
        const times = [1000, 1001];
        const counters = [0n, BigInt(Number.MAX_SAFE_INTEGER)].map((value) => ({
            downloadBytes: value,
            uploadBytes: value,
        }));
        let index = 0;
        const sample = createSystemMetricsSampler(
            adapter({
                networkCounters: () => Promise.resolve(counters[index]!),
                nowMs: () => times[index++]!,
            })
        );

        await sample();
        expect(sample()).rejects.toThrow("rate is outside the safe range");
    });

    test("rejects inconsistent and unsafe host values", () => {
        expect(
            createSystemMetricsSampler(adapter({ freeMemoryBytes: () => 1001 }))()
        ).rejects.toThrow();
        expect(
            createSystemMetricsSampler(
                adapter({
                    rootFilesystem: () =>
                        Promise.resolve({
                            bavail: 1n,
                            blocks: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
                            bsize: 1n,
                        }),
                })
            )()
        ).rejects.toThrow("outside the safe integer range");
    });
});
