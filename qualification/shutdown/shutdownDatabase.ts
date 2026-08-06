import { Database } from "bun:sqlite";

export interface ShutdownDatabaseSnapshot {
    readonly activeLeaseCount: number;
    readonly cleanGenerationCount: number;
    readonly generations: readonly number[];
    readonly integrityCheck: string;
    readonly journalMode: string;
    readonly releasedLeaseCount: number;
}

interface CountRow {
    count: number;
}

interface GenerationRow {
    generation: number;
}

interface IntegrityRow {
    integrity_check: string;
}

interface JournalModeRow {
    journal_mode: string;
}

interface WalCheckpointRow {
    busy: number;
    checkpointed: number;
    log: number;
}

const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS shutdown_generations (
        generation INTEGER PRIMARY KEY NOT NULL,
        process_id INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        state TEXT NOT NULL,
        CONSTRAINT shutdown_generation_state_check CHECK (
            (state = 'running' AND stopped_at IS NULL)
            OR (state = 'stopped' AND stopped_at IS NOT NULL)
        )
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS shutdown_worker_leases (
        generation INTEGER PRIMARY KEY NOT NULL
            REFERENCES shutdown_generations(generation) ON DELETE RESTRICT,
        owner_process_id INTEGER NOT NULL,
        released_at INTEGER
    ) STRICT`,
] as const;

export function openShutdownQualificationDatabase(databasePath: string): Database {
    const database = new Database(databasePath, {
        create: true,
        readwrite: true,
        strict: true,
    });
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA busy_timeout = 1000");
    const journalMode = database
        .query<JournalModeRow, []>("PRAGMA journal_mode = WAL")
        .get()?.journal_mode;
    if (journalMode?.toLowerCase() !== "wal") {
        database.close(true);
        throw new Error("Shutdown qualification database did not enter WAL mode");
    }
    database.run("PRAGMA synchronous = NORMAL");
    database.run("PRAGMA wal_autocheckpoint = 0");
    for (const statement of schemaStatements) database.run(statement);
    return database;
}

export function startShutdownGeneration(
    database: Database,
    generation: number,
    processId: number,
    timestamp: number
): number {
    return database
        .transaction(() => {
            const activeLeaseCount = database
                .query<CountRow, []>(
                    "SELECT count(*) AS count FROM shutdown_worker_leases WHERE released_at IS NULL"
                )
                .get()?.count;
            if (activeLeaseCount !== 0) {
                throw new Error("A prior shutdown qualification lease remains active");
            }
            const recoveredGenerationCount = database
                .query<CountRow, []>(
                    "SELECT count(*) AS count FROM shutdown_generations WHERE state = 'stopped'"
                )
                .get()?.count;
            if (recoveredGenerationCount === undefined) {
                throw new Error("Shutdown qualification generation count is unavailable");
            }
            database
                .query<never, [number, number, number]>(
                    `INSERT INTO shutdown_generations (
                        generation, process_id, started_at, state
                    ) VALUES (?, ?, ?, 'running')`
                )
                .run(generation, processId, timestamp);
            return recoveredGenerationCount;
        })
        .immediate();
}

export function acquireShutdownWorkerLease(
    database: Database,
    generation: number,
    processId: number
): void {
    database
        .query<never, [number, number]>(
            `INSERT INTO shutdown_worker_leases (
                generation, owner_process_id, released_at
            ) VALUES (?, ?, NULL)`
        )
        .run(generation, processId);
}

export function releaseShutdownWorkerLease(
    database: Database,
    generation: number,
    timestamp: number
): void {
    const result = database
        .query<never, [number, number]>(
            `UPDATE shutdown_worker_leases
             SET released_at = ?
             WHERE generation = ? AND released_at IS NULL`
        )
        .run(timestamp, generation);
    if (result.changes !== 1) {
        throw new Error("Shutdown qualification worker lease was not released once");
    }
}

export function completeShutdownGeneration(
    database: Database,
    generation: number,
    timestamp: number
): void {
    database
        .transaction(() => {
            const activeLeaseCount = database
                .query<CountRow, [number]>(
                    `SELECT count(*) AS count
                     FROM shutdown_worker_leases
                     WHERE generation = ? AND released_at IS NULL`
                )
                .get(generation)?.count;
            if (activeLeaseCount !== 0) {
                throw new Error("Shutdown generation completed with an active lease");
            }
            const result = database
                .query<never, [number, number]>(
                    `UPDATE shutdown_generations
                     SET state = 'stopped', stopped_at = ?
                     WHERE generation = ? AND state = 'running'`
                )
                .run(timestamp, generation);
            if (result.changes !== 1) {
                throw new Error("Shutdown generation was not completed once");
            }
        })
        .immediate();
    const checkpoint = database
        .query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(RESTART)")
        .get();
    if (
        checkpoint === null ||
        checkpoint.busy !== 0 ||
        checkpoint.checkpointed !== checkpoint.log
    ) {
        throw new Error("Shutdown qualification WAL checkpoint did not complete");
    }
}

export function readShutdownDatabaseSnapshot(
    database: Database
): ShutdownDatabaseSnapshot {
    const count = (sql: string) => {
        const value = database.query<CountRow, []>(sql).get()?.count;
        if (value === undefined) throw new Error("Shutdown database count is missing");
        return value;
    };
    const integrityCheck = database
        .query<IntegrityRow, []>("PRAGMA integrity_check")
        .get()?.integrity_check;
    const journalMode = database
        .query<JournalModeRow, []>("PRAGMA journal_mode")
        .get()?.journal_mode;
    if (integrityCheck === undefined || journalMode === undefined) {
        throw new Error("Shutdown database metadata is missing");
    }
    const generations = database
        .query<GenerationRow, []>(
            "SELECT generation FROM shutdown_generations ORDER BY generation"
        )
        .all()
        .map(({ generation }) => generation);
    return Object.freeze({
        activeLeaseCount: count(
            "SELECT count(*) AS count FROM shutdown_worker_leases WHERE released_at IS NULL"
        ),
        cleanGenerationCount: count(
            "SELECT count(*) AS count FROM shutdown_generations WHERE state = 'stopped'"
        ),
        generations: Object.freeze(generations),
        integrityCheck,
        journalMode: journalMode.toLowerCase(),
        releasedLeaseCount: count(
            "SELECT count(*) AS count FROM shutdown_worker_leases WHERE released_at IS NOT NULL"
        ),
    });
}
