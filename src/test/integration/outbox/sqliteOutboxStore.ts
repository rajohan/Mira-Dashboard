import { Database } from "bun:sqlite";

import { Data, Duration, Effect, Predicate, Schedule } from "effect";
import * as v from "valibot";

const outboxSchemaStatements = [
    `CREATE TABLE integration_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        payload TEXT NOT NULL,
        producer_id TEXT NOT NULL,
        producer_sequence INTEGER NOT NULL,
        UNIQUE (producer_id, producer_sequence)
    ) STRICT`,
    `CREATE TABLE integration_outbox_events (
        claim_owner TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        lease_until INTEGER,
        record_id INTEGER NOT NULL UNIQUE
            REFERENCES integration_records(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending',
        CONSTRAINT integration_outbox_state_check CHECK (
            (state = 'pending' AND claim_owner IS NULL AND lease_until IS NULL AND delivered_at IS NULL)
            OR (state = 'claimed' AND claim_owner IS NOT NULL AND lease_until IS NOT NULL AND delivered_at IS NULL)
            OR (state = 'delivered' AND claim_owner IS NULL AND lease_until IS NULL AND delivered_at IS NOT NULL)
        )
    ) STRICT`,
    `CREATE INDEX integration_outbox_claim_idx
        ON integration_outbox_events (state, lease_until, id)`,
    `CREATE TABLE integration_outbox_deliveries (
        delivered_at INTEGER NOT NULL,
        event_id INTEGER NOT NULL UNIQUE
            REFERENCES integration_outbox_events(id) ON DELETE RESTRICT,
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        worker_id TEXT NOT NULL
    ) STRICT`,
] as const;

const sqliteErrorSchema = v.object({
    code: v.pipe(v.string(), v.startsWith("SQLITE_")),
});

const integrationCountStatements = Object.freeze({
    integration_outbox_deliveries:
        "SELECT count(*) AS count FROM integration_outbox_deliveries",
    integration_outbox_events: "SELECT count(*) AS count FROM integration_outbox_events",
    integration_records: "SELECT count(*) AS count FROM integration_records",
});

export type IntegrationTableName = keyof typeof integrationCountStatements;

export class IntegrationSqliteContentionError extends Data.TaggedError(
    "IntegrationSqliteContentionError"
)<{
    readonly cause: unknown;
    readonly code: string;
}> {}

export class IntegrationSqliteUnavailableError extends Data.TaggedError(
    "IntegrationSqliteUnavailableError"
)<{
    readonly cause: unknown;
    readonly code: string;
}> {}

export type IntegrationSqliteOperationError =
    | IntegrationSqliteContentionError
    | IntegrationSqliteUnavailableError;

export interface AppendedOutboxBatch {
    readonly eventIds: readonly number[];
    readonly producerId: string;
}

export interface IntegrationOutboxSnapshot {
    readonly claimedCount: number;
    readonly deliveredCount: number;
    readonly deliveredEventIds: readonly number[];
    readonly eventCount: number;
    readonly eventIds: readonly number[];
    readonly pendingCount: number;
    readonly producerSequences: readonly string[];
}

interface CountRow {
    count: number;
}

interface IdRow {
    id: number;
}

interface JournalModeRow {
    journal_mode: string;
}

interface OutboxStateCountRow {
    count: number;
    state: "claimed" | "delivered" | "pending";
}

interface ProducerSequenceRow {
    producerId: string;
    producerSequence: number;
}

interface DeliveryLatencyRow {
    latencyMs: number;
}

function sqliteErrorCode(error: unknown): string | undefined {
    const result = v.safeParse(sqliteErrorSchema, error);
    return result.success ? result.output.code : undefined;
}

function isContentionCode(code: string): boolean {
    return (
        code === "SQLITE_BUSY" ||
        code.startsWith("SQLITE_BUSY_") ||
        code === "SQLITE_LOCKED" ||
        code.startsWith("SQLITE_LOCKED_")
    );
}

