import { minutesToMilliseconds, secondsToMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    realtimeEventDeliveryMaximumBytes,
    realtimeTopicSchema,
} from "../../../contracts/realtime.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    nonnegativeDecimalSafeIntegerStringSchema,
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import {
    realtimeEventStoreLimits,
    type RealtimeCursorBounds,
    type RealtimeEventStore,
    type StoredRealtimeEvent,
} from "./eventStore.ts";

const defaultMaximumSubscriberQueueEvents = 16;

export const realtimeEventPumpDefaults = Object.freeze({
    activePollIntervalMs: 250,
    idlePollIntervalMs: secondsToMilliseconds(5),
    maximumEventDeliveryBytes: realtimeEventDeliveryMaximumBytes,
    maximumPageEvents: 16,
    maximumRetryablePollRetries: 3,
    maximumSubscribers: 128,
    maximumSubscriberQueueEvents: defaultMaximumSubscriberQueueEvents,
    maximumSubscriberQueuedDeliveryBytes:
        defaultMaximumSubscriberQueueEvents * realtimeEventDeliveryMaximumBytes,
    retainedEventCountSampleIntervalMs: minutesToMilliseconds(1),
    retryablePollBaseDelayMs: 25,
    retryablePollMaximumDelayMs: 250,
});

export interface RealtimeChangeEvent {
    readonly entityId: string;
    readonly entityType: string;
    readonly occurredAtMs: number;
    readonly operation: StoredRealtimeEvent["operation"];
    readonly payloadJson: string;
    readonly topic: string;
}

export interface RealtimeChangeDelivery {
    readonly event: RealtimeChangeEvent;
    readonly id: string;
    readonly kind: "change";
}

export interface RealtimeResyncRequiredDelivery {
    readonly id: string;
    readonly kind: "resync-required";
    readonly reason: "cursor-outside-retention";
}

export type RealtimeEventDelivery =
    | RealtimeChangeDelivery
    | RealtimeResyncRequiredDelivery;

export interface RealtimeEventSubscriptionOptions {
    readonly afterId: string;
    readonly signal: AbortSignal;
    readonly topics?: readonly string[];
}

export type RealtimeEventSubscriptionStoreRead = <A>(
    read: () => A,
    signal: AbortSignal
) => Promise<A>;

export interface RealtimeEventPumpMetrics {
    readonly activeSubscribers: number;
    readonly deliveryPreparationFailures: number;
    readonly droppedSlowSubscribers: number;
    readonly forcedResyncs: number;
    readonly latestIssuedId: number;
    readonly maximumCatchUpBatchSize: number;
    readonly maximumObservedQueueDepth: number;
    readonly maximumObservedQueuedDeliveryBytes: number;
    readonly newestRetainedId: number | null;
    readonly oldestRequiredCursor: number | null;
    readonly oldestRetainedId: number | null;
    readonly pollFailures: number;
    readonly polls: number;
    readonly retainedEventsSample: RealtimeRetainedEventsSample | null;
    readonly retryablePollRetries: number;
    readonly retryableSubscriptionReadRetries: number;
    readonly subscriptionReadFailures: number;
    readonly subscriberCapacityRejections: number;
    readonly topicFilteredDeliveries: number;
    readonly wakeups: number;
}

export interface RealtimeRetainedEventsSample {
    readonly count: number;
    readonly sampledAtMs: number;
}

export interface RealtimeEventPumpOptions {
    readonly maximumEventDeliveryBytes?: number;
    readonly maximumPageEvents?: number;
    readonly maximumSubscribers?: number;
    readonly maximumSubscriberQueueEvents?: number;
    readonly maximumSubscriberQueuedDeliveryBytes?: number;
    readonly nowMs?: () => number;
    readonly readSubscriptionStore?: RealtimeEventSubscriptionStoreRead;
    readonly requestPoll?: () => void;
    readonly retainedEventCountSampleIntervalMs?: number;
    readonly store: RealtimeEventStore;
}

export type RealtimeEventPollPlan = "active" | "idle" | "immediate";

export type RealtimeCursorErrorCode = "ahead-of-tail" | "invalid";
export type RealtimeSubscriptionInputErrorCode = "capacity-exceeded" | "invalid-topics";

/** Error for a malformed or impossible resume cursor supplied by a caller. */
export class RealtimeCursorError extends Error {
    readonly code: RealtimeCursorErrorCode;

    constructor(code: RealtimeCursorErrorCode, message: string) {
        super(message);
        this.name = "RealtimeCursorError";
        this.code = code;
    }
}

/** Error for invalid subscription filters or exhausted process-local capacity. */
export class RealtimeSubscriptionInputError extends Error {
    readonly code: RealtimeSubscriptionInputErrorCode;

    constructor(code: RealtimeSubscriptionInputErrorCode, message: string) {
        super(message);
        this.name = "RealtimeSubscriptionInputError";
        this.code = code;
    }
}

export class RealtimeResyncSignal extends Error {
    readonly tailId: number;

    constructor(tailId: number) {
        super("Realtime cursor moved outside retention while subscribed");
        this.name = "RealtimeResyncSignal";
        this.tailId = tailId;
    }
}

const maximumTopicsPerSubscription = realtimeEventStoreLimits.maximumTopicsPerPage;

const resumeCursorSchema = nonnegativeDecimalSafeIntegerStringSchema(
    "Realtime resume cursor is invalid"
);

