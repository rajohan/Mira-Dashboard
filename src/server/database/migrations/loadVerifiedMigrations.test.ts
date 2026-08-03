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
        const migrationId = migrationManifest[0]?.id;
        expect(migrationId).toBeDefined();

        await writeFile(`${directory}/${migrationId}/snapshot.json`, "{}\n");

        await expectRejection(
            loadVerifiedMigrations({ directory }),
            `Migration snapshot checksum mismatch: ${migrationId}`
        );
    });

    test("rejects unreviewed migration folders", async () => {
        const directory = await copyMigrationGraph();
        await cp(
            `${directory}/${migrationManifest[0]?.id}`,
            `${directory}/20260803215711_unreviewed`,
            { recursive: true }
        );

        await expectRejection(
            loadVerifiedMigrations({ directory }),
            "Migration directory does not match the reviewed manifest"
        );
    });
});
