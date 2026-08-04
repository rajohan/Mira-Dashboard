import * as v from "valibot";

import {
    type QualificationEventFeedMetrics,
    qualificationEventLimits,
} from "../realtime/eventFeed.ts";
import type { RuntimeIdentity } from "../runtimeCandidate.ts";
import type { CgroupV2MemoryEvents, CgroupV2Snapshot } from "./cgroupV2.ts";
import {
    ancestorCgroupV2Paths,
    type CgroupV2AncestorSnapshot,
} from "./cgroupV2Hierarchy.ts";
import type { ProcessMemorySnapshot } from "./processMemory.ts";
import {
    assertCgroupAncestorResourcePolicy,
    assertCgroupResourcePolicy,
    sseMemoryQualificationPolicy,
} from "./resourcePolicy.ts";
import {
    currentQualificationUserId,
    expectedSseMemoryUnitCgroupPath,
} from "./unitIdentity.ts";

/** One bounded slow-consumer round. */
export interface SseMemoryRoundEvidence {
    durationMs: number;
    eventsPublished: number;
}

/** Raw measurements produced by one capped SSE scenario. */
export interface SseMemoryEvidenceCandidate {
    cgroup: {
        ancestors: {
            baseline: readonly Readonly<CgroupV2AncestorSnapshot>[];
            final: readonly Readonly<CgroupV2AncestorSnapshot>[];
        };
        baseline: Readonly<CgroupV2Snapshot>;
        final: Readonly<CgroupV2Snapshot>;
        initial: Readonly<CgroupV2Snapshot>;
    };
    durationMs: number;
    feed: Readonly<QualificationEventFeedMetrics>;
    process: {
        afterCleanup: Readonly<ProcessMemorySnapshot>;
        baseline: Readonly<ProcessMemorySnapshot>;
        sampledPeak: Readonly<ProcessMemorySnapshot>;
    };
    proxyUpstreamUnavailableCount: number;
    rounds: readonly SseMemoryRoundEvidence[];
    runtime: Readonly<RuntimeIdentity>;
    subscriptionCount: number;
    unitName: string;
}

/** Evidence emitted only after every policy assertion succeeds. */
export interface SseMemoryQualificationEvidence extends SseMemoryEvidenceCandidate {
    memoryEventDelta: Readonly<CgroupV2MemoryEvents>;
    verdict: "VALIDATED";
}

const nonnegativeNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const nonnegativeIntegerSchema = v.pipe(nonnegativeNumberSchema, v.safeInteger());
const cgroupLimitSchema = v.union([nonnegativeIntegerSchema, v.literal("max")]);
const memoryEventsSchema = v.strictObject({
    high: nonnegativeIntegerSchema,
    low: nonnegativeIntegerSchema,
    max: nonnegativeIntegerSchema,
    oom: nonnegativeIntegerSchema,
    oomGroupKill: nonnegativeIntegerSchema,
    oomKill: nonnegativeIntegerSchema,
});
const cgroupSnapshotSchema = v.strictObject({
    cpuPeriodMicros: nonnegativeIntegerSchema,
    cpuQuotaMicros: cgroupLimitSchema,
    memoryCurrentBytes: nonnegativeIntegerSchema,
    memoryEvents: memoryEventsSchema,
    memoryHighBytes: cgroupLimitSchema,
    memoryMaxBytes: cgroupLimitSchema,
    memoryPeakBytes: nonnegativeIntegerSchema,
    memorySwapMaxBytes: cgroupLimitSchema,
    oomGroup: v.boolean(),
    path: v.string(),
    pidsCurrent: nonnegativeIntegerSchema,
    pidsMax: cgroupLimitSchema,
});
const cgroupAncestorSnapshotSchema = v.strictObject({
    cpuPeriodMicros: nonnegativeIntegerSchema,
    cpuQuotaMicros: cgroupLimitSchema,
    memoryEvents: memoryEventsSchema,
    memoryHighBytes: cgroupLimitSchema,
    memoryMaxBytes: cgroupLimitSchema,
    memorySwapMaxBytes: cgroupLimitSchema,
    path: v.string(),
    pidsMax: cgroupLimitSchema,
});
const processMemorySchema = v.strictObject({
    rssBytes: nonnegativeIntegerSchema,
    unsafeFootprintBytes: v.union([nonnegativeIntegerSchema, v.null_()]),
});
const roundEvidenceSchema = v.strictObject({
    durationMs: nonnegativeNumberSchema,
    eventsPublished: nonnegativeIntegerSchema,
});
const runtimeIdentitySchema = v.strictObject({
    hasGlobalEventSource: v.boolean(),
    revision: v.string(),
    version: v.string(),
});
const feedMetricsSchema = v.strictObject({
    activeSubscribers: nonnegativeIntegerSchema,
    droppedSlowSubscribers: nonnegativeIntegerSchema,
    latestSequence: nonnegativeIntegerSchema,
    maximumObservedQueueDepth: nonnegativeIntegerSchema,
    maximumObservedQueuedPayloadBytes: nonnegativeIntegerSchema,
    retainedEvents: nonnegativeIntegerSchema,
});
const cgroupAncestorEvidenceSchema = v.strictObject({
    baseline: v.array(cgroupAncestorSnapshotSchema),
    final: v.array(cgroupAncestorSnapshotSchema),
});
const qualificationEvidenceSchema = v.strictObject({
    cgroup: v.strictObject({
        ancestors: cgroupAncestorEvidenceSchema,
        baseline: cgroupSnapshotSchema,
        final: cgroupSnapshotSchema,
        initial: cgroupSnapshotSchema,
    }),
    durationMs: nonnegativeNumberSchema,
    feed: feedMetricsSchema,
    memoryEventDelta: memoryEventsSchema,
    process: v.strictObject({
        afterCleanup: processMemorySchema,
        baseline: processMemorySchema,
        sampledPeak: processMemorySchema,
    }),
    proxyUpstreamUnavailableCount: nonnegativeIntegerSchema,
    rounds: v.array(roundEvidenceSchema),
    runtime: runtimeIdentitySchema,
    subscriptionCount: nonnegativeIntegerSchema,
    unitName: v.string(),
    verdict: v.literal("VALIDATED"),
});

