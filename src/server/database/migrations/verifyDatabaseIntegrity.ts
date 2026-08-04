import { Database } from "bun:sqlite";

import * as v from "valibot";

import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";

const foreignKeyEnforcementRowSchema = v.strictObject({
    foreign_keys: nonnegativeSafeIntegerSchema(),
});
const ignoreCheckConstraintsRowSchema = v.strictObject({
    ignore_check_constraints: nonnegativeSafeIntegerSchema(),
});
const integrityCheckRowsSchema = v.array(v.strictObject({ integrity_check: v.string() }));

/** Requires each migration connection to enforce all declared constraints. */
export function assertConstraintEnforcement(database: Database): void {
    const foreignKeys = v.safeParse(
        v.nullable(foreignKeyEnforcementRowSchema),
        database.query("PRAGMA foreign_keys").get(),
        { abortEarly: true }
    );

    if (!foreignKeys.success || foreignKeys.output?.foreign_keys !== 1) {
        throw new Error("Database foreign key enforcement must be enabled");
    }

    const ignoredChecks = v.safeParse(
        v.nullable(ignoreCheckConstraintsRowSchema),
        database.query("PRAGMA ignore_check_constraints").get(),
        { abortEarly: true }
    );
    if (!ignoredChecks.success || ignoredChecks.output?.ignore_check_constraints !== 0) {
        throw new Error("Database check constraint enforcement must be enabled");
    }
}

/** Rejects databases whose stored rows violate foreign keys or SQLite integrity. */
export function assertDatabaseIntegrity(database: Database): void {
    const foreignKeyViolation = database.query("PRAGMA foreign_key_check").get();
    if (!v.safeParse(v.null(), foreignKeyViolation).success) {
        throw new Error("Database foreign key integrity check failed");
    }

    const results = v.safeParse(
        integrityCheckRowsSchema,
        database.query("PRAGMA integrity_check").all(),
        { abortEarly: true }
    );
    if (
        !results.success ||
        results.output.length !== 1 ||
        results.output[0]?.integrity_check !== "ok"
    ) {
        throw new Error("Database integrity check failed");
    }
}