/**
 * Converts Bun SQLite failures into stable integration failure tags.
 * @param error Unknown thrown value.
 * @returns A classified SQLite failure, or undefined for non-SQLite defects.
 */
export function classifyIntegrationSqliteError(
    error: unknown
): IntegrationSqliteOperationError | undefined {
    const code = sqliteErrorCode(error);
    if (code === undefined) return undefined;
    return isContentionCode(code)
        ? new IntegrationSqliteContentionError({ cause: error, code })
        : new IntegrationSqliteUnavailableError({ cause: error, code });
}

const isContentionError = Predicate.isTagged("IntegrationSqliteContentionError");

const contentionRetrySchedule = Schedule.exponential(Duration.millis(1)).pipe(
    Schedule.modifyDelay(({ duration }) => {
        const boundedDelayMs = Math.min(Duration.toMillis(duration), 10);
        return Effect.succeed(Duration.millis(boundedDelayMs));
    }),
    Schedule.upTo({ times: 40 }),
    Schedule.while(({ input }) => isContentionError(input))
);

/**
 * Runs one synchronous SQLite operation with bounded Effect-owned contention retries.
 * The transaction callback supplied by callers remains synchronous.
 * @param operation Synchronous SQLite operation.
 * @returns An Effect with bounded contention retries and tagged expected failures.
 */
export function retryIntegrationSqliteOperation<A>(
    operation: () => A
): Effect.Effect<A, IntegrationSqliteOperationError> {
    const attempt = Effect.suspend(() => {
        try {
            return Effect.succeed(operation());
        } catch (error) {
            const failure = classifyIntegrationSqliteError(error);
            return failure === undefined ? Effect.die(error) : Effect.fail(failure);
        }
    });
    return attempt.pipe(Effect.retry({ schedule: contentionRetrySchedule }));
}

/**
 * Opens one strict file-backed integration connection.
 * @param databasePath Absolute temporary database path.
 * @param options Connection access mode.
 * @returns The opened Bun SQLite connection.
 */
export function openIntegrationOutboxDatabase(
    databasePath: string,
    options: { readonly?: boolean } = {}
): Database {
    const database = new Database(databasePath, {
        create: options.readonly !== true,
        readonly: options.readonly === true,
        readwrite: options.readonly !== true,
        strict: true,
    });
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA busy_timeout = 0");
    return database;
}

/**
 * Initializes the deterministic WAL-backed outbox fixture.
 * @param database Writable integration database.
 */
export function initializeIntegrationOutboxDatabase(database: Database): void {
    const journalMode = database
        .query<JournalModeRow, []>("PRAGMA journal_mode = WAL")
        .get()?.journal_mode;
    if (journalMode?.toLowerCase() !== "wal") {
        throw new Error("Integration database did not enter WAL mode");
    }
    database.run("PRAGMA synchronous = NORMAL");
    for (const statement of outboxSchemaStatements) database.run(statement);
}

/**
 * Returns the connection-visible journal mode.
 * @param database Open integration database.
 * @returns Lowercase SQLite journal mode.
 */
export function readIntegrationJournalMode(database: Database): string {
    const row = database.query<JournalModeRow, []>("PRAGMA journal_mode").get();
    if (row === null) throw new Error("SQLite returned no journal mode");
    return row.journal_mode.toLowerCase();
}

/**
 * Appends domain rows and their outbox events in one synchronous immediate transaction.
 * @param database Writable integration database.
 * @param producerId Stable child producer identifier.
 * @param count Number of records and events to append.
 * @param createdAt Deterministic logical creation timestamp.
 * @returns Inserted event identifiers.
 */
