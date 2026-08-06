import * as v from "valibot";

const identifierSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/u));
export const sqliteOutboxMaximumBatchSize = 1000;
export const sqliteOutboxMaximumDrainNonemptyPolls = 1000;
const batchCountSchema = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(sqliteOutboxMaximumBatchSize)
);
const drainCountSchema = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(sqliteOutboxMaximumBatchSize * sqliteOutboxMaximumDrainNonemptyPolls)
);
const eventIdSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

export const sqliteOutboxChildStatusSchema = v.variant("kind", [
    v.strictObject({
        count: batchCountSchema,
        eventIds: v.array(eventIdSchema),
        kind: v.literal("produced"),
        producerId: identifierSchema,
    }),
    v.strictObject({
        eventIds: v.array(eventIdSchema),
        kind: v.literal("claimed"),
        workerId: identifierSchema,
    }),
    v.strictObject({
        claimedCount: drainCountSchema,
        deliveredCount: drainCountSchema,
        kind: v.literal("drained"),
        workerId: identifierSchema,
    }),
]);

export type SqliteOutboxChildStatus = v.InferOutput<typeof sqliteOutboxChildStatusSchema>;

/**
 * Parses one bounded status file emitted by a qualification child.
 * @param value Parsed JSON value.
 * @returns Strictly validated child status.
 */
export function parseSqliteOutboxChildStatus(value: unknown): SqliteOutboxChildStatus {
    return v.parse(sqliteOutboxChildStatusSchema, value);
}