const subscriptionTopicsSchema = v.pipe(
    v.array(realtimeTopicSchema, "Realtime subscription topics are invalid"),
    v.minLength(1, "Realtime subscription topic count is outside its budget"),
    v.maxLength(
        maximumTopicsPerSubscription,
        "Realtime subscription topic count is outside its budget"
    ),
    v.transform((topics) => new Set(topics))
);

const maximumPageEventsSchema = v.pipe(
    positiveSafeIntegerSchema(
        "Realtime maximum page events must be a positive safe integer"
    ),
    v.maxValue(
        realtimeEventStoreLimits.maximumPageEvents,
        "Realtime maximum page events exceeds the store budget"
    )
);

const maximumEventDeliveryBytesSchema = v.pipe(
    positiveSafeIntegerSchema(
        "Realtime maximum event delivery bytes must be a positive safe integer"
    ),
    v.maxValue(
        realtimeEventDeliveryMaximumBytes,
        "Realtime maximum event delivery bytes exceeds the durable wire budget"
    )
);

const realtimeEventPumpLimitsSchema = v.pipe(
    v.strictObject({
        maximumEventDeliveryBytes: maximumEventDeliveryBytesSchema,
        maximumPageEvents: maximumPageEventsSchema,
        maximumSubscribers: positiveSafeIntegerSchema(
            "Realtime maximum subscribers must be a positive safe integer"
        ),
        maximumSubscriberQueueEvents: positiveSafeIntegerSchema(
            "Realtime maximum subscriber queue events must be a positive safe integer"
        ),
        maximumSubscriberQueuedDeliveryBytes: positiveSafeIntegerSchema(
            "Realtime maximum subscriber queued delivery bytes must be a positive safe integer"
        ),
        retainedEventCountSampleIntervalMs: positiveSafeIntegerSchema(
            "Realtime retained event count sample interval must be a positive safe integer"
        ),
    }),
    v.check(
        (limits) => limits.maximumSubscriberQueueEvents >= limits.maximumPageEvents,
        "Realtime subscriber queue event budget cannot hold one synchronous page"
    ),
    v.check((limits) => {
        return (
            limits.maximumEventDeliveryBytes <=
            Math.floor(
                limits.maximumSubscriberQueuedDeliveryBytes / limits.maximumPageEvents
            )
        );
    }, "Realtime subscriber queue byte budget cannot hold one synchronous page"),
    v.readonly()
);

const realtimeEventPumpClockSchema = timestampMillisecondsSchema(
    "Realtime event pump clock must return valid Date milliseconds"
);

export type RealtimeEventPumpLimits = v.InferOutput<typeof realtimeEventPumpLimitsSchema>;

export const subscriberQueueOverflowMessage =
    "Realtime event subscriber exceeded its queue budget";

export function errorFromUnknown(error: unknown, fallbackMessage: string): Error {
    return error instanceof Error ? error : new Error(fallbackMessage, { cause: error });
}

export function parseResumeCursor(value: string): number {
    const result = v.safeParse(resumeCursorSchema, value, { abortEarly: true });
    if (!result.success) {
        throw new RealtimeCursorError("invalid", "Realtime resume cursor is invalid");
    }
    return result.output;
}

export function cursorIsOutsideRetention(
    cursor: number,
    window: RealtimeCursorBounds
): boolean {
    if (cursor >= window.latestIssuedId) {
        return false;
    }
    if (window.oldestRetainedId === null) {
        return true;
    }
    return cursor < window.oldestRetainedId - 1;
}

export function normalizeTopics(
    topics: readonly string[] | undefined
): ReadonlySet<string> | undefined {
    if (topics === undefined) {
        return undefined;
    }
    const result = v.safeParse(subscriptionTopicsSchema, topics, {
        abortEarly: true,
    });
    if (!result.success) {
        throw new RealtimeSubscriptionInputError(
            "invalid-topics",
            result.issues[0]?.message ?? "Realtime subscription topics are invalid"
        );
    }
    return result.output;
}

export function parseRealtimeEventPumpLimits(
    options: RealtimeEventPumpOptions
): RealtimeEventPumpLimits {
    return parseSchemaWithRangeError(realtimeEventPumpLimitsSchema, {
        maximumEventDeliveryBytes:
            options.maximumEventDeliveryBytes ??
            realtimeEventPumpDefaults.maximumEventDeliveryBytes,
        maximumPageEvents:
            options.maximumPageEvents ?? realtimeEventPumpDefaults.maximumPageEvents,
        maximumSubscribers:
            options.maximumSubscribers ?? realtimeEventPumpDefaults.maximumSubscribers,
        maximumSubscriberQueueEvents:
            options.maximumSubscriberQueueEvents ??
            realtimeEventPumpDefaults.maximumSubscriberQueueEvents,
        maximumSubscriberQueuedDeliveryBytes:
            options.maximumSubscriberQueuedDeliveryBytes ??
            realtimeEventPumpDefaults.maximumSubscriberQueuedDeliveryBytes,
        retainedEventCountSampleIntervalMs:
            options.retainedEventCountSampleIntervalMs ??
            realtimeEventPumpDefaults.retainedEventCountSampleIntervalMs,
    });
}

export function parseRealtimeEventPumpClock(value: number): number {
    return parseSchemaWithRangeError(realtimeEventPumpClockSchema, value);
}

export function resyncRequiredDelivery(tailId: number): RealtimeResyncRequiredDelivery {
    return Object.freeze({
        id: String(tailId),
        kind: "resync-required",
        reason: "cursor-outside-retention",
    });
}
