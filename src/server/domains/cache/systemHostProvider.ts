import { statfs } from "node:fs/promises";
import { arch, freemem, hostname, platform, release, totalmem, uptime } from "node:os";

import * as v from "valibot";

import { systemHostCachePayloadSchema } from "../../../contracts/cache.ts";

interface SystemHostFilesystemStats {
    readonly bavail: bigint;
    readonly blocks: bigint;
    readonly bsize: bigint;
}

export interface SystemHostAdapter {
    architecture(): string;
    freeMemoryBytes(): number;
    hostname(): string;
    platform(): string;
    release(): string;
    rootFilesystem(): Promise<SystemHostFilesystemStats>;
    totalMemoryBytes(): number;
    uptimeSeconds(): number;
}

const defaultSystemHostAdapter: SystemHostAdapter = Object.freeze({
    architecture: arch,
    freeMemoryBytes: freemem,
    hostname,
    platform,
    release,
    rootFilesystem: () => statfs("/", { bigint: true }),
    totalMemoryBytes: totalmem,
    uptimeSeconds: uptime,
});

function safeByteCount(value: bigint, field: string): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`System host ${field} is outside the safe integer range`);
    }
    return Number(value);
}

function safeNonnegativeInteger(value: number, field: string): number {
    const integer = Math.floor(value);
    if (!Number.isSafeInteger(integer) || integer < 0) {
        throw new RangeError(`System host ${field} is outside the safe integer range`);
    }
    return integer;
}

/**
 * Reads one bounded host-only projection without shell or OpenClaw authority.
 * @param adapter Host API boundary used to collect the projection.
 * @returns A validated system.host cache payload.
 */
export async function collectSystemHostPayload(
    adapter: SystemHostAdapter = defaultSystemHostAdapter
) {
    const filesystem = await adapter.rootFilesystem();
    const diskTotalBytes = safeByteCount(
        filesystem.bsize * filesystem.blocks,
        "disk total"
    );
    const diskFreeBytes = safeByteCount(
        filesystem.bsize * filesystem.bavail,
        "disk free"
    );
    return v.parse(systemHostCachePayloadSchema, {
        architecture: adapter.architecture(),
        disk: {
            freeBytes: diskFreeBytes,
            path: "/",
            totalBytes: diskTotalBytes,
        },
        hostname: adapter.hostname(),
        memory: {
            freeBytes: safeNonnegativeInteger(adapter.freeMemoryBytes(), "memory free"),
            totalBytes: safeNonnegativeInteger(
                adapter.totalMemoryBytes(),
                "memory total"
            ),
        },
        platform: adapter.platform(),
        release: adapter.release(),
        uptimeSeconds: safeNonnegativeInteger(adapter.uptimeSeconds(), "uptime"),
    });
}
