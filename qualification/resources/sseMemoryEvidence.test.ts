import { describe, expect, test } from "bun:test";

import type { CgroupV2Snapshot } from "./cgroupV2.ts";
import {
    ancestorCgroupV2Paths,
    type CgroupV2AncestorSnapshot,
} from "./cgroupV2Hierarchy.ts";
import {
    memoryEventDifference,
    parseSseMemoryQualificationEvidence,
    type SseMemoryEvidenceCandidate,
    validateSseMemoryEvidence,
} from "./sseMemoryEvidence.ts";
import {
    currentQualificationUserId,
    expectedSseMemoryUnitCgroupPath,
} from "./unitIdentity.ts";

const mebibyte = 1024 * 1024;
const unitName = "mira-dashboard-sse-memory-019fcb3d-6cf6-7000-8000-000000000001";
const cgroupPath = expectedSseMemoryUnitCgroupPath(
    currentQualificationUserId(),
    unitName
);

function cgroupSnapshot(
    overrides: Partial<CgroupV2Snapshot> = {}
): Readonly<CgroupV2Snapshot> {
    return {
        cpuPeriodMicros: 100_000,
        cpuQuotaMicros: 50_000,
        memoryCurrentBytes: 70 * mebibyte,
        memoryEvents: Object.freeze({
            high: 0,
            low: 0,
            max: 0,
            oom: 0,
            oomGroupKill: 0,
            oomKill: 0,
        }),
        memoryHighBytes: 256 * mebibyte,
        memoryMaxBytes: 384 * mebibyte,
        memoryPeakBytes: 120 * mebibyte,
        memorySwapMaxBytes: 0,
        oomGroup: true,
        path: cgroupPath,
        pidsCurrent: 8,
        pidsMax: 32,
        ...overrides,
    };
}

function ancestorSnapshots(
    overrides: Partial<CgroupV2AncestorSnapshot> = {}
): readonly Readonly<CgroupV2AncestorSnapshot>[] {
    return ancestorCgroupV2Paths(cgroupPath).map((ancestorPath) => ({
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
        path: ancestorPath,
        pidsMax: 63_029,
        ...overrides,
    }));
}

function validCandidate(): SseMemoryEvidenceCandidate {
    return {
        cgroup: {
            ancestors: {
                baseline: ancestorSnapshots(),
                final: ancestorSnapshots(),
            },
            baseline: cgroupSnapshot({ memoryCurrentBytes: 80 * mebibyte }),
            final: cgroupSnapshot({ memoryCurrentBytes: 72 * mebibyte }),
            initial: cgroupSnapshot({ memoryCurrentBytes: 40 * mebibyte }),
        },
        durationMs: 4000,
        feed: {
            activeSubscribers: 0,
            droppedSlowSubscribers: 24,
            latestSequence: 108,
            maximumObservedQueueDepth: 16,
            maximumObservedQueuedPayloadBytes: 131_072,
            retainedEvents: 108,
        },
        process: {
            afterCleanup: {
                rssBytes: 72 * mebibyte,
                unsafeFootprintBytes: 60 * mebibyte,
            },
            baseline: {
                rssBytes: 80 * mebibyte,
                unsafeFootprintBytes: 64 * mebibyte,
            },
            sampledPeak: {
                rssBytes: 120 * mebibyte,
                unsafeFootprintBytes: 96 * mebibyte,
            },
        },
        proxyUpstreamUnavailableCount: 0,
        rounds: Array.from({ length: 6 }, () => ({
            durationMs: 500,
            eventsPublished: 18,
        })),
        runtime: {
            hasGlobalEventSource: false,
            revision: "a".repeat(40),
            version: "1.4.0",
        },
        subscriptionCount: 24,
        unitName,
    };
}

