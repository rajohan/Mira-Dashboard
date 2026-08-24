import { initTRPC, tracked } from "@trpc/server";
import * as v from "valibot";

import { readRuntimeIdentity } from "../../runtime/runtimeCandidate.ts";
import {
    isIntegrationEventPayloadWithinLimit,
    integrationEventLimits,
    type IntegrationEventFeed,
} from "../realtime/eventFeed.ts";

const eventPayloadSchema = v.pipe(
    v.string(),
    v.check(
        isIntegrationEventPayloadWithinLimit,
        `Integration event payload must not exceed ${integrationEventLimits.maximumPayloadBytes} UTF-8 bytes`
    )
);

const eventDataSchema = v.strictObject({
    kind: v.literal("integration.changed"),
    payload: v.optional(eventPayloadSchema),
    value: v.number(),
});

const eventRecordSchema = v.strictObject({
    data: eventDataSchema,
    id: v.string(),
});

const eventStreamInputSchema = v.strictObject({
    lastEventId: v.optional(v.string()),
});

const runtimeIdentitySchema = v.strictObject({
    hasGlobalEventSource: v.boolean(),
    releaseId: v.string(),
    revision: v.string(),
    version: v.string(),
});

/** Dependencies available to integration procedures. */
export interface IntegrationContext {
    eventFeed: IntegrationEventFeed;
    releaseId: string;
}

/** Stream timing used by one integration router instance. */
export interface IntegrationRouterOptions {
    maximumStreamDurationMs?: number;
}

/**
 * Creates a tRPC router with either forced or production-style stream duration.
 * @param options Stream timing used by the bounded integration scenario.
 * @returns A router with a stable client contract.
 */
export function createIntegrationRouter(options: IntegrationRouterOptions) {
    const trpc = initTRPC.context<IntegrationContext>().create({
        sse: {
            ...(options.maximumStreamDurationMs === undefined
                ? {}
                : { maxDurationMs: options.maximumStreamDurationMs }),
            ping: {
                enabled: true,
                intervalMs: 100,
            },
        },
    });
    const publicProcedure = trpc.procedure;

    return trpc.router({
        events: trpc.router({
            publish: publicProcedure
                .input(eventDataSchema)
                .output(eventRecordSchema)
                .mutation(({ ctx, input }) => ctx.eventFeed.publish(input)),
            stream: publicProcedure
                .input(eventStreamInputSchema)
                .subscription(async function* ({ ctx, input, signal }) {
                    if (!signal) {
                        throw new Error(
                            "tRPC SSE request did not provide an abort signal"
                        );
                    }
                    for await (const event of ctx.eventFeed.subscribe({
                        afterId: input.lastEventId,
                        signal,
                    })) {
                        yield tracked(event.id, v.parse(eventDataSchema, event.data));
                    }
                }),
        }),
        runtime: trpc.router({
            identity: publicProcedure.output(runtimeIdentitySchema).query(({ ctx }) => ({
                ...readRuntimeIdentity(),
                releaseId: ctx.releaseId,
            })),
        }),
    });
}

/** Type-only API contract consumed by the integration client. */
export type IntegrationRouter = ReturnType<typeof createIntegrationRouter>;
