import { describe, expect, test } from "bun:test";

import type { TRPCError } from "@trpc/server";

import {
    RealtimeEventCursorStreamError,
    RealtimeEventSlowConsumerStreamError,
    RealtimeEventStoreStreamError,
    RealtimeEventSubscriptionStreamError,
    type RealtimeEventStreamError,
} from "../../platform/realtime/eventPumpService.ts";
import {
    RenewableStreamLeaseInvalidError,
    RenewableStreamLeaseTimeoutError,
} from "../../platform/realtime/renewableStreamLease.ts";
import {
    realtimeEventStreamErrorToTRPCError,
    renewableStreamLeaseErrorToTRPCError,
} from "./errors.ts";

describe("realtime stream transport errors", () => {
    test.each<{
        expectedCode: TRPCError["code"];
        expectedMessage: string;
        streamError: RealtimeEventStreamError;
    }>([
        {
            expectedCode: "BAD_REQUEST",
            expectedMessage: "Realtime resume cursor is invalid",
            streamError: new RealtimeEventCursorStreamError({
                code: "invalid",
                message: "internal cursor detail",
            }),
        },
        {
            expectedCode: "BAD_REQUEST",
            expectedMessage: "Realtime resume cursor is invalid",
            streamError: new RealtimeEventCursorStreamError({
                code: "ahead-of-tail",
                message: "internal tail detail",
            }),
        },
        {
            expectedCode: "BAD_REQUEST",
            expectedMessage: "Realtime subscription topics are invalid",
            streamError: new RealtimeEventSubscriptionStreamError({
                code: "invalid-topics",
                message: "internal topic detail",
            }),
        },
        {
            expectedCode: "TOO_MANY_REQUESTS",
            expectedMessage: "Realtime subscriber capacity is exhausted",
            streamError: new RealtimeEventSubscriptionStreamError({
                code: "capacity-exceeded",
                message: "internal capacity detail",
            }),
        },
        {
            expectedCode: "TOO_MANY_REQUESTS",
            expectedMessage: "Realtime subscriber is too slow",
            streamError: new RealtimeEventSlowConsumerStreamError({
                message: "internal queue detail",
            }),
        },
        {
            expectedCode: "SERVICE_UNAVAILABLE",
            expectedMessage: "Realtime event store is temporarily unavailable",
            streamError: new RealtimeEventStoreStreamError({
                message: "internal store detail",
            }),
        },
    ])("maps $expectedCode without exposing internal details", (scenario) => {
        const error = realtimeEventStreamErrorToTRPCError(scenario.streamError);

        expect(error.code).toBe(scenario.expectedCode);
        expect(error.message).toBe(scenario.expectedMessage);
        expect(error.message).not.toContain("internal");
    });

    test.each([
        {
            leaseError: new RenewableStreamLeaseInvalidError({
                message: "internal invalid lease detail",
            }),
            name: "invalid lease",
        },
        {
            leaseError: new RenewableStreamLeaseTimeoutError({
                message: "internal renewal timeout detail",
            }),
            name: "renewal timeout",
        },
    ])("maps $name without exposing internal details", ({ leaseError }) => {
        const error = renewableStreamLeaseErrorToTRPCError(leaseError);

        expect(error.code).toBe("SERVICE_UNAVAILABLE");
        expect(error.message).toBe("Realtime authentication is temporarily unavailable");
        expect(error.message).not.toContain("internal");
    });
});
