import { expect, test } from "bun:test";

import { addMinutes, toDate } from "date-fns";
import * as v from "valibot";

import {
    realtimeEventInsertSchema,
    realtimeEventSelectSchema,
} from "./realtimeEvents.ts";

const baseEvent = {
    entityId: "entity-1",
    entityType: "test-entity",
    expiresAt: addMinutes(1000, 1),
    occurredAt: toDate(1000),
    operation: "updated" as const,
    payloadJson: "{}",
    topic: "topic.a",
};

test("enforces the same canonical topic at storage and transport boundaries", () => {
    for (const topic of [" topic.a", "topic.a ", "t".repeat(129)]) {
        expect(() => v.parse(realtimeEventInsertSchema, { ...baseEvent, topic })).toThrow(
            "Realtime topic is invalid"
        );
        expect(() =>
            v.parse(realtimeEventSelectSchema, { ...baseEvent, id: 1, topic })
        ).toThrow("Realtime topic is invalid");
    }
});

test("rejects producer inserts that cannot fit the default delivery envelope", () => {
    const payloadJson = JSON.stringify({ value: "x".repeat(8192) });

    expect(() =>
        v.parse(realtimeEventInsertSchema, { ...baseEvent, payloadJson })
    ).toThrow("Realtime event delivery exceeds");
    expect(
        v.parse(realtimeEventSelectSchema, { ...baseEvent, id: 1, payloadJson })
    ).toBeDefined();
});

test("rejects realtime rows that do not expire after they occur", () => {
    for (const expiresAt of [baseEvent.occurredAt, toDate(0)]) {
        expect(() =>
            v.parse(realtimeEventInsertSchema, { ...baseEvent, expiresAt })
        ).toThrow("Expected realtime event expiresAt to be after occurredAt");
        expect(() =>
            v.parse(realtimeEventSelectSchema, { ...baseEvent, expiresAt, id: 1 })
        ).toThrow("Expected realtime event expiresAt to be after occurredAt");
    }
});

test("rejects realtime timestamps before the Unix epoch", () => {
    const occurredAt = toDate(-1);
    const expiresAt = toDate(0);

    expect(() =>
        v.parse(realtimeEventInsertSchema, { ...baseEvent, expiresAt, occurredAt })
    ).toThrow();
    expect(() =>
        v.parse(realtimeEventSelectSchema, {
            ...baseEvent,
            expiresAt,
            id: 1,
            occurredAt,
        })
    ).toThrow();
});