function difference(label: string, finalValue: number, baselineValue: number): number {
    const value = finalValue - baselineValue;
    if (value < 0) {
        throw new Error(`${label} decreased during the qualification`);
    }
    return value;
}

/**
 * Calculates monotonic memory-controller event differences.
 * @param baseline Counters before slow consumers attach.
 * @param final Counters after cleanup.
 * @returns Immutable counter differences.
 */
export function memoryEventDifference(
    baseline: Readonly<CgroupV2MemoryEvents>,
    final: Readonly<CgroupV2MemoryEvents>
): Readonly<CgroupV2MemoryEvents> {
    return Object.freeze({
        high: difference("memory.events high", final.high, baseline.high),
        low: difference("memory.events low", final.low, baseline.low),
        max: difference("memory.events max", final.max, baseline.max),
        oom: difference("memory.events oom", final.oom, baseline.oom),
        oomGroupKill: difference(
            "memory.events oom_group_kill",
            final.oomGroupKill,
            baseline.oomGroupKill
        ),
        oomKill: difference("memory.events oom_kill", final.oomKill, baseline.oomKill),
    });
}

function assertSameAncestorValue(
    label: string,
    baseline: number | string,
    final: number | string
): void {
    if (baseline !== final) {
        throw new Error(
            `Cgroup ancestor ${label} changed during qualification: ${String(baseline)} -> ${String(final)}`
        );
    }
}

function assertAncestorEvidence(
    leafPath: string,
    ancestors: SseMemoryEvidenceCandidate["cgroup"]["ancestors"]
): void {
    const expectedPaths = ancestorCgroupV2Paths(leafPath);
    assertExact(
        "Baseline cgroup ancestor count",
        ancestors.baseline.length,
        expectedPaths.length
    );
    assertExact(
        "Final cgroup ancestor count",
        ancestors.final.length,
        expectedPaths.length
    );
    assertCgroupAncestorResourcePolicy(ancestors.baseline);
    assertCgroupAncestorResourcePolicy(ancestors.final);

    for (const [index, expectedPath] of expectedPaths.entries()) {
        const baseline = ancestors.baseline[index];
        const final = ancestors.final[index];
        if (baseline === undefined || final === undefined) {
            throw new Error("Cgroup ancestor evidence is incomplete");
        }
        if (baseline.path !== expectedPath || final.path !== expectedPath) {
            throw new Error(`Cgroup ancestor path does not match ${expectedPath}`);
        }
        assertSameAncestorValue(
            `${expectedPath} cpu period`,
            baseline.cpuPeriodMicros,
            final.cpuPeriodMicros
        );
        assertSameAncestorValue(
            `${expectedPath} CPU quota`,
            baseline.cpuQuotaMicros,
            final.cpuQuotaMicros
        );
        assertSameAncestorValue(
            `${expectedPath} memory.high`,
            baseline.memoryHighBytes,
            final.memoryHighBytes
        );
        assertSameAncestorValue(
            `${expectedPath} memory.max`,
            baseline.memoryMaxBytes,
            final.memoryMaxBytes
        );
        assertSameAncestorValue(
            `${expectedPath} memory.swap.max`,
            baseline.memorySwapMaxBytes,
            final.memorySwapMaxBytes
        );
        assertSameAncestorValue(
            `${expectedPath} pids.max`,
            baseline.pidsMax,
            final.pidsMax
        );

        const eventDelta = memoryEventDifference(
            baseline.memoryEvents,
            final.memoryEvents
        );
        for (const [name, value] of Object.entries(eventDelta)) {
            if (name !== "low" && value !== 0) {
                throw new Error(
                    `Cgroup ancestor ${expectedPath} memory pressure event ${name} increased by ${value}`
                );
            }
        }
    }
}

