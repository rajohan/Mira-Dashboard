import { TRPCError } from "@trpc/server";

import type { RealtimeEventStreamError } from "../../platform/realtime/eventPumpService.ts";

function subscriptionError(
    error: Extract<
        RealtimeEventStreamError,
        { readonly _tag: "RealtimeEventSubscriptionStreamError" }
    >
): TRPCError {
    return error.code === "capacity-exceeded"
        ? new TRPCError({
              code: "TOO_MANY_REQUESTS",
              message: "Realtime subscriber capacity is exhausted",
          })
        : new TRPCError({
              code: "BAD_REQUEST",
              message: "Realtime subscription topics are invalid",
          });
}

/**
 * Exhaustively maps expected event-pump failures to stable, safe tRPC errors.
 * Unknown defects never enter this function and remain redacted internal errors.
 * @param error Typed stream failure from the Effect service.
 * @returns Safe transport error.
 */
export function realtimeEventStreamErrorToTRPCError(
    error: RealtimeEventStreamError
): TRPCError {
    switch (error._tag) {
        case "RealtimeEventCursorStreamError": {
            return new TRPCError({
                code: "BAD_REQUEST",
                message: "Realtime resume cursor is invalid",
            });
        }
        case "RealtimeEventSlowConsumerStreamError": {
            return new TRPCError({
                code: "TOO_MANY_REQUESTS",
                message: "Realtime subscriber is too slow",
            });
        }
        case "RealtimeEventStoreStreamError": {
            return new TRPCError({
                code: "SERVICE_UNAVAILABLE",
                message: "Realtime event store is temporarily unavailable",
            });
        }
        case "RealtimeEventSubscriptionStreamError": {
            return subscriptionError(error);
        }
    }
}
