import * as v from "valibot";

import {
    nonnegativeSafeIntegerSchema,
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";

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
    readonly failure?: Error;
    readonly queuedEventCount: number;
    readonly queuedPayloadBytes: number;
}

/** Terminal error raised when a bounded queue rejects a value at its budget. */
export class BoundedAsyncQueueOverflowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BoundedAsyncQueueOverflowError";
    }
}

const boundedAsyncQueueLimitsSchema = v.strictObject({
    maximumEvents: positiveSafeIntegerSchema(
        "Bounded async queue maximum events must be a positive safe integer"
    ),
    maximumPayloadBytes: positiveSafeIntegerSchema(
        "Bounded async queue maximum payload bytes must be a positive safe integer"
    ),
    overflowErrorMessage: v.string(
        "Bounded async queue overflow error message must be a string"
    ),
});

const payloadBytesSchema = nonnegativeSafeIntegerSchema(
    "Bounded async queue payload bytes must be a nonnegative safe integer"
);

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
        this.#limits = Object.freeze(
            parseSchemaWithRangeError(boundedAsyncQueueLimitsSchema, limits)
        );
    }

    /**
     * Terminates immediately, discarding buffered values and resolving pending reads as done.
     * This is not a graceful drain.
     */
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
        const validatedPayloadBytes = parseSchemaWithRangeError(
            payloadBytesSchema,
            payloadBytes
        );
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
            validatedPayloadBytes >
                this.#limits.maximumPayloadBytes - this.#queuedPayloadBytes
        ) {
            this.fail(
                new BoundedAsyncQueueOverflowError(this.#limits.overflowErrorMessage)
            );
            return this.#pushResult(false);
        }
        this.#values.push({ payloadBytes: validatedPayloadBytes, value });
        this.#queuedPayloadBytes += validatedPayloadBytes;
        return this.#pushResult(true);
    }

    #pushResult(accepted: boolean): BoundedAsyncQueuePushResult {
        return {
            accepted,
            ...(this.#failure === undefined ? {} : { failure: this.#failure }),
            queuedEventCount: this.#values.length,
            queuedPayloadBytes: this.#queuedPayloadBytes,
        };
    }
}
