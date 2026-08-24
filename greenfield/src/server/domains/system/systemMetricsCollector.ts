import { readFile, statfs } from "node:fs/promises";
import {
    availableParallelism,
    freemem,
    loadavg,
    platform,
    totalmem,
    uptime,
} from "node:os";

import * as v from "valibot";

import { type SystemMetrics, systemMetricsSchema } from "../../../contracts/system.ts";

interface SystemMetricsFilesystemStats {
    readonly bavail: bigint;
    readonly blocks: bigint;
    readonly bsize: bigint;
}

export interface SystemMetricsNetworkCounters {
    readonly downloadBytes: bigint;
    readonly uploadBytes: bigint;
}

export interface SystemMetricsAdapter {
    freeMemoryBytes(): number;
    loadAverage(): readonly number[];
    logicalCoreCount(): number;
    networkCounters(): Promise<SystemMetricsNetworkCounters>;
    nowMs(): number;
    rootFilesystem(): Promise<SystemMetricsFilesystemStats>;
    totalMemoryBytes(): number;
    uptimeSeconds(): number;
}

interface NetworkBaseline extends SystemMetricsNetworkCounters {
    readonly sampledAtMs: number;
}

/** One demand-driven metrics collection operation. */
export type SystemMetricsSampler = () => Promise<SystemMetrics>;

function parseCounter(value: string, field: string): bigint {
    if (!/^\d+$/u.test(value)) {
        throw new TypeError(`System metrics ${field} counter is invalid`);
    }
    return BigInt(value);
}

/**
 * Parses aggregate non-loopback Linux counters without retaining interface identity.
 * @param text Kernel-owned /proc/net/dev projection.
 * @returns Aggregate receive and transmit byte counters.
 */
export function parseLinuxNetworkCounters(text: string): SystemMetricsNetworkCounters {
    let downloadBytes = 0n;
    let uploadBytes = 0n;
    let interfaceCount = 0;

    for (const line of text.split("\n")) {
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const name = line.slice(0, separator).trim();
        if (name === "lo") continue;
        if (name.length === 0) {
            throw new TypeError("System metrics network interface is invalid");
        }
        const fields = line
            .slice(separator + 1)
            .trim()
            .split(/\s+/u);
        if (fields.length < 9 || fields[0] === undefined || fields[8] === undefined) {
            throw new TypeError("System metrics network counters are incomplete");
        }
        downloadBytes += parseCounter(fields[0], "download");
        uploadBytes += parseCounter(fields[8], "upload");
        interfaceCount += 1;
    }

    if (interfaceCount === 0) {
        throw new TypeError("System metrics network counters are unavailable");
    }
    return { downloadBytes, uploadBytes };
}

async function readDefaultNetworkCounters(): Promise<SystemMetricsNetworkCounters> {
    if (platform() !== "linux") {
        throw new TypeError("System metrics network counters require Linux");
    }
    return parseLinuxNetworkCounters(await readFile("/proc/net/dev", "utf8"));
}

const defaultSystemMetricsAdapter: SystemMetricsAdapter = Object.freeze({
    freeMemoryBytes: freemem,
    loadAverage: loadavg,
    logicalCoreCount: availableParallelism,
    networkCounters: readDefaultNetworkCounters,
    nowMs: Date.now,
    rootFilesystem: () => statfs("/", { bigint: true }),
    totalMemoryBytes: totalmem,
    uptimeSeconds: uptime,
});

function safeByteCount(value: bigint, field: string): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`System metrics ${field} is outside the safe integer range`);
    }
    return Number(value);
}

function safeNonnegativeInteger(value: number, field: string): number {
    const integer = Math.floor(value);
    if (!Number.isSafeInteger(integer) || integer < 0) {
        throw new RangeError(`System metrics ${field} is outside the safe integer range`);
    }
    return integer;
}

function rounded(value: number, digits: number): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError("System metrics numeric sample is invalid");
    }
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function capacity(totalBytes: number, freeBytes: number): SystemMetrics["memory"] {
    const usedBytes = totalBytes - freeBytes;
    return {
        freeBytes,
        totalBytes,
        usedBytes,
        usedPercent:
            totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 1000) / 10,
    };
}

