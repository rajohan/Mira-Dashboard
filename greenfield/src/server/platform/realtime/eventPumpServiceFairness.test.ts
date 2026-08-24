import { expect, test } from "bun:test";

import { secondsToMilliseconds } from "date-fns";
import { Effect, Fiber, Stream } from "effect";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { RealtimeEventPump } from "./eventPump.ts";
import { realtimeEventPumpLayer, RealtimeEventPumpService } from "./eventPumpService.ts";
import { createRealtimeEventStore } from "./eventStore.ts";
import { insertEvent } from "./testSupport/eventPump.ts";

test("yields between immediate pages so an active consumer can drain its queue", async () => {
    const database = await openFreshMigratedDatabase();
    const layer = realtimeEventPumpLayer({
        makePump: (runtime) =>
            new RealtimeEventPump({
                ...runtime,
                maximumPageEvents: 16,
                maximumSubscriberQueueEvents: 16,
                store: createRealtimeEventStore(database.orm),
            }),
    });

    try {
        const program = RealtimeEventPumpService.use((service) =>
            Effect.gen(function* () {
                const consumer = yield* service
                    .stream({ afterId: "0" })
                    .pipe(Stream.take(33), Stream.runCollect, Effect.forkChild);
                while ((yield* service.metricsSnapshot).activeSubscribers !== 1) {
                    yield* Effect.yieldNow;
                }

                yield* Effect.sync(() => {
                    for (let id = 1; id <= 33; id += 1) {
                        insertEvent(database, {
                            occurredAtMs: secondsToMilliseconds(id),
                        });
                    }
                });
                yield* service.wake;
                const deliveries = yield* Fiber.join(consumer);
                const metrics = yield* service.metricsSnapshot;
                return { deliveries: [...deliveries], metrics };
            })
        );

        const result = await Effect.runPromise(Effect.provide(program, layer));
        expect(result.deliveries.map((delivery) => delivery.id)).toEqual(
            Array.from({ length: 33 }, (_, index) => String(index + 1))
        );
        expect(result.metrics).toMatchObject({
            droppedSlowSubscribers: 0,
            maximumCatchUpBatchSize: 16,
        });
    } finally {
        database.sqlite.close(true);
    }
}, 5000);
