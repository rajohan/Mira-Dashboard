import { expect, test } from "bun:test";

import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../test/support/freshDatabase.ts";
import { applyVerifiedMigrations } from "./applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

const insertMigration = `
    INSERT INTO schema_migrations (
        applied_at,
        checksum,
        id,
        release_id
    ) VALUES (?, ?, ?, ?)
`;

test("enforces every migration ledger field at the storage boundary", async () => {
    const invalidRows = [
        {
            expectedConstraint: "schema_migrations_applied_at_check",
            values: [-1, "a".repeat(64), "20260805000000_direct", "1".repeat(40)],
        },
        {
            expectedConstraint: "schema_migrations_applied_at_check",
            values: [
                8_640_000_000_000_001,
                "a".repeat(64),
                "20260805000000_direct",
                "1".repeat(40),
            ],
        },
        {
            expectedConstraint: "schema_migrations_checksum_check",
            values: [1, "A".repeat(64), "20260805000000_direct", "1".repeat(40)],
        },
        {
            expectedConstraint: "schema_migrations_checksum_check",
            values: [1, "a".repeat(63), "20260805000000_direct", "1".repeat(40)],
        },
        {
            expectedConstraint: "schema_migrations_id_check",
            values: [1, "a".repeat(64), "20260805000000_Invalid", "1".repeat(40)],
        },
        {
            expectedConstraint: "schema_migrations_id_check",
            values: [1, "a".repeat(64), "20260805000000_direct/child", "1".repeat(40)],
        },
        {
            expectedConstraint: "schema_migrations_id_check",
            values: [
                1,
                "a".repeat(64),
                `20260805000000_${"a".repeat(114)}`,
                "1".repeat(40),
            ],
        },
        {
            expectedConstraint: "schema_migrations_release_id_check",
            values: [1, "a".repeat(64), "20260805000000_direct", "A".repeat(40)],
        },
        {
            expectedConstraint: "schema_migrations_release_id_check",
            values: [1, "a".repeat(64), "20260805000000_direct", "1".repeat(39)],
        },
    ] as const;

    for (const invalidRow of invalidRows) {
        const database = await openFreshMigratedDatabase();
        try {
            expect(() =>
                database.sqlite.run(insertMigration, [...invalidRow.values])
            ).toThrow(`CHECK constraint failed: ${invalidRow.expectedConstraint}`);
        } finally {
            database.sqlite.close(true);
        }
    }
});

test("rejects updates, deletes, and replacements in the append-only ledger", async () => {
    const database = await openFreshMigratedDatabase();

    try {
        const migration = database.sqlite
            .query<{ id: string }, []>("SELECT id FROM schema_migrations")
            .get();
        if (!migration) throw new Error("Expected one applied migration");

        for (const statement of [
            "UPDATE schema_migrations SET release_id = release_id WHERE id = ?",
            "DELETE FROM schema_migrations WHERE id = ?",
            `INSERT OR REPLACE INTO schema_migrations (
                applied_at,
                checksum,
                id,
                release_id
            ) SELECT applied_at, checksum, id, release_id
              FROM schema_migrations
             WHERE id = ?`,
        ]) {
            expect(() => database.sqlite.run(statement, [migration.id])).toThrow(
                "schema_migrations is append-only"
            );
        }
    } finally {
        database.sqlite.close(true);
    }
});

test("validates every raw field in a tampered durable migration ledger", async () => {
    const migrations = await loadVerifiedMigrations({ directory: migrationsDirectory });
    const foundationMigration = migrations[0];
    if (foundationMigration === undefined) {
        throw new Error("Expected the migration graph to contain a foundation node");
    }
    const corruptions = [
        "UPDATE schema_migrations SET applied_at = -1 WHERE id = ?",
        "UPDATE schema_migrations SET id = 'invalid' WHERE id = ?",
        `UPDATE schema_migrations SET release_id = '${"A".repeat(40)}' WHERE id = ?`,
    ] as const;

    for (const corruption of corruptions) {
        const database = await openFreshMigratedDatabase();
        try {
            database.sqlite.run("DROP TRIGGER schema_migrations_reject_update");
            database.sqlite.run("PRAGMA ignore_check_constraints = ON");
            database.sqlite.run(corruption, [foundationMigration.id]);
            database.sqlite.run("PRAGMA ignore_check_constraints = OFF");

            expect(() =>
                applyVerifiedMigrations(database.sqlite, migrations, {
                    releaseId: "1".repeat(40),
                })
            ).toThrow("Database migration history does not match the reviewed manifest");
        } finally {
            database.sqlite.close(true);
        }
    }
});
