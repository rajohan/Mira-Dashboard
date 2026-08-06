export type ChatBatchTraceEventKind = "boundary" | "delta" | "terminal";

export interface ChatBatchTraceEvent {
    readonly arrivedAtMs: number;
    readonly kind: ChatBatchTraceEventKind;
    readonly payloadBytes: number;
    readonly runId: string;
    readonly sequence: number;
    readonly stream?: "assistant" | "thinking";
}

export interface ChatBatchingBatch {
    readonly commitAtMs: number;
    readonly durableBytes: number;
    readonly durableRows: number;
    readonly eventCount: number;
    readonly reason: "boundary" | "interval";
}

export interface ChatBatchingMetrics {
    readonly batches: readonly ChatBatchingBatch[];
    readonly boundaryMaximumCommitDelayMs: number;
    readonly boundaryTransactions: number;
    readonly committedEvents: number;
    readonly durableBytes: number;
    readonly durableRows: number;
    readonly inputBytes: number;
    readonly inputEvents: number;
    readonly intervalMs: number;
    readonly maximumCommitDelayMs: number;
    readonly maximumPendingBytes: number;
    readonly p95CommitDelayMs: number;
    readonly peakScheduledTransactionsPerSecond: number;
    readonly scheduledTransactions: number;
    readonly terminalMaximumCommitDelayMs: number;
    readonly transactions: number;
}

interface DurableRecord {
    eventCount: number;
    firstSequence: number;
    kind: ChatBatchTraceEventKind;
    lastSequence: number;
    payloadBytes: number;
    runId: string;
    stream?: "assistant" | "thinking";
}

const textEncoder = new TextEncoder();

function compareTraceEvents(
    left: ChatBatchTraceEvent,
    right: ChatBatchTraceEvent
): number {
    if (left.arrivedAtMs !== right.arrivedAtMs) {
        return left.arrivedAtMs - right.arrivedAtMs;
    }
    if (left.runId !== right.runId) return left.runId < right.runId ? -1 : 1;
    return left.sequence - right.sequence;
}

function assertTrace(events: readonly ChatBatchTraceEvent[]): void {
    const nextSequenceByRun = new Map<string, number>();
    for (const event of events.toSorted(compareTraceEvents)) {
        if (
            !Number.isSafeInteger(event.arrivedAtMs) ||
            event.arrivedAtMs < 0 ||
            !Number.isSafeInteger(event.payloadBytes) ||
            event.payloadBytes < 1
        ) {
            throw new RangeError("Chat batching trace contains invalid bounds");
        }
        const expectedSequence = nextSequenceByRun.get(event.runId) ?? 1;
        if (event.sequence !== expectedSequence) {
            throw new Error("Chat batching trace sequence is not contiguous");
        }
        if (event.kind === "delta" && event.stream === undefined) {
            throw new Error("Chat batching delta is missing its stream");
        }
        if (event.kind !== "delta" && event.stream !== undefined) {
            throw new Error("Chat batching boundary unexpectedly declares a stream");
        }
        nextSequenceByRun.set(event.runId, expectedSequence + 1);
    }
}

function coalesceDurableRecords(
    events: readonly ChatBatchTraceEvent[]
): readonly DurableRecord[] {
    const records: DurableRecord[] = [];
    const latestRecordByRun = new Map<string, DurableRecord>();
    for (const event of events) {
        const latest = latestRecordByRun.get(event.runId);
        if (
            event.kind === "delta" &&
            latest?.kind === "delta" &&
            latest.stream === event.stream
        ) {
            latest.eventCount += 1;
            latest.lastSequence = event.sequence;
            latest.payloadBytes += event.payloadBytes;
            continue;
        }
        const record: DurableRecord = {
            eventCount: 1,
            firstSequence: event.sequence,
            kind: event.kind,
            lastSequence: event.sequence,
            payloadBytes: event.payloadBytes,
            runId: event.runId,
            ...(event.stream === undefined ? {} : { stream: event.stream }),
        };
        records.push(record);
        latestRecordByRun.set(event.runId, record);
    }
    return records;
}

