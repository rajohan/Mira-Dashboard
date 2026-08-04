import * as v from "valibot";

import { BoundedAsyncQueue } from "../../src/server/platform/realtime/boundedAsyncQueue.ts";
import { utf8ByteLength } from "../../src/shared/encoding.ts";
import { nonnegativeDecimalSafeIntegerStringSchema } from "../../src/shared/validation.ts";

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

const maximumQualificationPayloadBytes = 8 * 1024;
const maximumQualificationSubscriberQueueEvents = 16;

/** Fixed event and subscriber budgets used by the qualification feed. */
export const qualificationEventLimits = Object.freeze({
    maximumPayloadBytes: maximumQualificationPayloadBytes,
    maximumRetainedEvents: 128,
    maximumSubscriberQueueEvents: maximumQualificationSubscriberQueueEvents,
    maximumSubscriberQueuedPayloadBytes:
        maximumQualificationSubscriberQueueEvents * maximumQualificationPayloadBytes,
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

interface StoredQualificationEvent {
    readonly payloadBytes: number;
    readonly record: QualificationEventRecord;
}

const queueBudgetErrorMessage =
    "Qualification event subscriber exceeded its queue budget";
const payloadBudgetErrorMessage = `Qualification event payload exceeds ${qualificationEventLimits.maximumPayloadBytes} UTF-8 bytes`;

/**
 * Checks an event payload against the shared UTF-8 byte budget.
 * @param payload Payload text to measure.
 * @returns Whether the encoded payload fits within the event budget.
 */
export function isQualificationEventPayloadWithinLimit(payload: string): boolean {
    return utf8ByteLength(payload) <= qualificationEventLimits.maximumPayloadBytes;
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
        const payloadBytes = utf8ByteLength(data.payload ?? "");
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
        const queue = new BoundedAsyncQueue<QualificationEventRecord>({
            maximumEvents: qualificationEventLimits.maximumSubscriberQueueEvents,
            maximumPayloadBytes:
                qualificationEventLimits.maximumSubscriberQueuedPayloadBytes,
            overflowErrorMessage: queueBudgetErrorMessage,
        });
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

const resumeSequenceSchema = nonnegativeDecimalSafeIntegerStringSchema(
    "Qualification event resume cursor is invalid"
);

function parseResumeSequence(resumeId: string | undefined): number {
    if (resumeId === undefined) {
        return 0;
    }

    const result = v.safeParse(resumeSequenceSchema, resumeId, { abortEarly: true });
    if (!result.success) {
        throw new Error("Qualification event resume cursor is invalid");
    }
    return result.output;
}
