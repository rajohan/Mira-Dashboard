import { Database } from "bun:sqlite";

interface ForeignKeyEnforcementRow {
    foreign_keys: number;
}

interface IgnoreCheckConstraintsRow {
    ignore_check_constraints: number;
}

interface IntegrityCheckRow {
    integrity_check: string;
}

/** Requires each migration connection to enforce all declared constraints. */
export function assertConstraintEnforcement(database: Database): void {
    const foreignKeys = database
        .query<ForeignKeyEnforcementRow, []>("PRAGMA foreign_keys")
        .get();

    if (foreignKeys?.foreign_keys !== 1) {
        throw new Error("Database foreign key enforcement must be enabled");
    }

    const ignoredChecks = database
        .query<IgnoreCheckConstraintsRow, []>("PRAGMA ignore_check_constraints")
        .get();
    if (ignoredChecks?.ignore_check_constraints !== 0) {
        throw new Error("Database check constraint enforcement must be enabled");
    }
}

/** Rejects databases whose stored rows violate foreign keys or SQLite integrity. */
export function assertDatabaseIntegrity(database: Database): void {
    const foreignKeyViolation = database.query("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation !== null) {
        throw new Error("Database foreign key integrity check failed");
    }

    const results = database.query<IntegrityCheckRow, []>("PRAGMA integrity_check").all();
    if (results.length !== 1 || results[0]?.integrity_check !== "ok") {
        throw new Error("Database integrity check failed");
    }
}
