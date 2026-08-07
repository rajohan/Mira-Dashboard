import path from "node:path";

import {
    type CgroupV2Limit,
    type CgroupV2MemoryEvents,
    parseCgroupV2CpuMax,
    parseCgroupV2Limit,
    parseCgroupV2MemoryEvents,
    readCgroupV2ControlFile,
} from "./cgroupV2.ts";

/** Resource policy and memory events observed at one ancestor cgroup. */
export interface CgroupV2AncestorSnapshot {
    cpuPeriodMicros: number;
    cpuQuotaMicros: CgroupV2Limit;
    memoryEvents: Readonly<CgroupV2MemoryEvents>;
    memoryHighBytes: CgroupV2Limit;
    memoryMaxBytes: CgroupV2Limit;
    memorySwapMaxBytes: CgroupV2Limit;
    path: string;
    pidsMax: CgroupV2Limit;
}

/**
 * Derives every controller-bearing ancestor below the unified cgroup root.
 * @param cgroupPath Normalized absolute leaf membership path.
 * @returns Immediate parent first, followed by each ancestor below `/`.
 */
export function ancestorCgroupV2Paths(cgroupPath: string): readonly string[] {
    if (
        !cgroupPath.startsWith("/") ||
        cgroupPath.includes("\0") ||
        path.posix.normalize(cgroupPath) !== cgroupPath ||
        cgroupPath === "/"
    ) {
        throw new TypeError("Cgroup v2 hierarchy requires a normalized leaf path");
    }

    const ancestors: string[] = [];
    let current = path.posix.dirname(cgroupPath);
    while (current !== "/") {
        ancestors.push(current);
        current = path.posix.dirname(current);
    }
    if (ancestors.length === 0) {
        throw new Error("Cgroup v2 hierarchy has no controller-bearing ancestor");
    }
    return Object.freeze(ancestors);
}

async function readAncestorSnapshot(
    cgroupPath: string
): Promise<Readonly<CgroupV2AncestorSnapshot>> {
    const [cpuMax, memoryEvents, memoryHigh, memoryMax, memorySwapMax, pidsMax] =
        await Promise.all([
            readCgroupV2ControlFile(cgroupPath, "cpu.max"),
            readCgroupV2ControlFile(cgroupPath, "memory.events"),
            readCgroupV2ControlFile(cgroupPath, "memory.high"),
            readCgroupV2ControlFile(cgroupPath, "memory.max"),
            readCgroupV2ControlFile(cgroupPath, "memory.swap.max"),
            readCgroupV2ControlFile(cgroupPath, "pids.max"),
        ]);
    const cpu = parseCgroupV2CpuMax(cpuMax);

    return Object.freeze({
        cpuPeriodMicros: cpu.periodMicros,
        cpuQuotaMicros: cpu.quotaMicros,
        memoryEvents: parseCgroupV2MemoryEvents(memoryEvents),
        memoryHighBytes: parseCgroupV2Limit(memoryHigh, "ancestor memory.high"),
        memoryMaxBytes: parseCgroupV2Limit(memoryMax, "ancestor memory.max"),
        memorySwapMaxBytes: parseCgroupV2Limit(memorySwapMax, "ancestor memory.swap.max"),
        path: cgroupPath,
        pidsMax: parseCgroupV2Limit(pidsMax, "ancestor pids.max"),
    });
}

/**
 * Reads the effective-policy inputs and pressure counters for every leaf ancestor.
 * @param leafPath Exact current-process cgroup membership path.
 * @returns Immutable snapshots ordered from the immediate parent upward.
 */
export async function readCgroupV2AncestorSnapshots(
    leafPath: string
): Promise<readonly Readonly<CgroupV2AncestorSnapshot>[]> {
    const snapshots = await Promise.all(
        ancestorCgroupV2Paths(leafPath).map((cgroupPath) =>
            readAncestorSnapshot(cgroupPath)
        )
    );
    return Object.freeze(snapshots);
}