function assertAtMost(label: string, value: number, maximum: number): void {
    if (value > maximum) {
        throw new Error(`${label} exceeded ${maximum} bytes; observed ${value}`);
    }
}

function assertExact(label: string, value: number, expected: number): void {
    if (value !== expected) {
        throw new Error(`${label} must equal ${expected}; observed ${value}`);
    }
}

function assertAtLeast(label: string, value: number, minimum: number): void {
    if (value < minimum) {
        throw new Error(`${label} fell below ${minimum}; observed ${value}`);
    }
}

function assertProcessMemory(processMemory: SseMemoryEvidenceCandidate["process"]): void {
    const policy = sseMemoryQualificationPolicy.scenario;
    assertAtLeast(
        "Sampled process RSS",
        processMemory.sampledPeak.rssBytes,
        Math.max(processMemory.baseline.rssBytes, processMemory.afterCleanup.rssBytes)
    );
    assertAtMost(
        "Sampled process RSS",
        processMemory.sampledPeak.rssBytes,
        policy.maximumProcessRssBytes
    );
    assertAtMost(
        "Sampled process RSS increase",
        processMemory.sampledPeak.rssBytes - processMemory.baseline.rssBytes,
        policy.maximumProcessIncreaseBytes
    );
    const baselineFootprint = processMemory.baseline.unsafeFootprintBytes;
    const peakFootprint = processMemory.sampledPeak.unsafeFootprintBytes;
    const finalFootprint = processMemory.afterCleanup.unsafeFootprintBytes;
    if (baselineFootprint === null || peakFootprint === null || finalFootprint === null) {
        throw new Error("Bun.unsafe.memoryFootprint() is required on this Linux probe");
    }
    assertAtLeast(
        "Sampled Bun memory footprint",
        peakFootprint,
        Math.max(baselineFootprint, finalFootprint)
    );
    assertAtMost(
        "Sampled Bun memory-footprint increase",
        peakFootprint - baselineFootprint,
        policy.maximumProcessIncreaseBytes
    );
}

/**
 * Validates every bounded-load and memory invariant before publishing evidence.
 * @param candidate Raw qualification measurements.
 * @returns Evidence marked as validated.
 * @throws {Error} When any resource or behavior invariant fails.
 */
