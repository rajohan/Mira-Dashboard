import type { CgroupV2Limit, CgroupV2Snapshot } from "./cgroupV2.ts";
import type { CgroupV2AncestorSnapshot } from "./cgroupV2Hierarchy.ts";
import { assertSseMemoryUnitCgroupPath } from "./unitIdentity.ts";

const mebibyte = 1024 * 1024;

/** Fixed cgroup and load boundaries for the SSE memory qualification. */
export const sseMemoryQualificationPolicy = Object.freeze({
    cgroup: Object.freeze({
        cpuQuotaPercent: 50,
        memoryHighBytes: 256 * mebibyte,
        memoryMaxBytes: 384 * mebibyte,
        memorySwapMaxBytes: 0,
        oomPolicy: "kill" as const,
        outerDeadlineMs: 35_000,
        runtimeMaxSeconds: 30,
        tasksMax: 32,
    }),
    scenario: Object.freeze({
        consumerCount: 4,
        maximumEventsPerRound: 1024,
        maximumDurationMs: 25_000,
        maximumPostCleanupCgroupIncreaseBytes: 32 * mebibyte,
        maximumProcessIncreaseBytes: 96 * mebibyte,
        maximumProcessRssBytes: 256 * mebibyte,
        payloadBytes: 8 * 1024,
        processSampleIntervalMs: 20,
        publishBatchSize: 8,
        roundDisconnectTimeoutMs: 3000,
        rounds: 6,
        stabilizationMs: 100,
    }),
});

function assertExactLimit(label: string, actual: CgroupV2Limit, expected: number): void {
    if (actual !== expected) {
        throw new Error(
            `SSE memory qualification requires ${label}=${expected}; observed ${String(actual)}`
        );
    }
}

function assertAncestorLimit(
    label: string,
    actual: CgroupV2Limit,
    leafLimit: number
): void {
    if (actual !== "max" && actual < leafLimit) {
        throw new Error(
            `SSE memory qualification ancestor ${label} must not be stricter than ${leafLimit}; observed ${actual}`
        );
    }
}

/**
 * Rejects an ancestor that would make the declared leaf policy ineffective.
 * @param ancestors Immediate parent first, followed by the remaining cgroup hierarchy.
 * @throws {Error} When any finite ancestor limit is stricter than the leaf policy.
 */
export function assertCgroupAncestorResourcePolicy(
    ancestors: readonly Readonly<CgroupV2AncestorSnapshot>[]
): void {
    if (ancestors.length === 0) {
        throw new Error("SSE memory qualification requires cgroup ancestor evidence");
    }
    const policy = sseMemoryQualificationPolicy.cgroup;
    for (const ancestor of ancestors) {
        assertAncestorLimit(
            `${ancestor.path} memory.high`,
            ancestor.memoryHighBytes,
            policy.memoryHighBytes
        );
        assertAncestorLimit(
            `${ancestor.path} memory.max`,
            ancestor.memoryMaxBytes,
            policy.memoryMaxBytes
        );
        assertAncestorLimit(
            `${ancestor.path} memory.swap.max`,
            ancestor.memorySwapMaxBytes,
            policy.memorySwapMaxBytes
        );
        assertAncestorLimit(
            `${ancestor.path} pids.max`,
            ancestor.pidsMax,
            policy.tasksMax
        );
        if (
            !Number.isSafeInteger(ancestor.cpuPeriodMicros) ||
            ancestor.cpuPeriodMicros <= 0 ||
            (ancestor.cpuQuotaMicros !== "max" &&
                (!Number.isSafeInteger(ancestor.cpuQuotaMicros) ||
                    ancestor.cpuQuotaMicros <= 0))
        ) {
            throw new Error(
                `SSE memory qualification ancestor ${ancestor.path} has an invalid cpu.max policy`
            );
        }
        if (
            ancestor.cpuQuotaMicros !== "max" &&
            BigInt(ancestor.cpuQuotaMicros) * 100n <
                BigInt(ancestor.cpuPeriodMicros) * BigInt(policy.cpuQuotaPercent)
        ) {
            throw new Error(
                `SSE memory qualification ancestor ${ancestor.path} cpu.max is stricter than ${policy.cpuQuotaPercent}%`
            );
        }
    }
}

/**
 * Requires the current cgroup to match the reviewed qualification policy exactly.
 * @param snapshot Current cgroup v2 resource state.
 * @throws {Error} When any required controller cap is absent, weaker, or nonexact.
 */
export function assertCgroupResourcePolicy(
    snapshot: Readonly<CgroupV2Snapshot>,
    expectedCgroupPath?: string
): void {
    const policy = sseMemoryQualificationPolicy.cgroup;
    assertExactLimit("memory.high", snapshot.memoryHighBytes, policy.memoryHighBytes);
    assertExactLimit("memory.max", snapshot.memoryMaxBytes, policy.memoryMaxBytes);
    assertExactLimit(
        "memory.swap.max",
        snapshot.memorySwapMaxBytes,
        policy.memorySwapMaxBytes
    );
    assertExactLimit("pids.max", snapshot.pidsMax, policy.tasksMax);

    const cpuQuota = snapshot.cpuQuotaMicros;
    if (
        cpuQuota === "max" ||
        !Number.isSafeInteger(cpuQuota) ||
        cpuQuota <= 0 ||
        !Number.isSafeInteger(snapshot.cpuPeriodMicros) ||
        snapshot.cpuPeriodMicros <= 0 ||
        BigInt(cpuQuota) * 100n !==
            BigInt(snapshot.cpuPeriodMicros) * BigInt(policy.cpuQuotaPercent)
    ) {
        throw new Error(
            `SSE memory qualification requires cpu.max=${policy.cpuQuotaPercent}%; observed ${String(cpuQuota)} ${snapshot.cpuPeriodMicros}`
        );
    }
    if (!snapshot.oomGroup) {
        throw new Error(
            `SSE memory qualification requires OOMPolicy=${policy.oomPolicy}`
        );
    }
    if (expectedCgroupPath !== undefined) {
        assertSseMemoryUnitCgroupPath(snapshot.path, expectedCgroupPath);
    }
}