function serializedBytes(value: unknown): number {
    return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function percentile95(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function peakTransactionsPerSecond(commitTimes: readonly number[]): number {
    let peak = 0;
    let start = 0;
    for (let end = 0; end < commitTimes.length; end += 1) {
        while (commitTimes[end]! - commitTimes[start]! >= 1000) start += 1;
        peak = Math.max(peak, end - start + 1);
    }
    return peak;
}

/**
 * Simulates one process-wide fixed-window journal batcher without wall-clock timing.
 * Semantic boundaries and terminal states always flush immediately; only deltas wait.
 *
 * @param inputEvents Ordered source-shaped chat events to persist.
 * @param intervalMs Fixed batching interval under evaluation.
 * @returns Deterministic persistence and latency metrics for the trace.
 */
export function simulateChatBatching(
    inputEvents: readonly ChatBatchTraceEvent[],
    intervalMs: number
): ChatBatchingMetrics {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new RangeError("Chat batching interval must be a positive safe integer");
    }
    assertTrace(inputEvents);
    const events = inputEvents.toSorted(compareTraceEvents);
    const batches: ChatBatchingBatch[] = [];
    const commitDelays: number[] = [];
    const scheduledCommitTimes: number[] = [];
    let maximumPendingBytes = 0;
    let pending: ChatBatchTraceEvent[] = [];
    let pendingBytes = 0;
    let pendingDeadlineMs: number | undefined;
    let boundaryMaximumCommitDelayMs = 0;
    let terminalMaximumCommitDelayMs = 0;

    const flush = (commitAtMs: number, reason: ChatBatchingBatch["reason"]): void => {
        if (pending.length === 0) return;
        const records = coalesceDurableRecords(pending);
        for (const event of pending) {
            const delay = commitAtMs - event.arrivedAtMs;
            if (delay < 0) throw new Error("Chat batching committed before arrival");
            commitDelays.push(delay);
            if (event.kind === "terminal") {
                terminalMaximumCommitDelayMs = Math.max(
                    terminalMaximumCommitDelayMs,
                    delay
                );
            }
            if (event.kind === "boundary") {
                boundaryMaximumCommitDelayMs = Math.max(
                    boundaryMaximumCommitDelayMs,
                    delay
                );
            }
        }
        batches.push({
            commitAtMs,
            durableBytes: serializedBytes(records),
            durableRows: records.length,
            eventCount: pending.length,
            reason,
        });
        if (reason === "interval") scheduledCommitTimes.push(commitAtMs);
        pending = [];
        pendingBytes = 0;
        pendingDeadlineMs = undefined;
    };

    for (const event of events) {
        if (pendingDeadlineMs !== undefined && pendingDeadlineMs <= event.arrivedAtMs) {
            flush(pendingDeadlineMs, "interval");
        }
        pending.push(event);
        pendingBytes += event.payloadBytes;
        maximumPendingBytes = Math.max(maximumPendingBytes, pendingBytes);
        if (event.kind === "delta") {
            pendingDeadlineMs ??= event.arrivedAtMs + intervalMs;
        } else {
            flush(event.arrivedAtMs, "boundary");
        }
    }
    if (pendingDeadlineMs !== undefined) flush(pendingDeadlineMs, "interval");

    return Object.freeze({
        batches: Object.freeze(batches),
        boundaryMaximumCommitDelayMs,
        boundaryTransactions: batches.filter(({ reason }) => reason === "boundary")
            .length,
        committedEvents: batches.reduce((total, batch) => total + batch.eventCount, 0),
        durableBytes: batches.reduce((total, batch) => total + batch.durableBytes, 0),
        durableRows: batches.reduce((total, batch) => total + batch.durableRows, 0),
        inputBytes: events.reduce((total, event) => total + event.payloadBytes, 0),
        inputEvents: events.length,
        intervalMs,
        maximumCommitDelayMs: Math.max(0, ...commitDelays),
        maximumPendingBytes,
        p95CommitDelayMs: percentile95(commitDelays),
        peakScheduledTransactionsPerSecond:
            peakTransactionsPerSecond(scheduledCommitTimes),
        scheduledTransactions: scheduledCommitTimes.length,
        terminalMaximumCommitDelayMs,
        transactions: batches.length,
    });
}
