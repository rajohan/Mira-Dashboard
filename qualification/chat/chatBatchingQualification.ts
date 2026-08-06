import type { ChatFixture } from "../openclaw/sourceAuditSchemas.ts";
import {
    simulateChatBatching,
    type ChatBatchingMetrics,
    type ChatBatchTraceEvent,
} from "./chatBatchingModel.ts";

export const chatBatchingCandidateIntervalsMs = [50, 100, 150, 200, 250, 500] as const;
export const chatBatchingConcurrencyLevels = [1, 4, 8] as const;

export interface ChatBatchingCandidateEvidence {
    readonly accepted: boolean;
    readonly concurrency: number;
    readonly metrics: ChatBatchingMetrics;
    readonly rejectionReasons: readonly string[];
}

export interface ChatBatchingQualificationEvidence {
    readonly candidates: readonly ChatBatchingCandidateEvidence[];
    readonly maximumAdditionalVisualDelayMs: number;
    readonly maximumCrashWindowMs: number;
    readonly maximumScheduledTransactionsPerSecond: number;
    readonly selectedIntervalMs: number;
    readonly sourceDeltaThrottleMs: number;
}

type SyntheticChatEvent = ChatFixture["syntheticScenarios"][number]["events"][number];

const textEncoder = new TextEncoder();

function fixtureEvent(
    fixture: ChatFixture,
    scenarioId: string,
    kind: SyntheticChatEvent["kind"]
): SyntheticChatEvent {
    const scenario = fixture.syntheticScenarios.find(({ id }) => id === scenarioId);
    const event = scenario?.events.find((candidate) => candidate.kind === kind);
    if (event === undefined) {
        throw new Error(`Reviewed chat fixture lacks ${scenarioId}/${kind}`);
    }
    return event;
}

function payloadBytes(
    runId: string,
    sequence: number,
    event: SyntheticChatEvent
): number {
    return textEncoder.encode(JSON.stringify({ ...event, runId, seq: sequence }))
        .byteLength;
}

/**
 * Builds a deterministic, source-shaped streaming load without host runtime data.
 *
 * @param fixture Reviewed, version-pinned OpenClaw chat fixture.
 * @param concurrency Number of interleaved synthetic runs.
 * @returns A bounded deterministic trace for the batching simulator.
 */
export function buildChatBatchingTrace(
    fixture: ChatFixture,
    concurrency: number
): readonly ChatBatchTraceEvent[] {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
        throw new RangeError("Chat batching concurrency is outside qualification bounds");
    }
    const throttleMs = fixture.streamingPolicy.deltaThrottleMs;
    const agentDeltaForStream = (stream: "assistant" | "thinking") =>
        fixture.syntheticScenarios
            .flatMap(({ events }) => events)
            .find(
                (event): event is Extract<SyntheticChatEvent, { kind: "agent-delta" }> =>
                    event.kind === "agent-delta" && event.stream === stream
            );
    const thinking = agentDeltaForStream("thinking");
    const assistant = agentDeltaForStream("assistant");
    if (thinking === undefined || assistant === undefined) {
        throw new Error("Reviewed chat fixture lacks both coalesced agent streams");
    }
    const toolStart = fixtureEvent(fixture, "completed-tool-run", "tool-start");
    const toolResult = fixtureEvent(fixture, "completed-tool-run", "tool-result");
    const chatDelta = fixtureEvent(fixture, "completed-tool-run", "chat-delta");
    const final = fixtureEvent(fixture, "completed-tool-run", "chat-terminal");
    const aborted = fixtureEvent(fixture, "cancelled-run", "chat-terminal");
    const events: ChatBatchTraceEvent[] = [];

    for (let runIndex = 0; runIndex < concurrency; runIndex += 1) {
        const runId = `qualification-run-${runIndex + 1}`;
        const offsetMs = Math.floor((throttleMs * runIndex) / concurrency);
        let sequence = 0;
        const append = (
            arrivedAtMs: number,
            kind: ChatBatchTraceEvent["kind"],
            template: SyntheticChatEvent,
            stream?: "assistant" | "thinking"
        ): void => {
            sequence += 1;
            events.push({
                arrivedAtMs,
                kind,
                payloadBytes: payloadBytes(runId, sequence, template),
                runId,
                sequence,
                ...(stream === undefined ? {} : { stream }),
            });
        };

        for (let deltaIndex = 0; deltaIndex < 48; deltaIndex += 1) {
            const arrivedAtMs = offsetMs + deltaIndex * throttleMs;
            const stream = deltaIndex < 12 ? "thinking" : "assistant";
            append(
                arrivedAtMs,
                "delta",
                stream === "thinking" ? thinking : assistant,
                stream
            );
            if (deltaIndex === 12) {
                append(arrivedAtMs + Math.floor(throttleMs / 3), "boundary", toolStart);
                append(
                    arrivedAtMs + Math.floor((throttleMs * 2) / 3),
                    "boundary",
                    toolResult
                );
            }
        }
        const finalDeltaAtMs = offsetMs + 48 * throttleMs;
        append(finalDeltaAtMs, "delta", chatDelta, "assistant");
        append(
            finalDeltaAtMs + Math.floor(throttleMs / 2),
            "terminal",
            runIndex % 2 === 0 ? final : aborted
        );
    }
    return Object.freeze(events);
}

