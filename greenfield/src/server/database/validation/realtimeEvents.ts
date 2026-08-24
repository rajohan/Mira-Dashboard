import { compareAsc, getTime } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    realtimeChangeDeliveryByteLength,
    realtimeEventDeliveryMaximumBytes,
    realtimeTopicSchema,
} from "../../../contracts/realtime.ts";
import {
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { realtimeEvents } from "../schema/realtime.ts";
import { nonnegativeDateSchema, validJsonTextAction } from "./scalars.ts";

const realtimeEventRefinements = {
    expiresAt: nonnegativeDateSchema,
    id: (schema: GetValibotTypeFromColumn<typeof realtimeEvents.id>) =>
        v.pipe(schema, v.safeInteger(), v.minValue(1)),
    payloadJson: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, validJsonTextAction),
    occurredAt: nonnegativeDateSchema,
    topic: () => realtimeTopicSchema,
};

const realtimeEventDeliveryBudgetError = `Realtime event delivery exceeds ${realtimeEventDeliveryMaximumBytes} UTF-8 bytes`;

function realtimeEventExpiryOrderIsValid(event: {
    readonly expiresAt: Date;
    readonly occurredAt: Date;
}): boolean {
    return compareAsc(event.expiresAt, event.occurredAt) > 0;
}

function eventDeliveryFitsDurableBudget(event: {
    entityId: string;
    entityType: string;
    id: number;
    occurredAt: Date;
    operation: "created" | "deleted" | "snapshot-required" | "updated";
    payloadJson: string;
    topic: string;
}): boolean {
    return (
        realtimeChangeDeliveryByteLength({
            event: {
                entityId: event.entityId,
                entityType: event.entityType,
                occurredAtMs: getTime(event.occurredAt),
                operation: event.operation,
                payloadJson: event.payloadJson,
                topic: event.topic,
            },
            id: String(event.id),
            kind: "change",
        }) <= realtimeEventDeliveryMaximumBytes
    );
}

const cursorBoundsEntries = {
    latestIssuedId: nonnegativeSafeIntegerSchema(
        "Realtime latest issued id must be a nonnegative safe integer"
    ),
    newestRetainedId: v.nullable(
        positiveSafeIntegerSchema(
            "Realtime newest retained id must be a positive safe integer"
        )
    ),
    oldestRetainedId: v.nullable(
        positiveSafeIntegerSchema(
            "Realtime oldest retained id must be a positive safe integer"
        )
    ),
};

const cursorBoundsObjectSchema = v.strictObject(
    cursorBoundsEntries,
    "Realtime cursor-bounds query returned an invalid row"
);

function cursorBoundsAreConsistent(
    bounds: v.InferOutput<typeof cursorBoundsObjectSchema>
): boolean {
    const { latestIssuedId, newestRetainedId, oldestRetainedId } = bounds;
    return (
        (oldestRetainedId === null) === (newestRetainedId === null) &&
        (oldestRetainedId === null ||
            newestRetainedId === null ||
            (oldestRetainedId <= newestRetainedId && newestRetainedId <= latestIssuedId))
    );
}

/** Validates the aggregate cursor bounds returned by a raw SQLite query. */
export const realtimeCursorBoundsSchema = v.pipe(
    cursorBoundsObjectSchema,
    v.check(cursorBoundsAreConsistent, "Realtime cursor bounds are inconsistent"),
    v.readonly()
);

const retainedEventCountSchema = nonnegativeSafeIntegerSchema(
    "Realtime retained event count must be a nonnegative safe integer"
);

const cursorWindowObjectSchema = v.strictObject(
    {
        ...cursorBoundsEntries,
        retainedEvents: retainedEventCountSchema,
    },
    "Realtime cursor-window query returned an invalid row"
);

/** Validates aggregate cursor bounds and retained count returned by SQLite. */
export const realtimeCursorWindowSchema = v.pipe(
    cursorWindowObjectSchema,
    v.check(
        (window) => cursorBoundsAreConsistent(window),
        "Realtime cursor bounds are inconsistent"
    ),
    v.check(
        (window) => (window.retainedEvents === 0) === (window.oldestRetainedId === null),
        "Realtime cursor-window aggregates are inconsistent"
    ),
    v.check(
        (window) =>
            window.oldestRetainedId === null ||
            window.newestRetainedId === null ||
            window.retainedEvents <=
                window.newestRetainedId - window.oldestRetainedId + 1,
        "Realtime cursor-window retained count exceeds its id span"
    ),
    v.readonly()
);

const generatedRealtimeEventSelectSchema = createSelectSchema(
    realtimeEvents,
    realtimeEventRefinements
);

/** Validates immutable realtime event rows read from SQLite. */
export const realtimeEventSelectSchema = v.pipe(
    v.strictObject(generatedRealtimeEventSelectSchema.entries),
    v.check(
        (event) => realtimeEventExpiryOrderIsValid(event),
        "Expected realtime event expiresAt to be after occurredAt."
    )
);

const generatedRealtimeEventInsertSchema = v.omit(
    createInsertSchema(realtimeEvents, realtimeEventRefinements),
    ["id"]
);

/** Validates values before an immutable realtime event insert. */
export const realtimeEventInsertSchema = v.pipe(
    v.strictObject(generatedRealtimeEventInsertSchema.entries),
    v.check(
        (event) => realtimeEventExpiryOrderIsValid(event),
        "Expected realtime event expiresAt to be after occurredAt."
    ),
    v.check(
        (event) =>
            eventDeliveryFitsDurableBudget({
                ...event,
                id: Number.MAX_SAFE_INTEGER,
            }),
        realtimeEventDeliveryBudgetError
    )
);
