import * as v from "valibot";

import { nonnegativeSafeIntegerSchema } from "../../src/shared/validation.ts";
import type { QualificationEventFeedMetrics } from "../realtime/eventFeed.ts";
import type { RuntimeIdentity } from "../runtimeCandidate.ts";
import type { CgroupV2MemoryEvents, CgroupV2Snapshot } from "./cgroupV2.ts";
import type { CgroupV2AncestorSnapshot } from "./cgroupV2Hierarchy.ts";
import type { ProcessMemorySnapshot } from "./processMemory.ts";

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
const nonnegativeIntegerSchema = nonnegativeSafeIntegerSchema();
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

function freezeMemoryEvents(
    memoryEvents: Readonly<CgroupV2MemoryEvents>
): Readonly<CgroupV2MemoryEvents> {
    return Object.freeze({ ...memoryEvents });
}

function freezeCgroupSnapshot(
    snapshot: Readonly<CgroupV2Snapshot>
): Readonly<CgroupV2Snapshot> {
    return Object.freeze({
        ...snapshot,
        memoryEvents: freezeMemoryEvents(snapshot.memoryEvents),
    });
}

function freezeAncestorSnapshot(
    snapshot: Readonly<CgroupV2AncestorSnapshot>
): Readonly<CgroupV2AncestorSnapshot> {
    return Object.freeze({
        ...snapshot,
        memoryEvents: freezeMemoryEvents(snapshot.memoryEvents),
    });
}

function freezeAncestorSnapshots(
    snapshots: readonly Readonly<CgroupV2AncestorSnapshot>[]
): readonly Readonly<CgroupV2AncestorSnapshot>[] {
    return Object.freeze(snapshots.map((snapshot) => freezeAncestorSnapshot(snapshot)));
}

function freezeProcessMemorySnapshot(
    snapshot: Readonly<ProcessMemorySnapshot>
): Readonly<ProcessMemorySnapshot> {
    return Object.freeze({ ...snapshot });
}

/**
 * Reconstructs deeply immutable evidence after policy validation.
 * @param candidate Raw qualification measurements.
 * @param memoryEventDelta Validated monotonic memory-controller differences.
 * @returns Canonical immutable evidence.
 */
export function canonicalizeSseMemoryQualificationEvidence(
    candidate: SseMemoryEvidenceCandidate,
    memoryEventDelta: Readonly<CgroupV2MemoryEvents>
): Readonly<SseMemoryQualificationEvidence> {
    const ancestors = Object.freeze({
        baseline: freezeAncestorSnapshots(candidate.cgroup.ancestors.baseline),
        final: freezeAncestorSnapshots(candidate.cgroup.ancestors.final),
    });
    const cgroup = Object.freeze({
        ancestors,
        baseline: freezeCgroupSnapshot(candidate.cgroup.baseline),
        final: freezeCgroupSnapshot(candidate.cgroup.final),
        initial: freezeCgroupSnapshot(candidate.cgroup.initial),
    });
    const process = Object.freeze({
        afterCleanup: freezeProcessMemorySnapshot(candidate.process.afterCleanup),
        baseline: freezeProcessMemorySnapshot(candidate.process.baseline),
        sampledPeak: freezeProcessMemorySnapshot(candidate.process.sampledPeak),
    });
    const rounds = Object.freeze(
        candidate.rounds.map((round) => Object.freeze({ ...round }))
    );

    return Object.freeze({
        cgroup,
        durationMs: candidate.durationMs,
        feed: Object.freeze({ ...candidate.feed }),
        memoryEventDelta: freezeMemoryEvents(memoryEventDelta),
        process,
        proxyUpstreamUnavailableCount: candidate.proxyUpstreamUnavailableCount,
        rounds,
        runtime: Object.freeze({ ...candidate.runtime }),
        subscriptionCount: candidate.subscriptionCount,
        unitName: candidate.unitName,
        verdict: "VALIDATED",
    });
}

/**
 * Applies the strict serialized-evidence schema before policy validation.
 * @param value Serialized child-process evidence.
 * @returns Structurally valid, but not yet policy-validated, evidence.
 */
export function parseSerializedSseMemoryQualificationEvidence(
    value: string
): SseMemoryQualificationEvidence {
    return v.parse(qualificationEvidenceSchema, JSON.parse(value) as unknown);
}