function candidateRejectionReasons(
    metrics: ChatBatchingMetrics,
    fixture: ChatFixture
): readonly string[] {
    const throttleMs = fixture.streamingPolicy.deltaThrottleMs;
    const maximumAdditionalVisualDelayMs = throttleMs;
    const maximumCrashWindowMs = throttleMs;
    const maximumScheduledTransactionsPerSecond = Math.ceil(1000 / throttleMs);
    return Object.freeze([
        ...(metrics.maximumCommitDelayMs > maximumAdditionalVisualDelayMs
            ? ["visual-delay-exceeds-one-source-tick"]
            : []),
        ...(metrics.maximumCommitDelayMs > maximumCrashWindowMs
            ? ["crash-window-exceeds-one-source-tick"]
            : []),
        ...(metrics.peakScheduledTransactionsPerSecond >
        maximumScheduledTransactionsPerSecond
            ? ["scheduled-write-rate-exceeds-source-cadence"]
            : []),
        ...(metrics.terminalMaximumCommitDelayMs === 0
            ? []
            : ["terminal-event-was-not-flushed-immediately"]),
        ...(metrics.boundaryMaximumCommitDelayMs === 0
            ? []
            : ["semantic-boundary-was-not-flushed-immediately"]),
        ...(metrics.committedEvents === metrics.inputEvents
            ? []
            : ["event-count-mismatch"]),
    ]);
}

/**
 * Evaluates every reviewed interval at one, four, and eight concurrent runs.
 *
 * @param fixture Reviewed, version-pinned OpenClaw chat fixture.
 * @returns Candidate evidence and the smallest interval satisfying every bound.
 */
export function qualifyChatBatching(
    fixture: ChatFixture
): ChatBatchingQualificationEvidence {
    const candidates = chatBatchingCandidateIntervalsMs.flatMap((intervalMs) =>
        chatBatchingConcurrencyLevels.map((concurrency) => {
            const metrics = simulateChatBatching(
                buildChatBatchingTrace(fixture, concurrency),
                intervalMs
            );
            const rejectionReasons = candidateRejectionReasons(metrics, fixture);
            return Object.freeze({
                accepted: rejectionReasons.length === 0,
                concurrency,
                metrics,
                rejectionReasons,
            });
        })
    );
    const selectedIntervalMs = chatBatchingCandidateIntervalsMs.find((intervalMs) =>
        candidates
            .filter((candidate) => candidate.metrics.intervalMs === intervalMs)
            .every(({ accepted }) => accepted)
    );
    if (selectedIntervalMs === undefined) {
        throw new Error("No chat batching candidate satisfies the reviewed policy");
    }
    const sourceDeltaThrottleMs = fixture.streamingPolicy.deltaThrottleMs;
    return Object.freeze({
        candidates: Object.freeze(candidates),
        maximumAdditionalVisualDelayMs: sourceDeltaThrottleMs,
        maximumCrashWindowMs: sourceDeltaThrottleMs,
        maximumScheduledTransactionsPerSecond: Math.ceil(1000 / sourceDeltaThrottleMs),
        selectedIntervalMs,
        sourceDeltaThrottleMs,
    });
}