function bitsPerSecond(deltaBytes: bigint, elapsedMs: number, field: string): number {
    if (deltaBytes < 0n || deltaBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`System metrics ${field} delta is outside the safe range`);
    }
    const rate = Math.round((Number(deltaBytes) * 8000) / elapsedMs);
    if (!Number.isSafeInteger(rate) || rate < 0) {
        throw new RangeError(`System metrics ${field} rate is outside the safe range`);
    }
    return rate;
}

function networkProjection(
    counters: SystemMetricsNetworkCounters,
    sampledAtMs: number,
    previous: NetworkBaseline | undefined
): SystemMetrics["network"] {
    if (
        previous === undefined ||
        sampledAtMs <= previous.sampledAtMs ||
        counters.downloadBytes < previous.downloadBytes ||
        counters.uploadBytes < previous.uploadBytes
    ) {
        return {
            downloadBitsPerSecond: 0,
            state: "warming",
            uploadBitsPerSecond: 0,
        };
    }
    const elapsedMs = sampledAtMs - previous.sampledAtMs;
    return {
        downloadBitsPerSecond: bitsPerSecond(
            counters.downloadBytes - previous.downloadBytes,
            elapsedMs,
            "download"
        ),
        state: "ready",
        uploadBitsPerSecond: bitsPerSecond(
            counters.uploadBytes - previous.uploadBytes,
            elapsedMs,
            "upload"
        ),
    };
}

/**
 * Creates one stateful, shell-free sampler for bounded host gauges and throughput.
 * Network rates become ready only after two monotonic successful samples.
 * @param adapter Injectable host boundary.
 * @returns One demand-driven sampler retaining only aggregate network counters.
 */
export function createSystemMetricsSampler(
    adapter: SystemMetricsAdapter = defaultSystemMetricsAdapter
): SystemMetricsSampler {
    let previousNetwork: NetworkBaseline | undefined;

    return async () => {
        const [filesystem, networkCounters] = await Promise.all([
            adapter.rootFilesystem(),
            adapter.networkCounters(),
        ]);
        const sampledAtMs = safeNonnegativeInteger(adapter.nowMs(), "sample time");
        const logicalCoreCount = safeNonnegativeInteger(
            adapter.logicalCoreCount(),
            "logical core count"
        );
        const loadAverage = adapter.loadAverage();
        const totalMemoryBytes = safeNonnegativeInteger(
            adapter.totalMemoryBytes(),
            "memory total"
        );
        const freeMemoryBytes = safeNonnegativeInteger(
            adapter.freeMemoryBytes(),
            "memory free"
        );
        const diskTotalBytes = safeByteCount(
            filesystem.bsize * filesystem.blocks,
            "disk total"
        );
        const diskFreeBytes = safeByteCount(
            filesystem.bsize * filesystem.bavail,
            "disk free"
        );
        const firstLoad = loadAverage[0];
        const metrics = v.parse(systemMetricsSchema, {
            cpu: {
                loadAverage: [
                    rounded(loadAverage[0] ?? Number.NaN, 2),
                    rounded(loadAverage[1] ?? Number.NaN, 2),
                    rounded(loadAverage[2] ?? Number.NaN, 2),
                ],
                loadPercent:
                    logicalCoreCount === 0
                        ? Number.NaN
                        : rounded(
                              ((firstLoad ?? Number.NaN) / logicalCoreCount) * 100,
                              1
                          ),
                logicalCoreCount,
            },
            disk: capacity(diskTotalBytes, diskFreeBytes),
            freshness: "fresh",
            memory: capacity(totalMemoryBytes, freeMemoryBytes),
            network: networkProjection(networkCounters, sampledAtMs, previousNetwork),
            sampledAtMs,
            uptimeSeconds: safeNonnegativeInteger(adapter.uptimeSeconds(), "uptime"),
        });
        previousNetwork = { ...networkCounters, sampledAtMs };
        return metrics;
    };
}