export function appendIntegrationOutboxBatch(
    database: Database,
    producerId: string,
    count: number,
    createdAt: number
): AppendedOutboxBatch {
    const insertRecord = database.prepare<never, [string, number, string]>(
        `INSERT INTO integration_records (producer_id, producer_sequence, payload)
         VALUES (?, ?, ?)`
    );
    const insertEvent = database.prepare<never, [number, number]>(
        `INSERT INTO integration_outbox_events (record_id, created_at)
         VALUES (?, ?)`
    );
    try {
        const eventIds = database
            .transaction(() => {
                const insertedEventIds: number[] = [];
                for (let sequence = 1; sequence <= count; sequence += 1) {
                    const record = insertRecord.run(
                        producerId,
                        sequence,
                        JSON.stringify({ producerId, sequence })
                    );
                    const outbox = insertEvent.run(
                        Number(record.lastInsertRowid),
                        createdAt
                    );
                    insertedEventIds.push(Number(outbox.lastInsertRowid));
                }
                return insertedEventIds;
            })
            .immediate();
        return Object.freeze({ eventIds: Object.freeze(eventIds), producerId });
    } finally {
        insertEvent.finalize();
        insertRecord.finalize();
    }
}

/**
 * Claims one ordered batch, including claims whose logical lease expired.
 * @param database Writable integration database.
 * @param workerId Stable worker identifier.
 * @param now Deterministic logical claim timestamp.
 * @param leaseUntil Deterministic logical lease expiry.
 * @param limit Maximum events to claim.
 * @returns Ordered claimed event identifiers.
 */
export function claimIntegrationOutboxBatch(
    database: Database,
    workerId: string,
    now: number,
    leaseUntil: number,
    limit: number
): readonly number[] {
    const select = database.prepare<IdRow, [number, number]>(
        `SELECT id
         FROM integration_outbox_events
         WHERE state = 'pending'
            OR (state = 'claimed' AND lease_until <= ?)
         ORDER BY id
         LIMIT ?`
    );
    const update = database.prepare<never, [string, number, number, number]>(
        `UPDATE integration_outbox_events
         SET state = 'claimed', claim_owner = ?, lease_until = ?
         WHERE id = ?
           AND (state = 'pending' OR (state = 'claimed' AND lease_until <= ?))`
    );
    try {
        const claimed = database
            .transaction(() => {
                const ids = select.all(now, limit).map((row) => row.id);
                for (const id of ids) {
                    const result = update.run(workerId, leaseUntil, id, now);
                    if (result.changes !== 1) {
                        throw new Error(
                            "Outbox claim changed unexpectedly inside its transaction"
                        );
                    }
                }
                return ids;
            })
            .immediate();
        return Object.freeze(claimed);
    } finally {
        update.finalize();
        select.finalize();
    }
}

/**
 * Persists exactly-once delivery evidence and terminal event state atomically.
 * @param database Writable integration database.
 * @param workerId Claim owner and delivery worker.
 * @param deliveredAt Deterministic logical delivery timestamp.
 * @returns Ordered delivered event identifiers.
 */
export function deliverIntegrationOutboxClaims(
    database: Database,
    workerId: string,
    deliveredAt: number
): readonly number[] {
    const select = database.prepare<IdRow, [string]>(
        `SELECT id
         FROM integration_outbox_events
         WHERE state = 'claimed' AND claim_owner = ?
         ORDER BY id`
    );
    const insertDelivery = database.prepare<never, [number, string, number]>(
        `INSERT INTO integration_outbox_deliveries (event_id, worker_id, delivered_at)
         VALUES (?, ?, ?)`
    );
    const markDelivered = database.prepare<never, [number, number, string]>(
        `UPDATE integration_outbox_events
         SET state = 'delivered', claim_owner = NULL, lease_until = NULL, delivered_at = ?
         WHERE id = ? AND state = 'claimed' AND claim_owner = ?`
    );
    try {
        const delivered = database
            .transaction(() => {
                const ids = select.all(workerId).map((row) => row.id);
                for (const id of ids) {
                    insertDelivery.run(id, workerId, deliveredAt);
                    const result = markDelivered.run(deliveredAt, id, workerId);
                    if (result.changes !== 1) {
                        throw new Error(
                            "Outbox delivery changed unexpectedly inside its transaction"
                        );
                    }
                }
                return ids;
            })
            .immediate();
        return Object.freeze(delivered);
    } finally {
        markDelivered.finalize();
        insertDelivery.finalize();
        select.finalize();
    }
}

