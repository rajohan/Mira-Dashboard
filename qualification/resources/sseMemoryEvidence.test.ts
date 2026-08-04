import { describe, expect, test } from "bun:test";

import { qualificationEventLimits } from "../realtime/eventFeed.ts";
import type { CgroupV2Snapshot } from "./cgroupV2.ts";
import {
    ancestorCgroupV2Paths,
    type CgroupV2AncestorSnapshot,
} from "./cgroupV2Hierarchy.ts";
import { sseMemoryQualificationPolicy } from "./resourcePolicy.ts";
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
const cgroupPolicy = sseMemoryQualificationPolicy.cgroup;
const scenarioPolicy = sseMemoryQualificationPolicy.scenario;
const cpuPeriodMicros = 100_000;
const cpuQuotaMicros = (cpuPeriodMicros * cgroupPolicy.cpuQuotaPercent) / 100;
const expectedSubscriptionCount = scenarioPolicy.consumerCount * scenarioPolicy.rounds;
const eventsPerRound = qualificationEventLimits.maximumSubscriberQueueEvents + 2;
const totalPublishedEvents = eventsPerRound * scenarioPolicy.rounds;
const roundDurationMs =
    Math.min(
        scenarioPolicy.roundDisconnectTimeoutMs,
        scenarioPolicy.maximumDurationMs / scenarioPolicy.rounds
    ) / 2;
const baselineCgroupMemoryBytes = 80 * mebibyte;

function cgroupSnapshot(
    overrides: Partial<CgroupV2Snapshot> = {}
): Readonly<CgroupV2Snapshot> {
    return {
        cpuPeriodMicros,
        cpuQuotaMicros,
        memoryCurrentBytes: 70 * mebibyte,
        memoryEvents: Object.freeze({
            high: 0,
            low: 0,
            max: 0,
            oom: 0,
            oomGroupKill: 0,
            oomKill: 0,
        }),
        memoryHighBytes: cgroupPolicy.memoryHighBytes,
        memoryMaxBytes: cgroupPolicy.memoryMaxBytes,
        memoryPeakBytes: cgroupPolicy.memoryHighBytes / 2,
        memorySwapMaxBytes: cgroupPolicy.memorySwapMaxBytes,
        oomGroup: cgroupPolicy.oomPolicy === "kill",
        path: cgroupPath,
        pidsCurrent: 8,
        pidsMax: cgroupPolicy.tasksMax,
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
        pidsMax: cgroupPolicy.tasksMax + 1,
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
            baseline: cgroupSnapshot({
                memoryCurrentBytes: baselineCgroupMemoryBytes,
            }),
            final: cgroupSnapshot({ memoryCurrentBytes: 72 * mebibyte }),
            initial: cgroupSnapshot({ memoryCurrentBytes: 40 * mebibyte }),
        },
        durationMs: roundDurationMs * scenarioPolicy.rounds,
        feed: {
            activeSubscribers: 0,
            droppedSlowSubscribers: expectedSubscriptionCount,
            latestSequence: totalPublishedEvents,
            maximumObservedQueueDepth:
                qualificationEventLimits.maximumSubscriberQueueEvents,
            maximumObservedQueuedPayloadBytes:
                qualificationEventLimits.maximumSubscriberQueuedPayloadBytes,
            retainedEvents: Math.min(
                totalPublishedEvents,
                qualificationEventLimits.maximumRetainedEvents
            ),
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
        rounds: Array.from({ length: scenarioPolicy.rounds }, () => ({
            durationMs: roundDurationMs,
            eventsPublished: eventsPerRound,
        })),
        runtime: {
            hasGlobalEventSource: false,
            revision: "a".repeat(40),
            version: "1.4.0",
        },
        subscriptionCount: expectedSubscriptionCount,
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

    test("returns a deeply frozen canonical copy", () => {
        const candidate = validCandidate();
        const mutableFeed = { ...candidate.feed };
        const mutableFinalMemoryEvents = {
            ...candidate.cgroup.final.memoryEvents,
        };
        candidate.feed = mutableFeed;
        candidate.cgroup.final = cgroupSnapshot({
            memoryEvents: mutableFinalMemoryEvents,
        });

        const evidence = validateSseMemoryEvidence(candidate);
        const baselineAncestor = evidence.cgroup.ancestors.baseline.at(0);
        const finalAncestor = evidence.cgroup.ancestors.final.at(0);
        const firstRound = evidence.rounds.at(0);
        if (
            baselineAncestor === undefined ||
            finalAncestor === undefined ||
            firstRound === undefined
        ) {
            throw new Error("Expected canonical evidence fixtures");
        }

        expect(Object.isFrozen(evidence)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.ancestors)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.ancestors.baseline)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.ancestors.final)).toBeTrue();
        expect(Object.isFrozen(baselineAncestor)).toBeTrue();
        expect(Object.isFrozen(baselineAncestor.memoryEvents)).toBeTrue();
        expect(Object.isFrozen(finalAncestor)).toBeTrue();
        expect(Object.isFrozen(finalAncestor.memoryEvents)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.initial)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.initial.memoryEvents)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.baseline)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.baseline.memoryEvents)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.final)).toBeTrue();
        expect(Object.isFrozen(evidence.cgroup.final.memoryEvents)).toBeTrue();
        expect(Object.isFrozen(evidence.feed)).toBeTrue();
        expect(Object.isFrozen(evidence.memoryEventDelta)).toBeTrue();
        expect(Object.isFrozen(evidence.process)).toBeTrue();
        expect(Object.isFrozen(evidence.process.afterCleanup)).toBeTrue();
        expect(Object.isFrozen(evidence.process.baseline)).toBeTrue();
        expect(Object.isFrozen(evidence.process.sampledPeak)).toBeTrue();
        expect(Object.isFrozen(evidence.rounds)).toBeTrue();
        expect(Object.isFrozen(firstRound)).toBeTrue();
        expect(Object.isFrozen(evidence.runtime)).toBeTrue();

        mutableFeed.activeSubscribers = 1;
        mutableFinalMemoryEvents.high = 1;
        expect(evidence.feed.activeSubscribers).toBe(0);
        expect(evidence.cgroup.final.memoryEvents.high).toBe(0);
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
            memoryCurrentBytes:
                baselineCgroupMemoryBytes +
                scenarioPolicy.maximumPostCleanupCgroupIncreaseBytes +
                1,
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

        const tamperedInvariant = {
            ...evidence,
            feed: { ...evidence.feed, activeSubscribers: 1 },
        };
        expect(() =>
            parseSseMemoryQualificationEvidence(JSON.stringify(tamperedInvariant))
        ).toThrow("Active subscribers after cleanup");

        const invalidRevision = {
            ...evidence,
            runtime: { ...evidence.runtime, revision: "A".repeat(40) },
        };
        expect(() =>
            parseSseMemoryQualificationEvidence(JSON.stringify(invalidRevision))
        ).toThrow("Bun revision is not a full commit SHA");

        const tamperedDelta = {
            ...evidence,
            memoryEventDelta: { ...evidence.memoryEventDelta, high: 1 },
        };
        expect(() =>
            parseSseMemoryQualificationEvidence(JSON.stringify(tamperedDelta))
        ).toThrow("invalid high");
    });
});
