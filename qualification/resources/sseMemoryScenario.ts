import { QualificationEventFeed } from "../realtime/eventFeed.ts";
import { readRuntimeIdentity } from "../runtimeCandidate.ts";
import { AsyncCleanupStack } from "../test/asyncCleanupStack.ts";
import { waitFor } from "../test/waitFor.ts";
import { startHttpsReverseProxy } from "../topology/httpsReverseProxy.ts";
import { createTestTlsIdentity } from "../topology/testTlsIdentity.ts";
import { startQualificationServer } from "../trpc/server.ts";
import { readCurrentCgroupV2Snapshot } from "./cgroupV2.ts";
import {
    type CgroupV2AncestorSnapshot,
    readCgroupV2AncestorSnapshots,
} from "./cgroupV2Hierarchy.ts";
import { openPausedTlsSseClient, type PausedTlsSseClient } from "./pausedTlsSseClient.ts";
import {
    maximumProcessMemory,
    readProcessMemorySnapshot,
    type ProcessMemorySnapshot,
    type ProcessMemorySampler,
    startProcessMemorySampler,
} from "./processMemory.ts";
import {
    assertCgroupAncestorResourcePolicy,
    assertCgroupResourcePolicy,
    sseMemoryQualificationPolicy,
} from "./resourcePolicy.ts";
import {
    type SseMemoryQualificationEvidence,
    type SseMemoryRoundEvidence,
    validateSseMemoryEvidence,
} from "./sseMemoryEvidence.ts";
import {
    currentQualificationUserId,
    expectedSseMemoryUnitCgroupPath,
} from "./unitIdentity.ts";

const qualificationCookie = "mira_qualification=slow-consumer";

function traceScenario(phase: string, startedAt: number): void {
    process.stderr.write(
        `SSE memory scenario ${phase} at ${Math.round(performance.now() - startedAt)} ms\n`
    );
}

function qualificationPayload(sequence: number, size: number): string {
    const prefix = `${sequence.toString(36).padStart(12, "0")}:`;
    const seed = Array.from({ length: 128 }, (_value, index) =>
        String.fromCodePoint(33 + ((sequence * 31 + index * 17) % 90))
    ).join("");
    return `${prefix}${seed.repeat(Math.ceil(size / seed.length))}`.slice(0, size);
}

async function closeConsumers(consumers: readonly PausedTlsSseClient[]): Promise<void> {
    const results = await Promise.allSettled(
        consumers.map((consumer) => consumer.close())
    );
    const failures: unknown[] = [];
    for (const result of results) {
        if (result.status === "rejected") {
            failures.push(result.reason as unknown);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, "Could not close SSE slow consumers");
    }
}

async function settleMemory(): Promise<void> {
    Bun.gc(true);
    await Bun.sleep(sseMemoryQualificationPolicy.scenario.stabilizationMs);
}

async function waitForApplicationDisconnect(
    eventFeed: QualificationEventFeed,
    expectedDrops: number,
    timeoutMs: number
): Promise<void> {
    try {
        await waitFor(() => {
            const metrics = eventFeed.metricsSnapshot();
            return (
                metrics.droppedSlowSubscribers === expectedDrops &&
                metrics.activeSubscribers === 0
            );
        }, timeoutMs);
    } catch (error) {
        const metrics = eventFeed.metricsSnapshot();
        throw new Error(
            `SSE slow-consumer application queue did not detach: drops=${metrics.droppedSlowSubscribers}/${expectedDrops}, active=${metrics.activeSubscribers}`,
            { cause: error }
        );
    }
}

async function waitForTransportCleanup(
    release: ReturnType<typeof startQualificationServer>,
    proxy: ReturnType<typeof startHttpsReverseProxy>,
    timeoutMs: number
): Promise<void> {
    try {
        await waitFor(
            () =>
                release.server.pendingRequests === 0 &&
                proxy.server.pendingRequests === 0,
            timeoutMs
        );
    } catch (error) {
        throw new Error(
            `SSE slow-consumer transport did not clean up: releasePending=${release.server.pendingRequests}, proxyPending=${proxy.server.pendingRequests}`,
            { cause: error }
        );
    }
}

