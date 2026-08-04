import { initTRPC, tracked } from "@trpc/server";
import * as v from "valibot";

import type { QualificationEventFeed } from "../realtime/eventFeed.ts";
import { readRuntimeIdentity } from "../runtimeCandidate.ts";

const eventDataSchema = v.object({
    kind: v.literal("qualification.changed"),
    value: v.number(),
});

const eventRecordSchema = v.object({
    data: eventDataSchema,
    id: v.string(),
});

const eventStreamInputSchema = v.object({
    lastEventId: v.optional(v.string()),
});

const runtimeIdentitySchema = v.object({
    hasGlobalEventSource: v.boolean(),
    releaseId: v.string(),
    revision: v.string(),
    version: v.string(),
});

/** Dependencies available to qualification procedures. */
export interface QualificationContext {
    eventFeed: QualificationEventFeed;
    releaseId: string;
}

/** Stream timing used by one qualification router instance. */
export interface QualificationRouterOptions {
    maximumStreamDurationMs?: number;
}

/**
 * Creates a tRPC router with either forced or production-style stream duration.
 * @param options Stream timing used by the qualification case.
 * @returns A router with a stable client contract.
 */
export function createQualificationRouter(options: QualificationRouterOptions) {
    const trpc = initTRPC.context<QualificationContext>().create({
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

/** Type-only API contract consumed by the qualification client. */
export type QualificationRouter = ReturnType<typeof createQualificationRouter>;
