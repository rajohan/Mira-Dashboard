import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrationsDirectory } from "../../test/support/freshDatabase.ts";
import { applyVerifiedMigrations } from "./applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

const foundationReleaseId = "1".repeat(40);
const securityCoreReleaseId = "2".repeat(40);
const nulTaintedSha256 = `${"a".repeat(64)}\0suffix`;

const legacyNulCases = [
    {
        error: "incidents fingerprint must not contain NUL",
        insert(database: Database): void {
            database.run(
                `INSERT INTO incidents (
                    fingerprint,
                    first_seen_at,
                    id,
                    kind,
                    last_seen_at,
                    monitor_key,
                    occurrence_count,
                    severity,
                    state,
                    title
                ) VALUES (?, 1000, 'legacy-incident', 'system', 1000, 'ops-check', 1, 'warning', 'active', 'Legacy incident')`,
                [nulTaintedSha256]
            );
        },
        name: "incident fingerprint",
    },
    {
        error: "monitor_runs submission_sha256 must not contain NUL",
        insert(database: Database): void {
            database.run(
                `INSERT INTO monitor_runs (
                    complete_snapshot,
                    id,
                    monitor_key,
                    submission_sha256,
                    started_at,
                    state
                ) VALUES (1, 'legacy-run', 'ops-check', ?, 1000, 'running')`,
                [nulTaintedSha256]
            );
        },
        name: "monitor-run checksum",
    },
] as const;

async function openLockedFoundationDatabase() {
    const migrations = await loadVerifiedMigrations({
        directory: migrationsDirectory,
    });
    const foundationMigration = migrations[0];
    if (!foundationMigration || migrations.length < 2) {
        throw new Error("Expected foundation and security-core migrations");
    }

    const database = new Database(":memory:", { strict: true });
    try {
        database.run("PRAGMA foreign_keys = ON");
        for (const statement of foundationMigration.statements) {
            const executableStatement = statement.trim();
            if (executableStatement.length > 0) database.run(executableStatement);
        }
        database.run(
            `INSERT INTO schema_migrations (
                applied_at,
                checksum,
                id,
                release_id
            ) VALUES (0, ?, ?, ?)`,
            [
                foundationMigration.migrationSha256,
                foundationMigration.id,
                foundationReleaseId,
            ]
        );
        return { database, foundationMigration, migrations };
    } catch (error) {
        database.close(true);
        throw error;
    }
}

describe("applyVerifiedMigrations", () => {
    for (const legacyCase of legacyNulCases) {
        test(`rejects a locked foundation containing a NUL-tainted ${legacyCase.name}`, async () => {
            const { database, foundationMigration, migrations } =
                await openLockedFoundationDatabase();

            try {
                legacyCase.insert(database);

                expect(() =>
                    applyVerifiedMigrations(database, migrations, {
                        appliedAt: new Date(1),
                        releaseId: securityCoreReleaseId,
                    })
                ).toThrow(legacyCase.error);
                expect(
                    database
                        .query<{ name: string }, []>(`
                            SELECT name
                            FROM sqlite_schema
                            WHERE name IN (
                                'incidents_reject_nul_fingerprint_insert',
                                'monitor_runs_reject_nul_submission_sha256_insert',
                                'users'
                            )
                            ORDER BY name
                        `)
                        .all()
                ).toEqual([]);
                expect(
                    database
                        .query<{ checksum: string; id: string; releaseId: string }, []>(`
                            SELECT checksum, id, release_id AS releaseId
                            FROM schema_migrations
                            ORDER BY id
                        `)
                        .all()
                ).toEqual([
                    {
                        checksum: foundationMigration.migrationSha256,
                        id: foundationMigration.id,
                        releaseId: foundationReleaseId,
                    },
                ]);
            } finally {
                database.close(true);
            }
        });
    }
});
