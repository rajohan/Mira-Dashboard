import { describe, expect, test } from "bun:test";

import type { CgroupV2Snapshot } from "./cgroupV2.ts";
import type { CgroupV2AncestorSnapshot } from "./cgroupV2Hierarchy.ts";
import {
    assertCgroupAncestorResourcePolicy,
    assertCgroupResourcePolicy,
    sseMemoryQualificationPolicy,
} from "./resourcePolicy.ts";

function policySnapshot(
    overrides: Partial<CgroupV2Snapshot> = {}
): Readonly<CgroupV2Snapshot> {
    return {
        cpuPeriodMicros: 100_000,
        cpuQuotaMicros: 50_000,
        memoryCurrentBytes: 64 * 1024 * 1024,
        memoryEvents: Object.freeze({
            high: 0,
            low: 0,
            max: 0,
            oom: 0,
            oomGroupKill: 0,
            oomKill: 0,
        }),
        memoryHighBytes: 256 * 1024 * 1024,
        memoryMaxBytes: 384 * 1024 * 1024,
        memoryPeakBytes: 96 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        oomGroup: true,
        path: "/user.slice/probe.service",
        pidsCurrent: 8,
        pidsMax: 32,
        ...overrides,
    };
}

function ancestorSnapshot(
    overrides: Partial<CgroupV2AncestorSnapshot> = {}
): Readonly<CgroupV2AncestorSnapshot> {
    return {
        cpuPeriodMicros: 100_000,
        cpuQuotaMicros: "max",
        memoryEvents: Object.freeze({
            high: 0,
            low: 0,
            max: 0,
            oom: 0,
            oomGroupKill: 0,
            oomKill: 0,
        }),
        memoryHighBytes: "max",
        memoryMaxBytes: "max",
        memorySwapMaxBytes: "max",
        path: "/user.slice",
        pidsMax: 63_029,
        ...overrides,
    };
}

describe("SSE memory qualification resource policy", () => {
    test("exports the reviewed immutable cgroup and scenario boundaries", () => {
        expect(sseMemoryQualificationPolicy).toEqual({
            cgroup: {
                cpuQuotaPercent: 50,
                memoryHighBytes: 268_435_456,
                memoryMaxBytes: 402_653_184,
                memorySwapMaxBytes: 0,
                oomPolicy: "kill",
                outerDeadlineMs: 35_000,
                runtimeMaxSeconds: 30,
                tasksMax: 32,
            },
            scenario: {
                consumerCount: 4,
                maximumDurationMs: 25_000,
                maximumEventsPerRound: 1024,
                maximumPostCleanupCgroupIncreaseBytes: 33_554_432,
                maximumProcessIncreaseBytes: 100_663_296,
                maximumProcessRssBytes: 268_435_456,
                payloadBytes: 8 * 1024,
                processSampleIntervalMs: 20,
                publishBatchSize: 8,
                roundDisconnectTimeoutMs: 3000,
                rounds: 6,
                stabilizationMs: 100,
            },
        });
        expect(Object.isFrozen(sseMemoryQualificationPolicy)).toBeTrue();
        expect(Object.isFrozen(sseMemoryQualificationPolicy.cgroup)).toBeTrue();
        expect(Object.isFrozen(sseMemoryQualificationPolicy.scenario)).toBeTrue();
    });

    test("accepts the exact reviewed cgroup policy", () => {
        const exactSnapshot = policySnapshot();
        const alternatePeriodSnapshot = policySnapshot({
            cpuPeriodMicros: 50_000,
            cpuQuotaMicros: 25_000,
        });
        expect(() =>
            assertCgroupResourcePolicy(exactSnapshot, exactSnapshot.path)
        ).not.toThrow();
        expect(() =>
            assertCgroupResourcePolicy(
                alternatePeriodSnapshot,
                alternatePeriodSnapshot.path
            )
        ).not.toThrow();
        expect(() =>
            assertCgroupResourcePolicy(exactSnapshot, "/user.slice/other.service")
        ).toThrow("expected cgroup");
    });

    test("rejects missing, weaker, and stricter memory caps", () => {
        for (const overrides of [
            { memoryHighBytes: "max" as const },
            { memoryHighBytes: 128 * 1024 * 1024 },
            { memoryHighBytes: 512 * 1024 * 1024 },
            { memoryMaxBytes: undefined as never },
            { memoryMaxBytes: 256 * 1024 * 1024 },
            { memoryMaxBytes: 512 * 1024 * 1024 },
            { memorySwapMaxBytes: "max" as const },
            { memorySwapMaxBytes: 1 },
        ]) {
            const snapshot = policySnapshot(overrides);
            expect(() => assertCgroupResourcePolicy(snapshot, snapshot.path)).toThrow(
                "SSE memory qualification requires"
            );
        }
    });

    test("rejects nonexact task, CPU, and OOM-group policies", () => {
        for (const overrides of [
            { pidsMax: 31 },
            { pidsMax: 64 },
            { pidsMax: "max" as const },
            { cpuQuotaMicros: "max" as const },
            { cpuQuotaMicros: 60_000 },
            { oomGroup: false },
        ]) {
            const snapshot = policySnapshot(overrides);
            expect(() => assertCgroupResourcePolicy(snapshot, snapshot.path)).toThrow(
                "SSE memory qualification requires"
            );
        }
    });

    test("requires ancestors that do not tighten the reviewed leaf policy", () => {
        expect(() =>
            assertCgroupAncestorResourcePolicy([
                ancestorSnapshot({ path: "/user.slice/user-1001.slice" }),
                ancestorSnapshot({ path: "/user.slice" }),
            ])
        ).not.toThrow();
        expect(() => assertCgroupAncestorResourcePolicy([])).toThrow(
            "requires cgroup ancestor evidence"
        );

        for (const overrides of [
            { memoryHighBytes: 128 * 1024 * 1024 },
            { memoryMaxBytes: 256 * 1024 * 1024 },
            { pidsMax: 31 },
            { cpuQuotaMicros: 25_000 },
        ]) {
            expect(() =>
                assertCgroupAncestorResourcePolicy([ancestorSnapshot(overrides)])
            ).toThrow("ancestor");
        }

        expect(() =>
            assertCgroupAncestorResourcePolicy([
                ancestorSnapshot({ path: "/user.slice/user-1001.slice" }),
                ancestorSnapshot({
                    memoryMaxBytes: 256 * 1024 * 1024,
                    path: "/user.slice",
                }),
            ])
        ).toThrow("/user.slice memory.max");
    });
});
