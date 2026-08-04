/** Data carried by the qualification event stream. */
export interface QualificationEventData {
    readonly kind: "qualification.changed";
    readonly payload?: string;
    readonly value: number;
}

/** A durable-style event record with a monotonically increasing string ID. */
export interface QualificationEventRecord {
    readonly data: QualificationEventData;
    readonly id: string;
}

/** Fixed event and subscriber budgets used by the qualification feed. */
export const qualificationEventLimits = Object.freeze({
    maximumPayloadBytes: 8192,
    maximumRetainedEvents: 128,
    maximumSubscriberQueueEvents: 16,
    maximumSubscriberQueuedPayloadBytes: 16 * 8192,
});

/** Point-in-time operational measurements for a qualification event feed. */
export interface QualificationEventFeedMetrics {
    readonly activeSubscribers: number;
    readonly droppedSlowSubscribers: number;
    readonly latestSequence: number;
    readonly maximumObservedQueueDepth: number;
    readonly maximumObservedQueuedPayloadBytes: number;
    readonly retainedEvents: number;
}

interface EventSubscriptionOptions {
    afterId?: string;
    signal: AbortSignal;
}

interface PendingRead<T> {
    reject: (reason: Error) => void;
    resolve: (result: IteratorResult<T>) => void;
}

interface QueuedValue<T> {
    readonly payloadBytes: number;
    readonly value: T;
}

interface QueuePushResult {
    readonly accepted: boolean;
    readonly queuedEventCount: number;
    readonly queuedPayloadBytes: number;
}

interface StoredQualificationEvent {
    readonly payloadBytes: number;
    readonly record: QualificationEventRecord;
}

const payloadEncoder = new TextEncoder();
const queueBudgetErrorMessage =
    "Qualification event subscriber exceeded its queue budget";
const payloadBudgetErrorMessage = `Qualification event payload exceeds ${qualificationEventLimits.maximumPayloadBytes} UTF-8 bytes`;

/**
 * Checks an event payload against the shared UTF-8 byte budget.
 * @param payload Payload text to measure.
 * @returns Whether the encoded payload fits within the event budget.
 */
export function isQualificationEventPayloadWithinLimit(payload: string): boolean {
    return (
        encodedPayloadByteLength(payload) <= qualificationEventLimits.maximumPayloadBytes
    );
}

class BoundedAsyncQueue<T> {
    readonly #pendingReads: PendingRead<T>[] = [];
    readonly #values: QueuedValue<T>[] = [];
    #closed = false;
    #failure: Error | undefined;
    #queuedPayloadBytes = 0;

    close(): void {
        this.#closed = true;
        this.#queuedPayloadBytes = 0;
        this.#values.length = 0;
        for (const pendingRead of this.#pendingReads.splice(0)) {
            pendingRead.resolve({ done: true, value: undefined });
        }
    }

    fail(error: Error): void {
        this.#closed = true;
        this.#failure = error;
        this.#queuedPayloadBytes = 0;
        this.#values.length = 0;
        for (const pendingRead of this.#pendingReads.splice(0)) {
            pendingRead.reject(error);
        }
    }

    next(): Promise<IteratorResult<T>> {
        if (this.#failure) {
            return Promise.reject(this.#failure);
        }
        const queuedValue = this.#values.shift();
        if (queuedValue !== undefined) {
            this.#queuedPayloadBytes -= queuedValue.payloadBytes;
            return Promise.resolve({ done: false, value: queuedValue.value });
        }
        if (this.#closed) {
            return Promise.resolve({ done: true, value: undefined });
        }

        return new Promise<IteratorResult<T>>((resolve, reject) => {
            this.#pendingReads.push({ reject, resolve });
        });
    }

    push(value: T, payloadBytes: number): QueuePushResult {
        if (this.#closed) {
            return this.#pushResult(false);
        }

        const pendingRead = this.#pendingReads.shift();
        if (pendingRead) {
            pendingRead.resolve({ done: false, value });
            return this.#pushResult(true);
        }

        if (
            this.#values.length >=
                qualificationEventLimits.maximumSubscriberQueueEvents ||
            this.#queuedPayloadBytes + payloadBytes >
                qualificationEventLimits.maximumSubscriberQueuedPayloadBytes
        ) {
            this.fail(new Error(queueBudgetErrorMessage));
            return this.#pushResult(false);
        }
        this.#values.push({ payloadBytes, value });
        this.#queuedPayloadBytes += payloadBytes;
        return this.#pushResult(true);
    }

    #pushResult(accepted: boolean): QueuePushResult {
        return {
            accepted,
            queuedEventCount: this.#values.length,
            queuedPayloadBytes: this.#queuedPayloadBytes,
        };
    }
}