describe("SSE memory qualification evidence", () => {
    test("marks evidence validated only after all bounds pass", () => {
        expect(validateSseMemoryEvidence(validCandidate())).toMatchObject({
            memoryEventDelta: {
                high: 0,
                max: 0,
                oom: 0,
                oomGroupKill: 0,
                oomKill: 0,
            },
            verdict: "VALIDATED",
        });
    });

    test("rejects memory pressure and sampled process growth", () => {
        const pressure = validCandidate();
        pressure.cgroup.final = cgroupSnapshot({
            memoryEvents: Object.freeze({
                high: 1,
                low: 0,
                max: 0,
                oom: 0,
                oomGroupKill: 0,
                oomKill: 0,
            }),
        });
        expect(() => validateSseMemoryEvidence(pressure)).toThrow(
            "memory pressure event high"
        );

        const growth = validCandidate();
        growth.process.sampledPeak = {
            rssBytes: 200 * mebibyte,
            unsafeFootprintBytes: 170 * mebibyte,
        };
        expect(() => validateSseMemoryEvidence(growth)).toThrow(
            "Sampled process RSS increase"
        );

        const footprintGrowth = validCandidate();
        footprintGrowth.process.sampledPeak = {
            rssBytes: 120 * mebibyte,
            unsafeFootprintBytes: 170 * mebibyte,
        };
        expect(() => validateSseMemoryEvidence(footprintGrowth)).toThrow(
            "Sampled Bun memory-footprint increase"
        );

        const ancestorPressure = validCandidate();
        ancestorPressure.cgroup.ancestors.final = ancestorSnapshots({
            memoryEvents: Object.freeze({
                high: 1,
                low: 0,
                max: 0,
                oom: 0,
                oomGroupKill: 0,
                oomKill: 0,
            }),
        });
        expect(() => validateSseMemoryEvidence(ancestorPressure)).toThrow(
            "Cgroup ancestor"
        );
    });

    test("uses cgroup current rather than retained process pages for cleanup", () => {
        const processRetention = validCandidate();
        processRetention.process.afterCleanup = {
            rssBytes: 120 * mebibyte,
            unsafeFootprintBytes: 104 * mebibyte,
        };
        processRetention.process.sampledPeak = {
            rssBytes: 120 * mebibyte,
            unsafeFootprintBytes: 104 * mebibyte,
        };
        expect(() => validateSseMemoryEvidence(processRetention)).not.toThrow();

        const cgroupRetention = validCandidate();
        cgroupRetention.cgroup.final = cgroupSnapshot({
            memoryCurrentBytes: 113 * mebibyte,
        });
        expect(() => validateSseMemoryEvidence(cgroupRetention)).toThrow(
            "Post-cleanup cgroup memory increase"
        );
    });

    test("rejects nonmonotonic kernel counters", () => {
        expect(() =>
            memoryEventDifference(
                {
                    high: 1,
                    low: 0,
                    max: 0,
                    oom: 0,
                    oomGroupKill: 0,
                    oomKill: 0,
                },
                {
                    high: 0,
                    low: 0,
                    max: 0,
                    oom: 0,
                    oomGroupKill: 0,
                    oomKill: 0,
                }
            )
        ).toThrow("memory.events high decreased");
    });

    test("strictly reparses and revalidates child evidence", () => {
        const evidence = validateSseMemoryEvidence(validCandidate());
        expect(parseSseMemoryQualificationEvidence(JSON.stringify(evidence))).toEqual(
            evidence
        );
        expect(() =>
            parseSseMemoryQualificationEvidence('{"verdict":"VALIDATED"}')
        ).toThrow();

        const unknownField = { ...evidence, unexpected: true };
        expect(() =>
            parseSseMemoryQualificationEvidence(JSON.stringify(unknownField))
        ).toThrow();

        const tampered = {
            ...evidence,
            memoryEventDelta: { ...evidence.memoryEventDelta, high: 1 },
        };
        expect(() =>
            parseSseMemoryQualificationEvidence(JSON.stringify(tampered))
        ).toThrow("invalid high");
    });
});
