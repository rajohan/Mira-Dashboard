import { and, asc, getTableName, gt, inArray, lte, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    realtimeTopicMaximumCharacters,
    realtimeTopicSchema,
} from "../../../contracts/realtime.ts";
import {
    nonnegativeSafeIntegerSchema,
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import {
    realtimeCursorBoundsSchema,
    realtimeCursorWindowSchema,
    realtimeEventSelectSchema,
} from "../../database/validation/realtimeEvents.ts";

export type StoredRealtimeEvent = v.InferOutput<typeof realtimeEventSelectSchema>;
export type RealtimeCursorBounds = v.InferOutput<typeof realtimeCursorBoundsSchema>;
export type RealtimeCursorWindow = v.InferOutput<typeof realtimeCursorWindowSchema>;

export interface RealtimeEventBatch {
    readonly bounds: RealtimeCursorBounds;
    readonly events: readonly StoredRealtimeEvent[];
}

export const realtimeEventStoreLimits = Object.freeze({
    maximumPageEvents: 256,
    maximumTopicCharacters: realtimeTopicMaximumCharacters,
    maximumTopicsPerPage: 64,
});

const realtimePageCursorSchema = nonnegativeSafeIntegerSchema(
    "Realtime page cursor must be a nonnegative safe integer"
);

const realtimePageLimitSchema = v.pipe(
    positiveSafeIntegerSchema("Realtime page limit must be a positive safe integer"),
    v.maxValue(
        realtimeEventStoreLimits.maximumPageEvents,
        "Realtime page limit exceeds its store budget"
    )
);

const realtimePageBoundarySchema = nonnegativeSafeIntegerSchema(
    "Realtime page boundary must be a nonnegative safe integer"
);

const realtimePageTopicsSchema = v.pipe(
    v.array(realtimeTopicSchema, "Realtime page topics must be an array"),
    v.minLength(1, "Realtime page topics cannot be empty"),
    v.maxLength(
        realtimeEventStoreLimits.maximumTopicsPerPage,
        "Realtime page topic count exceeds its store budget"
    ),
    v.readonly()
);

const realtimeEventPageOptionsObjectSchema = v.strictObject(
    {
        afterId: realtimePageCursorSchema,
        limit: realtimePageLimitSchema,
        throughId: v.optional(realtimePageBoundarySchema),
        topics: v.optional(realtimePageTopicsSchema),
    },
    "Realtime page options are invalid"
);

const realtimeEventPageOptionsSchema = v.pipe(
    realtimeEventPageOptionsObjectSchema,
    v.check(
        (options) =>
            options.throughId === undefined || options.throughId >= options.afterId,
        "Realtime page boundary cannot precede its cursor"
    ),
    v.readonly()
);

export type RealtimeEventPageOptions = v.InferOutput<
    typeof realtimeEventPageOptionsSchema
>;

export interface RealtimeEventStore {
    /** Reads cursor bounds and page rows from the same SQLite read snapshot. */
    readBatch(options: RealtimeEventPageOptions): RealtimeEventBatch;
    /**
     * Reads cursor bounds atomically in one SQL statement. Unlike readBatch, it does
     * not share a snapshot with a separate page read.
     */
    readCursorBounds(): RealtimeCursorBounds;
    /**
     * Reads cursor bounds and the retained count atomically in one SQL statement.
     * It does not share a snapshot with a separate page read.
     */
    readCursorWindow(): RealtimeCursorWindow;
}

function parsePageOptions(options: RealtimeEventPageOptions): RealtimeEventPageOptions {
    return parseSchemaWithRangeError(realtimeEventPageOptionsSchema, options);
}

const realtimeEventsTableName = getTableName(realtimeEvents);
const latestIssuedIdSql = sql`
    COALESCE(
        (SELECT seq FROM sqlite_sequence WHERE name = ${realtimeEventsTableName}),
        (SELECT MAX(${realtimeEvents.id}) FROM ${realtimeEvents}),
        0
    )
`;

function queryCursorBounds(database: SQLiteBunDatabase): RealtimeCursorBounds {
    const rows = database.all<unknown>(sql`
        SELECT
            ${latestIssuedIdSql} AS latestIssuedId,
            (SELECT MAX(${realtimeEvents.id}) FROM ${realtimeEvents}) AS newestRetainedId,
            (SELECT MIN(${realtimeEvents.id}) FROM ${realtimeEvents}) AS oldestRetainedId
    `);
    return Object.freeze(v.parse(realtimeCursorBoundsSchema, rows[0]));
}

function queryCursorWindow(database: SQLiteBunDatabase): RealtimeCursorWindow {
    const rows = database.all<unknown>(sql`
        SELECT
            ${latestIssuedIdSql} AS latestIssuedId,
            (SELECT MAX(${realtimeEvents.id}) FROM ${realtimeEvents}) AS newestRetainedId,
            (SELECT MIN(${realtimeEvents.id}) FROM ${realtimeEvents}) AS oldestRetainedId,
            (SELECT COUNT(*) FROM ${realtimeEvents}) AS retainedEvents
    `);
    return Object.freeze(v.parse(realtimeCursorWindowSchema, rows[0]));
}

function queryPage(
    database: SQLiteBunDatabase,
    options: RealtimeEventPageOptions
): readonly StoredRealtimeEvent[] {
    const rows = database
        .select()
        .from(realtimeEvents)
        .where(
            and(
                gt(realtimeEvents.id, options.afterId),
                options.throughId === undefined
                    ? undefined
                    : lte(realtimeEvents.id, options.throughId),
                options.topics === undefined
                    ? undefined
                    : inArray(realtimeEvents.topic, [...options.topics])
            )
        )
        .orderBy(asc(realtimeEvents.id))
        .limit(options.limit)
        .all();

    let previousId = options.afterId;
    const validated = rows.map((row) => {
        const event = v.parse(realtimeEventSelectSchema, row);
        if (
            event.id <= previousId ||
            (options.throughId !== undefined && event.id > options.throughId)
        ) {
            throw new Error("Realtime page query returned events out of bounds");
        }
        previousId = event.id;
        return Object.freeze(event);
    });
    return Object.freeze(validated);
}

/**
 * Creates the SQLite outbox reader used by the durable event pump.
 * Cursor bounds include SQLite's AUTOINCREMENT high-water mark so a completely pruned
 * journal still reports that historical IDs once existed.
 * @returns A validated, bounded reader over the durable outbox.
 */
export function createRealtimeEventStore(
    database: SQLiteBunDatabase
): RealtimeEventStore {
    // The concrete Bun driver is synchronous, but Drizzle retains a conditional async
    // transaction signature. Keep the no-Promise read snapshot explicit at this boundary.
    const runReadTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: SQLiteBunDatabase) => T,
        config: { behavior: "deferred" }
    ) => T;

    return {
        readBatch(options: RealtimeEventPageOptions): RealtimeEventBatch {
            const validatedOptions = parsePageOptions(options);
            return runReadTransaction(
                (transaction) => {
                    const bounds = queryCursorBounds(transaction);
                    return Object.freeze({
                        bounds,
                        events: queryPage(transaction, validatedOptions),
                    });
                },
                { behavior: "deferred" }
            );
        },

        readCursorBounds(): RealtimeCursorBounds {
            return queryCursorBounds(database);
        },

        readCursorWindow(): RealtimeCursorWindow {
            return queryCursorWindow(database);
        },
    };
}