function remainingRoundTime(deadline: number): number {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) {
        throw new Error("SSE slow-consumer round exceeded its disconnect deadline");
    }
    return remaining;
}

/**
 * Executes the production-shaped SSE slow-consumer scenario inside a verified cgroup.
 * @param unitName Exact transient unit identity supplied by the capped parent.
 * @returns Validated resource and behavior evidence.
 */
export async function runSseMemoryScenario(
    unitName: string
): Promise<Readonly<SseMemoryQualificationEvidence>> {
    const initialCgroup = await readCurrentCgroupV2Snapshot();
    const expectedCgroupPath = expectedSseMemoryUnitCgroupPath(
        currentQualificationUserId(),
        unitName
    );
    assertCgroupResourcePolicy(initialCgroup, expectedCgroupPath);
    const startedAt = performance.now();
    const cleanup = new AsyncCleanupStack();
    const allConsumers: PausedTlsSseClient[] = [];
    const eventFeed = new QualificationEventFeed();
    const roundEvidence: SseMemoryRoundEvidence[] = [];
    let sampledPeak: ProcessMemorySnapshot | undefined;
    let processSampler: ProcessMemorySampler | undefined;
    let baselineProcess: ProcessMemorySnapshot | undefined;
    let baselineCgroup:
        | Awaited<ReturnType<typeof readCurrentCgroupV2Snapshot>>
        | undefined;
    let baselineCgroupAncestors:
        | readonly Readonly<CgroupV2AncestorSnapshot>[]
        | undefined;
    let proxyUpstreamUnavailableCount = 0;

    try {
        traceScenario("starting", startedAt);
        const tlsIdentity = await createTestTlsIdentity();
        cleanup.defer("SSE memory TLS identity", () => tlsIdentity.dispose());
        const release = startQualificationServer({
            eventFeed,
            hostname: "127.0.0.1",
            maximumStreamDurationMs:
                sseMemoryQualificationPolicy.scenario.maximumDurationMs,
            releaseId: "sse-memory-qualification",
            requiredCookie: qualificationCookie,
            requireSecureProxy: true,
        });
        cleanup.defer("SSE memory qualification release", () => release.stop(true));
        const proxy = startHttpsReverseProxy({
            certificate: tlsIdentity.certificate,
            privateKey: tlsIdentity.privateKey,
            target: new URL(`http://127.0.0.1:${release.port}`),
        });
        cleanup.defer("SSE memory qualification proxy", () => proxy.stop(true));
        cleanup.defer("SSE memory slow consumers", () => closeConsumers(allConsumers));

        await settleMemory();
        baselineCgroup = await readCurrentCgroupV2Snapshot();
        baselineCgroupAncestors = await readCgroupV2AncestorSnapshots(
            baselineCgroup.path
        );
        assertCgroupAncestorResourcePolicy(baselineCgroupAncestors);
        baselineProcess = readProcessMemorySnapshot();
        sampledPeak = baselineProcess;
        processSampler = startProcessMemorySampler(
            baselineProcess,
            sseMemoryQualificationPolicy.scenario.processSampleIntervalMs
        );
        const activeProcessSampler = processSampler;
        cleanup.defer("SSE memory process sampler", () => {
            sampledPeak = activeProcessSampler.stop();
        });
        traceScenario("baseline-ready", startedAt);
        let publishedEvents = 0;

        for (
            let roundIndex = 0;
            roundIndex < sseMemoryQualificationPolicy.scenario.rounds;
            roundIndex += 1
        ) {
            traceScenario(`round-${roundIndex + 1}-starting`, startedAt);
            const roundStartedAt = performance.now();
            const roundDeadline =
                roundStartedAt +
                sseMemoryQualificationPolicy.scenario.roundDisconnectTimeoutMs;
            const roundConsumers: PausedTlsSseClient[] = [];
            const expectedDrops =
                (roundIndex + 1) * sseMemoryQualificationPolicy.scenario.consumerCount;

            for (
                let consumerIndex = 0;
                consumerIndex < sseMemoryQualificationPolicy.scenario.consumerCount;
                consumerIndex += 1
            ) {
                const consumer = await openPausedTlsSseClient(
                    proxy.url,
                    tlsIdentity.certificate,
                    qualificationCookie,
                    remainingRoundTime(roundDeadline)
                );
                allConsumers.push(consumer);
                roundConsumers.push(consumer);
            }
            traceScenario(`round-${roundIndex + 1}-clients-paused`, startedAt);
            await waitFor(
                () =>
                    eventFeed.activeSubscriberCount ===
                    sseMemoryQualificationPolicy.scenario.consumerCount,
                remainingRoundTime(roundDeadline)
            );

            let roundPublishedEvents = 0;
            while (
                roundPublishedEvents <
                    sseMemoryQualificationPolicy.scenario.maximumEventsPerRound &&
                eventFeed.metricsSnapshot().droppedSlowSubscribers < expectedDrops
            ) {
                const remaining =
                    sseMemoryQualificationPolicy.scenario.maximumEventsPerRound -
                    roundPublishedEvents;
                const batchSize = Math.min(
                    remaining,
                    sseMemoryQualificationPolicy.scenario.publishBatchSize
                );
                for (let index = 0; index < batchSize; index += 1) {
                    publishedEvents += 1;
                    roundPublishedEvents += 1;
                    eventFeed.publish({
                        kind: "qualification.changed",
                        payload: qualificationPayload(
                            publishedEvents,
                            sseMemoryQualificationPolicy.scenario.payloadBytes
                        ),
                        value: publishedEvents,
                    });
                }
                await Bun.sleep(0);
                sampledPeak = processSampler.sample();
                remainingRoundTime(roundDeadline);
            }

            await waitForApplicationDisconnect(
                eventFeed,
                expectedDrops,
                remainingRoundTime(roundDeadline)
            );
            traceScenario(`round-${roundIndex + 1}-queues-detached`, startedAt);
            await closeConsumers(roundConsumers);
            traceScenario(`round-${roundIndex + 1}-clients-closed`, startedAt);
            await waitForTransportCleanup(
                release,
                proxy,
                remainingRoundTime(roundDeadline)
            );
            traceScenario(`round-${roundIndex + 1}-transport-clean`, startedAt);
            sampledPeak = processSampler.sample();
            roundEvidence.push({
                durationMs: performance.now() - roundStartedAt,
                eventsPublished: roundPublishedEvents,
            });
        }
        proxyUpstreamUnavailableCount = proxy.upstreamUnavailableCount;
    } finally {
        traceScenario("cleanup-starting", startedAt);
        await cleanup.dispose();
        traceScenario("cleanup-complete", startedAt);
    }

    if (
        baselineCgroup === undefined ||
        baselineCgroupAncestors === undefined ||
        baselineProcess === undefined ||
        sampledPeak === undefined
    ) {
        throw new Error("SSE memory scenario ended before establishing its baseline");
    }
    await settleMemory();
    const finalCgroup = await readCurrentCgroupV2Snapshot();
    const finalCgroupAncestors = await readCgroupV2AncestorSnapshots(finalCgroup.path);
    const afterCleanup = readProcessMemorySnapshot();
    sampledPeak = maximumProcessMemory(sampledPeak, afterCleanup);

    return validateSseMemoryEvidence({
        cgroup: {
            ancestors: {
                baseline: baselineCgroupAncestors,
                final: finalCgroupAncestors,
            },
            baseline: baselineCgroup,
            final: finalCgroup,
            initial: initialCgroup,
        },
        durationMs: performance.now() - startedAt,
        feed: eventFeed.metricsSnapshot(),
        process: {
            afterCleanup,
            baseline: baselineProcess,
            sampledPeak,
        },
        proxyUpstreamUnavailableCount,
        rounds: roundEvidence,
        runtime: readRuntimeIdentity(),
        subscriptionCount: eventFeed.observedResumeIds.length,
        unitName,
    });
}
