/** Data carried by the qualification event stream. */
export interface QualificationEventData {
    kind: "qualification.changed";
    value: number;
}

/** A durable-style event record with a monotonically increasing string ID. */
export interface QualificationEventRecord {
    data: QualificationEventData;
    id: string;
}

interface EventSubscriptionOptions {
    afterId?: string;
    signal: AbortSignal;
}

interface PendingRead<T> {
    reject: (reason: Error) => void;
    resolve: (result: IteratorResult<T>) => void;
}

const maximumSubscriberQueueSize = 16;
const maximumRetainedEvents = 128;

class BoundedAsyncQueue<T> {
    readonly #pendingReads: PendingRead<T>[] = [];
    readonly #values: T[] = [];
    #closed = false;
    #failure: Error | undefined;

    close(): void {
        this.#closed = true;
        for (const pendingRead of this.#pendingReads.splice(0)) {
            pendingRead.resolve({ done: true, value: undefined });
        }
    }

    fail(error: Error): void {
        this.#closed = true;
        this.#failure = error;
        this.#values.length = 0;
        for (const pendingRead of this.#pendingReads.splice(0)) {
            pendingRead.reject(error);
        }
    }

    next(): Promise<IteratorResult<T>> {
        if (this.#failure) {
            return Promise.reject(this.#failure);
        }
        const value = this.#values.shift();
        if (value !== undefined) {
            return Promise.resolve({ done: false, value });
        }
        if (this.#closed) {
            return Promise.resolve({ done: true, value: undefined });
        }

        return new Promise<IteratorResult<T>>((resolve, reject) => {
            this.#pendingReads.push({ reject, resolve });
        });
    }

    push(value: T): boolean {
        if (this.#closed) {
            return false;
        }

        const pendingRead = this.#pendingReads.shift();
        if (pendingRead) {
            pendingRead.resolve({ done: false, value });
            return true;
        }

        if (this.#values.length >= maximumSubscriberQueueSize) {
            this.fail(
                new Error("Qualification event subscriber exceeded its queue budget")
            );
            return false;
        }
        this.#values.push(value);
        return true;
    }
}

/** In-memory qualification model for tracked replay and bounded live delivery. */
export class QualificationEventFeed {
    readonly #events: QualificationEventRecord[] = [];
    readonly #subscribers = new Set<(event: QualificationEventRecord) => void>();
    readonly observedResumeIds: Array<string | undefined> = [];
    #sequence = 0;

    /**
     * Number of currently attached live subscribers.
     * @returns Current live subscriber count.
     */
    get activeSubscriberCount(): number {
        return this.#subscribers.size;
    }

    /**
     * Appends an event and publishes it to attached subscribers.
     * @param data Event payload.
     * @returns The appended event record.
     */
    publish(data: QualificationEventData): QualificationEventRecord {
        const event = {
            data,
            id: String(++this.#sequence),
        } satisfies QualificationEventRecord;
        this.#events.push(event);
        if (this.#events.length > maximumRetainedEvents) {
            this.#events.shift();
        }
        for (const subscriber of this.#subscribers) {
            subscriber(event);
        }
        return event;
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
            this.#events.at(0)?.id ?? this.#sequence + 1
        );
        if (afterSequence > 0 && afterSequence < firstRetainedSequence - 1) {
            throw new Error("Qualification event resume cursor is outside retention");
        }

        const replayEvents = [...this.#events];
        const queue = new BoundedAsyncQueue<QualificationEventRecord>();
        const subscriber = (event: QualificationEventRecord): void => {
            if (Number(event.id) > replayBoundary && !queue.push(event)) {
                this.#subscribers.delete(subscriber);
            }
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
                const sequence = Number(event.id);
                if (sequence > afterSequence && sequence <= replayBoundary) {
                    yield event;
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