/** In-memory qualification model for tracked replay and bounded live delivery. */
export class QualificationEventFeed {
    readonly #events: StoredQualificationEvent[] = [];
    readonly #subscribers = new Set<(event: StoredQualificationEvent) => void>();
    readonly observedResumeIds: Array<string | undefined> = [];
    #droppedSlowSubscribers = 0;
    #maximumObservedQueueDepth = 0;
    #maximumObservedQueuedPayloadBytes = 0;
    #sequence = 0;

    /**
     * Number of currently attached live subscribers.
     * @returns Current live subscriber count.
     */
    get activeSubscriberCount(): number {
        return this.#subscribers.size;
    }

    /**
     * Captures current counters and bounded-queue high-water marks.
     * @returns An immutable metrics snapshot.
     */
    metricsSnapshot(): Readonly<QualificationEventFeedMetrics> {
        return Object.freeze({
            activeSubscribers: this.#subscribers.size,
            droppedSlowSubscribers: this.#droppedSlowSubscribers,
            latestSequence: this.#sequence,
            maximumObservedQueueDepth: this.#maximumObservedQueueDepth,
            maximumObservedQueuedPayloadBytes: this.#maximumObservedQueuedPayloadBytes,
            retainedEvents: this.#events.length,
        });
    }

    /**
     * Appends an event and publishes it to attached subscribers.
     * @param data Event payload.
     * @returns The appended event record.
     */
    publish(data: QualificationEventData): QualificationEventRecord {
        const payloadBytes = encodedPayloadByteLength(data.payload ?? "");
        if (payloadBytes > qualificationEventLimits.maximumPayloadBytes) {
            throw new RangeError(payloadBudgetErrorMessage);
        }

        const eventData = Object.freeze({ ...data });
        const record = Object.freeze({
            data: eventData,
            id: String(++this.#sequence),
        } satisfies QualificationEventRecord);
        const event = Object.freeze({ payloadBytes, record });
        this.#events.push(event);
        if (this.#events.length > qualificationEventLimits.maximumRetainedEvents) {
            this.#events.shift();
        }
        for (const subscriber of this.#subscribers) {
            subscriber(event);
        }
        return record;
    }

    /**
     * Replays records after a cursor and then follows the live stream without a race gap.
     * @param options Resume cursor and request cancellation signal.
     * @yields {QualificationEventRecord} Ordered qualification events after the supplied
     * cursor.
     */
    async *subscribe(
        options: EventSubscriptionOptions
    ): AsyncGenerator<QualificationEventRecord> {
        const afterSequence = parseResumeSequence(options.afterId);
        this.observedResumeIds.push(options.afterId);
        const replayBoundary = this.#sequence;

        if (afterSequence > replayBoundary) {
            throw new Error("Qualification event resume cursor is ahead of feed tail");
        }

        const firstRetainedSequence = Number(
            this.#events.at(0)?.record.id ?? this.#sequence + 1
        );
        if (afterSequence > 0 && afterSequence < firstRetainedSequence - 1) {
            throw new Error("Qualification event resume cursor is outside retention");
        }

        const replayEvents = [...this.#events];
        const queue = new BoundedAsyncQueue<QualificationEventRecord>();
        const subscriber = (event: StoredQualificationEvent): void => {
            if (Number(event.record.id) <= replayBoundary) {
                return;
            }

            const result = queue.push(event.record, event.payloadBytes);
            if (!result.accepted) {
                this.#droppedSlowSubscribers += 1;
                this.#subscribers.delete(subscriber);
                return;
            }
            this.#maximumObservedQueueDepth = Math.max(
                this.#maximumObservedQueueDepth,
                result.queuedEventCount
            );
            this.#maximumObservedQueuedPayloadBytes = Math.max(
                this.#maximumObservedQueuedPayloadBytes,
                result.queuedPayloadBytes
            );
        };
        const abort = (): void => {
            this.#subscribers.delete(subscriber);
            queue.close();
        };

        this.#subscribers.add(subscriber);
        options.signal.addEventListener("abort", abort, { once: true });

        try {
            for (const event of replayEvents) {
                if (options.signal.aborted) {
                    return;
                }
                const sequence = Number(event.record.id);
                if (sequence > afterSequence && sequence <= replayBoundary) {
                    yield event.record;
                }
            }

            while (!options.signal.aborted) {
                const next = await queue.next();
                if (next.done) {
                    break;
                }
                yield next.value;
            }
        } finally {
            options.signal.removeEventListener("abort", abort);
            this.#subscribers.delete(subscriber);
            queue.close();
        }
    }
}

function encodedPayloadByteLength(payload: string): number {
    return payloadEncoder.encode(payload).byteLength;
}

function parseResumeSequence(resumeId: string | undefined): number {
    if (resumeId === undefined) {
        return 0;
    }

    const sequence = Number(resumeId);
    if (
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        String(sequence) !== resumeId
    ) {
        throw new Error("Qualification event resume cursor is invalid");
    }
    return sequence;
}