export function validateSseMemoryEvidence(
    candidate: SseMemoryEvidenceCandidate
): Readonly<SseMemoryQualificationEvidence> {
    const expectedCgroupPath = expectedSseMemoryUnitCgroupPath(
        currentQualificationUserId(),
        candidate.unitName
    );
    assertCgroupResourcePolicy(candidate.cgroup.initial, expectedCgroupPath);
    assertCgroupResourcePolicy(candidate.cgroup.baseline, expectedCgroupPath);
    assertCgroupResourcePolicy(candidate.cgroup.final, expectedCgroupPath);
    assertAncestorEvidence(candidate.cgroup.initial.path, candidate.cgroup.ancestors);
    const policy = sseMemoryQualificationPolicy;
    const expectedDrops = policy.scenario.consumerCount * policy.scenario.rounds;
    const eventDelta = memoryEventDifference(
        candidate.cgroup.baseline.memoryEvents,
        candidate.cgroup.final.memoryEvents
    );
    assertAtLeast(
        "Baseline cgroup memory.peak",
        candidate.cgroup.baseline.memoryPeakBytes,
        candidate.cgroup.initial.memoryPeakBytes
    );
    assertAtLeast(
        "Final cgroup memory.peak",
        candidate.cgroup.final.memoryPeakBytes,
        candidate.cgroup.baseline.memoryPeakBytes
    );

    assertExact("Slow-consumer rounds", candidate.rounds.length, policy.scenario.rounds);
    assertExact("SSE subscription count", candidate.subscriptionCount, expectedDrops);
    assertExact(
        "Dropped slow subscribers",
        candidate.feed.droppedSlowSubscribers,
        expectedDrops
    );
    assertExact("Active subscribers after cleanup", candidate.feed.activeSubscribers, 0);
    assertExact("Proxy upstream failures", candidate.proxyUpstreamUnavailableCount, 0);
    assertExact(
        "Subscriber queue event high-water",
        candidate.feed.maximumObservedQueueDepth,
        qualificationEventLimits.maximumSubscriberQueueEvents
    );
    assertExact(
        "Subscriber queue payload high-water",
        candidate.feed.maximumObservedQueuedPayloadBytes,
        qualificationEventLimits.maximumSubscriberQueuedPayloadBytes
    );
    if (candidate.feed.retainedEvents > qualificationEventLimits.maximumRetainedEvents) {
        throw new Error("Qualification event retention exceeded its fixed limit");
    }

    let publishedEvents = 0;
    for (const round of candidate.rounds) {
        if (
            round.eventsPublished < 1 ||
            round.eventsPublished > policy.scenario.maximumEventsPerRound
        ) {
            throw new Error("SSE round exceeded its maximum event budget");
        }
        if (round.durationMs > policy.scenario.roundDisconnectTimeoutMs) {
            throw new Error("SSE round exceeded its disconnect deadline");
        }
        publishedEvents += round.eventsPublished;
    }
    assertExact("Latest event sequence", candidate.feed.latestSequence, publishedEvents);
    if (candidate.durationMs > policy.scenario.maximumDurationMs) {
        throw new Error("SSE memory scenario exceeded its fixed duration");
    }

    for (const [name, value] of Object.entries(eventDelta)) {
        if (name !== "low" && value !== 0) {
            throw new Error(`Cgroup memory pressure event ${name} increased by ${value}`);
        }
    }
    if (candidate.cgroup.final.memoryPeakBytes >= policy.cgroup.memoryHighBytes) {
        throw new Error("Cgroup memory.peak reached the MemoryHigh boundary");
    }
    assertAtMost(
        "Post-cleanup cgroup memory increase",
        candidate.cgroup.final.memoryCurrentBytes -
            candidate.cgroup.baseline.memoryCurrentBytes,
        policy.scenario.maximumPostCleanupCgroupIncreaseBytes
    );
    assertProcessMemory(candidate.process);

    if (candidate.runtime.version !== "1.4.0") {
        throw new Error(`Expected Bun 1.4.0; observed ${candidate.runtime.version}`);
    }
    if (!/^[\da-f]{40}$/u.test(candidate.runtime.revision)) {
        throw new Error("Bun revision is not a full commit SHA");
    }

    return Object.freeze({
        ...candidate,
        memoryEventDelta: eventDelta,
        verdict: "VALIDATED",
    });
}

/**
 * Parses child-process evidence strictly and replays every invariant in the parent.
 * @param value Serialized evidence emitted by the capped child.
 * @returns Canonical evidence reconstructed by the parent validator.
 */
export function parseSseMemoryQualificationEvidence(
    value: string
): Readonly<SseMemoryQualificationEvidence> {
    const parsed = v.parse(qualificationEvidenceSchema, JSON.parse(value) as unknown);
    const validated = validateSseMemoryEvidence({
        cgroup: parsed.cgroup,
        durationMs: parsed.durationMs,
        feed: parsed.feed,
        process: parsed.process,
        proxyUpstreamUnavailableCount: parsed.proxyUpstreamUnavailableCount,
        rounds: parsed.rounds,
        runtime: parsed.runtime,
        subscriptionCount: parsed.subscriptionCount,
        unitName: parsed.unitName,
    });

    for (const name of Object.keys(parsed.memoryEventDelta) as Array<
        keyof CgroupV2MemoryEvents
    >) {
        if (parsed.memoryEventDelta[name] !== validated.memoryEventDelta[name]) {
            throw new Error(`SSE memory qualification child returned invalid ${name}`);
        }
    }
    return validated;
}
