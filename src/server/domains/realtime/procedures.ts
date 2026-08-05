import { tracked } from "@trpc/server";

import { eventsStreamContract } from "../../../contracts/events.ts";
import { isRealtimeEventStreamError } from "../../platform/realtime/eventPumpService.ts";
import { authenticatedProcedure, router } from "../../trpc/trpc.ts";
import { realtimeEventStreamErrorToTRPCError } from "./errors.ts";
import { authorizeRealtimeTopics, realtimeDeliveryToStreamOutput } from "./transport.ts";

/** Authenticated tracked-SSE procedures for durable application events. */
export const eventsRouter = router({
    stream: authenticatedProcedure
        .input(eventsStreamContract.input)
        .subscription(async function* ({ ctx, input, signal }) {
            if (signal === undefined) {
                throw new Error("tRPC SSE request did not provide an abort signal");
            }
            const topics = authorizeRealtimeTopics(ctx.principal, input.topics);

            try {
                const deliveries = await ctx.services.realtimeEvents.stream({
                    afterId: input.lastEventId,
                    signal,
                    topics,
                });
                for await (const delivery of deliveries) {
                    const output = realtimeDeliveryToStreamOutput(delivery);
                    yield tracked(output.id, output.data);
                }
            } catch (error) {
                if (isRealtimeEventStreamError(error)) {
                    throw realtimeEventStreamErrorToTRPCError(error);
                }
                throw error;
            }
        }),
});
