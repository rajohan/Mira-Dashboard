import { TRPCError } from "@trpc/server";

import type { RealtimeEventStreamError } from "../../platform/realtime/eventPumpService.ts";
import type { RenewableStreamLeaseError } from "../../platform/realtime/renewableStreamLease.ts";

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

/**
 * Maps bounded lease infrastructure failures without exposing internals.
 * @param error Renewable lease failure crossing the stream boundary.
 * @returns A redacted service-unavailable transport error.
 */
export function renewableStreamLeaseErrorToTRPCError(
    error: RenewableStreamLeaseError
): TRPCError {
    switch (error._tag) {
        case "RenewableStreamLeaseInvalidError":
        case "RenewableStreamLeaseTimeoutError": {
            return new TRPCError({
                code: "SERVICE_UNAVAILABLE",
                message: "Realtime authentication is temporarily unavailable",
            });
        }
    }
}
