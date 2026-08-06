import { tracked } from "@trpc/server";

import { eventsStreamContract } from "../../../contracts/events.ts";
import { isRealtimeEventStreamError } from "../../platform/realtime/eventPumpService.ts";
import { isRenewableStreamLeaseError } from "../../platform/realtime/renewableStreamLease.ts";
import { authenticatedProcedure, router } from "../../trpc/trpc.ts";
import { createRealtimeAuthenticationLease } from "./authenticationLeaseStream.ts";
import {
    realtimeEventStreamErrorToTRPCError,
    renewableStreamLeaseErrorToTRPCError,
} from "./errors.ts";
import { realtimeDeliveryToStreamOutput } from "./transport.ts";

const eventsRoutes = {
    stream: authenticatedProcedure
        .input(eventsStreamContract.input)
        .subscription(async function* ({ ctx, input, signal }) {
            if (signal === undefined) {
                throw new Error("tRPC SSE request did not provide an abort signal");
            }

            try {
                const lease = createRealtimeAuthenticationLease({
                    lease: ctx.authenticationLease,
                    principal: ctx.principal,
                    topics: input.topics,
                });
                const deliveries = await ctx.services.realtimeEvents.stream(
                    {
                        afterId: input.lastEventId,
                        signal,
                        topics: input.topics,
                    },
                    lease
                );
                for await (const delivery of deliveries) {
                    const output = realtimeDeliveryToStreamOutput(delivery);
                    yield tracked(output.id, output.data);
                }
            } catch (error) {
                if (isRealtimeEventStreamError(error)) {
                    throw realtimeEventStreamErrorToTRPCError(error);
                }
                if (isRenewableStreamLeaseError(error)) {
                    throw renewableStreamLeaseErrorToTRPCError(error);
                }
                throw error;
            }
        }),
};

/** Leaf procedure names owned by the realtime-router composition. */
export const eventsProcedureNames = Object.freeze(Object.keys(eventsRoutes));

/** Authenticated tracked-SSE procedures for durable application events. */
export const eventsRouter = router(eventsRoutes);
