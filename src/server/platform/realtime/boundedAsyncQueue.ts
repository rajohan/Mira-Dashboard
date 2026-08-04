interface PendingRead<T> {
    reject: (reason: Error) => void;
    resolve: (result: IteratorResult<T>) => void;
}

interface QueuedValue<T> {
    readonly payloadBytes: number;
    readonly value: T;
}

export interface BoundedAsyncQueueLimits {
    readonly maximumEvents: number;
    readonly maximumPayloadBytes: number;
    readonly overflowErrorMessage: string;
}

export interface BoundedAsyncQueuePushResult {
    readonly accepted: boolean;
    readonly queuedEventCount: number;
    readonly queuedPayloadBytes: number;
}

function positiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}

/**
 * Abort-friendly async queue with explicit event-count and UTF-8 payload-byte budgets.
 * The implementation is shared by the qualified SSE feed and the durable production pump.
 */
export class BoundedAsyncQueue<T> {
    readonly #limits: BoundedAsyncQueueLimits;
    readonly #pendingReads: PendingRead<T>[] = [];
    readonly #values: QueuedValue<T>[] = [];
    #closed = false;
    #failure: Error | undefined;
    #queuedPayloadBytes = 0;

    constructor(limits: BoundedAsyncQueueLimits) {
        this.#limits = Object.freeze({
            maximumEvents: positiveSafeInteger(
                limits.maximumEvents,
                "Bounded async queue maximum events"
            ),
            maximumPayloadBytes: positiveSafeInteger(
                limits.maximumPayloadBytes,
                "Bounded async queue maximum payload bytes"
            ),
            overflowErrorMessage: limits.overflowErrorMessage,
        });
    }

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

    push(value: T, payloadBytes: number): BoundedAsyncQueuePushResult {
        if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
            throw new RangeError(
                "Bounded async queue payload bytes must be a nonnegative safe integer"
            );
        }
        if (this.#closed) {
            return this.#pushResult(false);
        }

        const pendingRead = this.#pendingReads.shift();
        if (pendingRead) {
            pendingRead.resolve({ done: false, value });
            return this.#pushResult(true);
        }

        if (
            this.#values.length >= this.#limits.maximumEvents ||
            this.#queuedPayloadBytes + payloadBytes > this.#limits.maximumPayloadBytes
        ) {
            this.fail(new Error(this.#limits.overflowErrorMessage));
            return this.#pushResult(false);
        }
        this.#values.push({ payloadBytes, value });
        this.#queuedPayloadBytes += payloadBytes;
        return this.#pushResult(true);
    }

    #pushResult(accepted: boolean): BoundedAsyncQueuePushResult {
        return {
            accepted,
            queuedEventCount: this.#values.length,
            queuedPayloadBytes: this.#queuedPayloadBytes,
        };
    }
}
