import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { realtimeEvents } from "../schema/realtime.ts";
import { validJsonTextAction } from "./scalars.ts";

const realtimeEventRefinements = {
    id: (schema: GetValibotTypeFromColumn<typeof realtimeEvents.id>) =>
        v.pipe(schema, v.safeInteger(), v.minValue(1)),
    payloadJson: (schema: v.StringSchema<undefined>) =>
        v.pipe(schema, validJsonTextAction),
};

const generatedRealtimeEventSelectSchema = createSelectSchema(
    realtimeEvents,
    realtimeEventRefinements
);

/** Validates immutable realtime event rows read from SQLite. */
export const realtimeEventSelectSchema = v.strictObject(
    generatedRealtimeEventSelectSchema.entries
);

const generatedRealtimeEventInsertSchema = v.omit(
    createInsertSchema(realtimeEvents, realtimeEventRefinements),
    ["id"]
);

/** Validates values before an immutable realtime event insert. */
export const realtimeEventInsertSchema = v.strictObject(
    generatedRealtimeEventInsertSchema.entries
);
