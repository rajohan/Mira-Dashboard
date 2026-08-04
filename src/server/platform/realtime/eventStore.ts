import { and, asc, gt, inArray, lte, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import { realtimeEvents } from "../../database/schema/realtime.ts";
import { realtimeEventSelectSchema } from "../../database/validation/realtimeEvents.ts";

export type StoredRealtimeEvent = v.InferOutput<typeof realtimeEventSelectSchema>;

export interface RealtimeCursorBounds {
    readonly latestIssuedId: number;
    readonly newestRetainedId: number | null;
    readonly oldestRetainedId: number | null;
}

export interface RealtimeCursorWindow extends RealtimeCursorBounds {
    readonly retainedEvents: number;
}

export interface RealtimeEventPageOptions {
    readonly afterId: number;
    readonly limit: number;
    readonly throughId?: number;
    readonly topics?: readonly string[];
}

export interface RealtimeEventBatch {
    readonly bounds: RealtimeCursorBounds;
    readonly events: readonly StoredRealtimeEvent[];
}

export interface RealtimeEventStore {
    readBatch(options: RealtimeEventPageOptions): RealtimeEventBatch;
    readCursorBounds(): RealtimeCursorBounds;
    readCursorWindow(): RealtimeCursorWindow;
}

interface CursorWindowRow {
    latestIssuedId: number;
    newestRetainedId: number | null;
    oldestRetainedId: number | null;
    retainedEvents: number;
}

type CursorBoundsRow = Omit<CursorWindowRow, "retainedEvents">;

function nonnegativeSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a nonnegative safe integer`);
    }
    return value;
}

function positiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function nullablePositiveSafeInteger(value: number | null, name: string): number | null {
    if (value === null) {
        return null;
    }
    return positiveSafeInteger(value, name);
}

function validateCursorBounds(row: CursorBoundsRow | undefined): RealtimeCursorBounds {
    if (row === undefined) {
        throw new Error("Realtime cursor-bounds query returned no row");
    }

    const latestIssuedId = nonnegativeSafeInteger(
        row.latestIssuedId,
        "Realtime latest issued id"
    );
    const newestRetainedId = nullablePositiveSafeInteger(
        row.newestRetainedId,
        "Realtime newest retained id"
    );
    const oldestRetainedId = nullablePositiveSafeInteger(
        row.oldestRetainedId,
        "Realtime oldest retained id"
    );
    if (
        (oldestRetainedId === null) !== (newestRetainedId === null) ||
        (oldestRetainedId !== null && newestRetainedId !== null
            ? oldestRetainedId > newestRetainedId || newestRetainedId > latestIssuedId
            : false)
    ) {
        throw new Error("Realtime cursor bounds are inconsistent");
    }

    return Object.freeze({
        latestIssuedId,
        newestRetainedId,
        oldestRetainedId,
    });
}

function validateCursorWindow(row: CursorWindowRow | undefined): RealtimeCursorWindow {
    if (row === undefined) {
        throw new Error("Realtime cursor-window query returned no row");
    }
    const bounds = validateCursorBounds(row);
    const retainedEvents = nonnegativeSafeInteger(
        row.retainedEvents,
        "Realtime retained event count"
    );
    if ((retainedEvents === 0) !== (bounds.oldestRetainedId === null)) {
        throw new Error("Realtime cursor-window aggregates are inconsistent");
    }

    return Object.freeze({
        ...bounds,
        retainedEvents,
    });
}

function validatePageOptions(options: RealtimeEventPageOptions): void {
    nonnegativeSafeInteger(options.afterId, "Realtime page cursor");
    positiveSafeInteger(options.limit, "Realtime page limit");
    if (options.throughId !== undefined) {
        nonnegativeSafeInteger(options.throughId, "Realtime page boundary");
        if (options.throughId < options.afterId) {
            throw new RangeError("Realtime page boundary cannot precede its cursor");
        }
    }
    if (options.topics?.length === 0) {
        throw new RangeError("Realtime page topics cannot be empty");
    }
}

function queryCursorBounds(database: SQLiteBunDatabase): RealtimeCursorBounds {
    const rows = database.all<CursorBoundsRow>(sql`
        SELECT
            COALESCE(
                (SELECT seq FROM sqlite_sequence WHERE name = 'realtime_events'),
                (SELECT MAX(id) FROM realtime_events),
                0
            ) AS latestIssuedId,
            (SELECT MAX(id) FROM realtime_events) AS newestRetainedId,
            (SELECT MIN(id) FROM realtime_events) AS oldestRetainedId
    `);
    return validateCursorBounds(rows[0]);
}

function queryCursorWindow(database: SQLiteBunDatabase): RealtimeCursorWindow {
    const rows = database.all<CursorWindowRow>(sql`
        SELECT
            COALESCE(
                (SELECT seq FROM sqlite_sequence WHERE name = 'realtime_events'),
                (SELECT MAX(id) FROM realtime_events),
                0
            ) AS latestIssuedId,
            (SELECT MAX(id) FROM realtime_events) AS newestRetainedId,
            (SELECT MIN(id) FROM realtime_events) AS oldestRetainedId,
            (SELECT COUNT(*) FROM realtime_events) AS retainedEvents
    `);
    return validateCursorWindow(rows[0]);
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
            validatePageOptions(options);
            return runReadTransaction(
                (transaction) =>
                    Object.freeze({
                        bounds: queryCursorBounds(transaction),
                        events: queryPage(transaction, options),
                    }),
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
