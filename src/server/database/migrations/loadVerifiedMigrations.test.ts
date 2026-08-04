import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrationsDirectory } from "./freshDatabaseFixture.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";
import { migrationManifest } from "./manifest.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function copyMigrationGraph(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mira-migrations-"));
    temporaryDirectories.push(directory);
    await cp(migrationsDirectory, directory, { recursive: true });
    return directory;
}

function reviewedMigration() {
    const migration = migrationManifest[0];
    if (!migration) {
        throw new Error("Expected the migration manifest to contain one node");
    }
    return migration;
}

async function expectRejection(
    operation: Promise<unknown>,
    expectedMessage: string
): Promise<void> {
    let rejection: unknown;

    try {
        await operation;
    } catch (error) {
        rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(expectedMessage);
}

describe("reviewed migration manifest", () => {
    test("loads the exact reviewed graph in runtime order", async () => {
        const migrations = await loadVerifiedMigrations({
            directory: migrationsDirectory,
        });

        expect(migrations.map((migration) => migration.id)).toEqual(
            migrationManifest.map((migration) => migration.id)
        );
        expect(migrations[0]?.statements.length).toBeGreaterThan(1);
    });

    test("rejects a tampered snapshot", async () => {
        const directory = await copyMigrationGraph();
        const migrationId = reviewedMigration().id;

        await writeFile(`${directory}/${migrationId}/snapshot.json`, "{}\n");

        await expectRejection(
            loadVerifiedMigrations({ directory }),
            `Migration snapshot checksum mismatch: ${migrationId}`
        );
    });

    test("rejects tampered migration SQL", async () => {
        const directory = await copyMigrationGraph();
        const migrationId = reviewedMigration().id;

        await writeFile(`${directory}/${migrationId}/migration.sql`, "SELECT 1;\n");

        await expectRejection(
            loadVerifiedMigrations({ directory }),
            `Migration SQL checksum mismatch: ${migrationId}`
        );
    });

    test("rejects duplicate manifest ids", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [migration, { ...migration }],
            }),
            "Migration manifest contains an invalid or duplicate folder name"
        );
    });

    test("rejects manifest ids outside runtime order", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [
                    migration,
                    {
                        ...migration,
                        id: "20200101000000_dashboard-followup",
                    },
                ],
            }),
            "Migration manifest is not in runtime application order"
        );
    });

    test("rejects malformed SQL checksums", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [{ ...migration, migrationSha256: "not-a-checksum" }],
            }),
            "Migration manifest contains an invalid SHA-256 checksum"
        );
    });

    test("rejects malformed snapshot checksums", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [{ ...migration, snapshotSha256: "not-a-checksum" }],
            }),
            "Migration manifest contains an invalid SHA-256 checksum"
        );
    });

    test("rejects unreviewed migration folders", async () => {
        const directory = await copyMigrationGraph();
        await cp(
            `${directory}/${reviewedMigration().id}`,
            `${directory}/20260803215711_unreviewed`,
            { recursive: true }
        );

        await expectRejection(
            loadVerifiedMigrations({ directory }),
            "Migration directory does not match the reviewed manifest"
        );
    });
});
