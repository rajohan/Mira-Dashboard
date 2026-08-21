import { Schema } from "effect";

import type {
    RealtimeCursorErrorCode,
    RealtimeSubscriptionInputErrorCode,
} from "./eventPumpContract.ts";

const TaggedErrorClass = Schema.TaggedError;

export class RealtimeEventCursorStreamError extends TaggedErrorClass<RealtimeEventCursorStreamError>(
    "mira-dashboard/server/platform/realtime/RealtimeEventCursorStreamError"
)("RealtimeEventCursorStreamError", {
    code: Schema.Literals([
        "ahead-of-tail",
        "invalid",
    ] satisfies readonly RealtimeCursorErrorCode[]),
    message: Schema.String,
}) {}

export class RealtimeEventStoreStreamError extends TaggedErrorClass<RealtimeEventStoreStreamError>(
    "mira-dashboard/server/platform/realtime/RealtimeEventStoreStreamError"
)("RealtimeEventStoreStreamError", {
    message: Schema.String,
}) {}

export class RealtimeEventSlowConsumerStreamError extends TaggedErrorClass<RealtimeEventSlowConsumerStreamError>(
    "mira-dashboard/server/platform/realtime/RealtimeEventSlowConsumerStreamError"
)("RealtimeEventSlowConsumerStreamError", {
    message: Schema.String,
}) {}

export class RealtimeEventSubscriptionStreamError extends TaggedErrorClass<RealtimeEventSubscriptionStreamError>(
    "mira-dashboard/server/platform/realtime/RealtimeEventSubscriptionStreamError"
)("RealtimeEventSubscriptionStreamError", {
    code: Schema.Literals([
        "capacity-exceeded",
        "invalid-topics",
    ] satisfies readonly RealtimeSubscriptionInputErrorCode[]),
    message: Schema.String,
}) {}

const realtimeEventStreamErrorSchema = Schema.Union([
    RealtimeEventCursorStreamError,
    RealtimeEventSlowConsumerStreamError,
    RealtimeEventStoreStreamError,
    RealtimeEventSubscriptionStreamError,
]);

/** Runtime guard for typed failures crossing the Effect/async-iterator boundary. */
export const isRealtimeEventStreamError = Schema.is(realtimeEventStreamErrorSchema);

export type RealtimeEventStreamError =
    | RealtimeEventCursorStreamError
    | RealtimeEventSlowConsumerStreamError
    | RealtimeEventStoreStreamError
    | RealtimeEventSubscriptionStreamError;
