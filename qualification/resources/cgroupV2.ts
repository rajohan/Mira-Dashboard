import path from "node:path";

import * as v from "valibot";

/** A finite cgroup value or the kernel's unbounded marker. */
export type CgroupV2Limit = number | "max";

/** Counters exposed by the cgroup v2 memory controller. */
export interface CgroupV2MemoryEvents {
    high: number;
    low: number;
    max: number;
    oom: number;
    oomGroupKill: number;
    oomKill: number;
}

/** Raw control-file contents needed to construct one cgroup v2 snapshot. */
export interface CgroupV2FileContents {
    cpuMax: string;
    memoryCurrent: string;
    memoryEvents: string;
    memoryHigh: string;
    memoryMax: string;
    memoryOomGroup: string;
    memoryPeak: string;
    memorySwapMax: string;
    pidsCurrent: string;
    pidsMax: string;
    selfCgroup: string;
}

/** Typed resource state for the current process's unified cgroup. */
export interface CgroupV2Snapshot {
    cpuPeriodMicros: number;
    cpuQuotaMicros: CgroupV2Limit;
    memoryCurrentBytes: number;
    memoryEvents: Readonly<CgroupV2MemoryEvents>;
    memoryHighBytes: CgroupV2Limit;
    memoryMaxBytes: CgroupV2Limit;
    memoryPeakBytes: number;
    memorySwapMaxBytes: CgroupV2Limit;
    oomGroup: boolean;
    path: string;
    pidsCurrent: number;
    pidsMax: CgroupV2Limit;
}

const cgroupRoot = "/sys/fs/cgroup";
const requiredMemoryEventNames = [
    "high",
    "low",
    "max",
    "oom",
    "oom_group_kill",
    "oom_kill",
] as const;
const cgroupNonnegativeIntegerSchema = v.pipe(
    v.string(),
    v.regex(/^\d+$/u),
    v.transform(Number),
    v.safeInteger(),
    v.minValue(0)
);

function invalidValue(label: string, value: string): Error {
    return new Error(`Invalid cgroup v2 ${label}: ${JSON.stringify(value)}`);
}

function parseNonnegativeInteger(value: string, label: string): number {
    const result = v.safeParse(cgroupNonnegativeIntegerSchema, value.trim());
    if (!result.success) {
        throw invalidValue(label, value);
    }
    return result.output;
}

function parsePositiveInteger(value: string, label: string): number {
    const parsed = parseNonnegativeInteger(value, label);
    if (parsed === 0) {
        throw invalidValue(label, value);
    }
    return parsed;
}

/**
 * Parses one cgroup v2 controller limit.
 * @param value Raw controller value.
 * @param label Diagnostic controller label.
 * @returns A finite byte/count limit or `max`.
 */
export function parseCgroupV2Limit(value: string, label: string): CgroupV2Limit {
    const normalized = value.trim();
    return normalized === "max" ? normalized : parseNonnegativeInteger(normalized, label);
}

function parseUnifiedCgroupPath(value: string): string {
    const entries = value
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (entries.length !== 1) {
        throw invalidValue("process membership", value);
    }

    const match = /^0::(\/.*)$/u.exec(entries[0] ?? "");
    const cgroupPath = match?.[1];
    if (
        cgroupPath === undefined ||
        cgroupPath.includes("\0") ||
        path.posix.normalize(cgroupPath) !== cgroupPath
    ) {
        throw invalidValue("process membership", value);
    }
    return cgroupPath;
}

/**
 * Parses the required cgroup v2 memory-event counters.
 * @param value Raw `memory.events` contents.
 * @returns Immutable required event counters.
 */
export function parseCgroupV2MemoryEvents(value: string): Readonly<CgroupV2MemoryEvents> {
    const counters = new Map<string, number>();
    for (const line of value.split(/\r?\n/u)) {
        const normalized = line.trim();
        if (normalized.length === 0) continue;

        const parts = normalized.split(/\s+/u);
        const name = parts[0];
        const counter = parts[1];
        if (parts.length !== 2 || name === undefined || counter === undefined) {
            throw invalidValue("memory.events", value);
        }
        if (counters.has(name)) {
            throw new Error(`Invalid cgroup v2 memory.events: duplicate ${name}`);
        }
        counters.set(name, parseNonnegativeInteger(counter, `memory.events ${name}`));
    }

    function getRequiredCounter(name: (typeof requiredMemoryEventNames)[number]) {
        const counter = counters.get(name);
        if (counter === undefined) {
            throw new Error(`Invalid cgroup v2 memory.events: missing ${name}`);
        }
        return counter;
    }

    return Object.freeze({
        high: getRequiredCounter("high"),
        low: getRequiredCounter("low"),
        max: getRequiredCounter("max"),
        oom: getRequiredCounter("oom"),
        oomGroupKill: getRequiredCounter("oom_group_kill"),
        oomKill: getRequiredCounter("oom_kill"),
    });
}

/**
 * Parses one cgroup v2 CPU quota and period pair.
 * @param value Raw `cpu.max` contents.
 * @returns Validated quota and period values.
 */