/**
 * Captures all deterministic event and delivery invariants for assertions/evidence.
 * @param database Open integration database.
 * @returns Immutable state snapshot.
 */
export function readIntegrationOutboxSnapshot(
    database: Database
): IntegrationOutboxSnapshot {
    const eventIds = database
        .query<IdRow, []>("SELECT id FROM integration_outbox_events ORDER BY id")
        .all()
        .map((row) => row.id);
    const deliveredEventIds = database
        .query<IdRow, []>(
            "SELECT event_id AS id FROM integration_outbox_deliveries ORDER BY event_id"
        )
        .all()
        .map((row) => row.id);
    const stateCounts = new Map(
        database
            .query<OutboxStateCountRow, []>(
                `SELECT state, count(*) AS count
                 FROM integration_outbox_events
                 GROUP BY state`
            )
            .all()
            .map((row) => [row.state, row.count] as const)
    );
    const producerSequences = database
        .query<ProducerSequenceRow, []>(
            `SELECT producer_id AS producerId, producer_sequence AS producerSequence
             FROM integration_records
             ORDER BY producer_id, producer_sequence`
        )
        .all()
        .map((row) => `${row.producerId}:${row.producerSequence}`);

    return Object.freeze({
        claimedCount: stateCounts.get("claimed") ?? 0,
        deliveredCount: stateCounts.get("delivered") ?? 0,
        deliveredEventIds: Object.freeze(deliveredEventIds),
        eventCount: eventIds.length,
        eventIds: Object.freeze(eventIds),
        pendingCount: stateCounts.get("pending") ?? 0,
        producerSequences: Object.freeze(producerSequences),
    });
}

/**
 * Reads deterministic logical delivery latencies for later percentile evidence.
 * @param database Open integration database.
 * @returns Logical event delivery latencies in event order.
 */
export function readIntegrationDeliveryLatencies(database: Database): readonly number[] {
    return Object.freeze(
        database
            .query<DeliveryLatencyRow, []>(
                `SELECT events.delivered_at - events.created_at AS latencyMs
                 FROM integration_outbox_events AS events
                 WHERE events.state = 'delivered'
                 ORDER BY events.id`
            )
            .all()
            .map((row) => row.latencyMs)
    );
}

/**
 * Returns SQLite's full integrity result.
 * @param database Open integration database.
 * @returns SQLite integrity-check response.
 */
export function readIntegrationIntegrityCheck(database: Database): string {
    const row = database
        .query<{ integrityCheck: string }, []>(
            "SELECT integrity_check AS integrityCheck FROM pragma_integrity_check"
        )
        .get();
    if (row === null) throw new Error("SQLite returned no integrity result");
    return row.integrityCheck;
}

/**
 * Creates a consistent standalone backup after explicitly checkpointing WAL.
 * @param database Writable integration database.
 * @param backupPath New standalone backup path.
 */
export function createIntegrationOutboxBackup(
    database: Database,
    backupPath: string
): void {
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const backup = database.prepare<never, [string]>("VACUUM INTO ?");
    try {
        backup.run(backupPath);
    } finally {
        backup.finalize();
    }
}

/**
 * Counts one allowlisted table without exposing a cached prepared statement.
 * @param database Open integration database.
 * @param tableName Allowlisted integration table.
 * @returns Table row count.
 */
export function countIntegrationRows(
    database: Database,
    tableName: IntegrationTableName
): number {
    const row = database.query<CountRow, []>(integrationCountStatements[tableName]).get();
    if (row === null) throw new Error("SQLite returned no count");
    return row.count;
}