export function parseCgroupV2CpuMax(value: string): {
    periodMicros: number;
    quotaMicros: CgroupV2Limit;
} {
    const parts = value.trim().split(/\s+/u);
    const quota = parts[0];
    const period = parts[1];
    if (parts.length !== 2 || quota === undefined || period === undefined) {
        throw invalidValue("cpu.max", value);
    }

    const quotaMicros = parseCgroupV2Limit(quota, "cpu.max quota");
    if (quotaMicros !== "max" && quotaMicros === 0) {
        throw invalidValue("cpu.max quota", quota);
    }
    return {
        periodMicros: parsePositiveInteger(period, "cpu.max period"),
        quotaMicros,
    };
}

/**
 * Parses one complete set of cgroup v2 control files.
 * @param files Raw control-file contents.
 * @returns An immutable typed snapshot.
 */
export function parseCgroupV2Snapshot(
    files: CgroupV2FileContents
): Readonly<CgroupV2Snapshot> {
    const cpu = parseCgroupV2CpuMax(files.cpuMax);
    const oomGroup = files.memoryOomGroup.trim();
    if (oomGroup !== "0" && oomGroup !== "1") {
        throw invalidValue("memory.oom.group", files.memoryOomGroup);
    }

    return Object.freeze({
        cpuPeriodMicros: cpu.periodMicros,
        cpuQuotaMicros: cpu.quotaMicros,
        memoryCurrentBytes: parseNonnegativeInteger(
            files.memoryCurrent,
            "memory.current"
        ),
        memoryEvents: parseCgroupV2MemoryEvents(files.memoryEvents),
        memoryHighBytes: parseCgroupV2Limit(files.memoryHigh, "memory.high"),
        memoryMaxBytes: parseCgroupV2Limit(files.memoryMax, "memory.max"),
        memoryPeakBytes: parseNonnegativeInteger(files.memoryPeak, "memory.peak"),
        memorySwapMaxBytes: parseCgroupV2Limit(files.memorySwapMax, "memory.swap.max"),
        oomGroup: oomGroup === "1",
        path: parseUnifiedCgroupPath(files.selfCgroup),
        pidsCurrent: parseNonnegativeInteger(files.pidsCurrent, "pids.current"),
        pidsMax: parseCgroupV2Limit(files.pidsMax, "pids.max"),
    });
}

function controlFilePath(cgroupPath: string, fileName: string): string {
    const directory = path.resolve(cgroupRoot, `.${cgroupPath}`);
    if (directory !== cgroupRoot && !directory.startsWith(`${cgroupRoot}/`)) {
        throw new Error(`Cgroup v2 path escapes ${cgroupRoot}`);
    }
    return path.join(directory, fileName);
}

/**
 * Reads one controller file beneath the unified cgroup root.
 * @param cgroupPath Normalized absolute cgroup membership path.
 * @param fileName Controller file name.
 * @returns Raw controller file contents.
 */
export async function readCgroupV2ControlFile(
    cgroupPath: string,
    fileName: string
): Promise<string> {
    const filePath = controlFilePath(cgroupPath, fileName);
    try {
        return await Bun.file(filePath).text();
    } catch (error) {
        throw new Error(
            `Could not read cgroup v2 control file ${fileName} for ${cgroupPath}`,
            { cause: error }
        );
    }
}

/**
 * Reads the current process's unified cgroup v2 resource state.
 * @returns An immutable typed snapshot.
 */
export async function readCurrentCgroupV2Snapshot(): Promise<Readonly<CgroupV2Snapshot>> {
    const selfCgroup = await Bun.file("/proc/self/cgroup").text();
    const cgroupPath = parseUnifiedCgroupPath(selfCgroup);
    const [
        cpuMax,
        memoryCurrent,
        memoryEvents,
        memoryHigh,
        memoryMax,
        memoryOomGroup,
        memoryPeak,
        memorySwapMax,
        pidsCurrent,
        pidsMax,
    ] = await Promise.all([
        readCgroupV2ControlFile(cgroupPath, "cpu.max"),
        readCgroupV2ControlFile(cgroupPath, "memory.current"),
        readCgroupV2ControlFile(cgroupPath, "memory.events"),
        readCgroupV2ControlFile(cgroupPath, "memory.high"),
        readCgroupV2ControlFile(cgroupPath, "memory.max"),
        readCgroupV2ControlFile(cgroupPath, "memory.oom.group"),
        readCgroupV2ControlFile(cgroupPath, "memory.peak"),
        readCgroupV2ControlFile(cgroupPath, "memory.swap.max"),
        readCgroupV2ControlFile(cgroupPath, "pids.current"),
        readCgroupV2ControlFile(cgroupPath, "pids.max"),
    ]);

    return parseCgroupV2Snapshot({
        cpuMax,
        memoryCurrent,
        memoryEvents,
        memoryHigh,
        memoryMax,
        memoryOomGroup,
        memoryPeak,
        memorySwapMax,
        pidsCurrent,
        pidsMax,
        selfCgroup,
    });
}
