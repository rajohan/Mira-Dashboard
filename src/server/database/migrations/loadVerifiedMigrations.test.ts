import { afterEach, describe, expect, test } from "bun:test";
import {
    appendFile,
    cp,
    link,
    mkdir,
    mkdtemp,
    open,
    rename,
    rm,
    symlink,
    truncate,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrationManifest } from "../../../shared/databaseMigrationManifest.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { migrationsDirectory } from "../../test/support/freshDatabase.ts";
import {
    loadVerifiedMigrations,
    migrationArtifactByteLimits,
    type MigrationArtifactVerificationTestHooks,
    type MigrationArtifactVerificationTestStage,
} from "./loadVerifiedMigrations.ts";

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
        throw new Error("Expected the migration manifest to contain a foundation node");
    }
    return migration;
}

async function expectRejection(
    operation: Promise<unknown>,
    expectedMessage: string
): Promise<Error> {
    let rejection: unknown;

    try {
        await operation;
    } catch (error) {
        rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(expectedMessage);
    return rejection as Error;
}

function createStageBarrier(targetStage: MigrationArtifactVerificationTestStage): {
    hooks: MigrationArtifactVerificationTestHooks;
    reached: Promise<void>;
    release: () => void;
} {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hasReachedTarget = false;
    return {
        hooks: {
            async afterStage(stage) {
                if (stage !== targetStage || hasReachedTarget) return;
                hasReachedTarget = true;
                reached.resolve();
                await release.promise;
            },
        },
        reached: reached.promise,
        release: release.resolve,
    };
}

async function rejectAfterStage(
    directory: string,
    stage: MigrationArtifactVerificationTestStage,
    mutate: () => Promise<void>
): Promise<Error> {
    const barrier = createStageBarrier(stage);
    const operation = loadVerifiedMigrations({
        directory,
        testHooks: barrier.hooks,
    });
    await barrier.reached;
    try {
        await mutate();
    } finally {
        barrier.release();
    }
    return expectRejection(
        operation,
        "Migration artifact graph is not a stable regular-file graph"
    );
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

    test("reports duplicate ids before malformed checksums", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [
                    { ...migration, migrationSha256: "not-a-checksum" },
                    migration,
                ],
            }),
            "Migration manifest contains an invalid or duplicate folder name"
        );
    });

    test("rejects an unknown manifest shape with the folder-name error", async () => {
        const directory = await copyMigrationGraph();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: { entries: [reviewedMigration()] },
            }),
            "Migration manifest contains an invalid or duplicate folder name"
        );
    });

    test("rejects manifest counts and ids beyond the reviewed bounds", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: Array.from({ length: 65 }, (_, index) => ({
                    ...migration,
                    id: `2026080403${String(index).padStart(4, "0")}_bounded`,
                })),
            }),
            "Migration manifest contains an invalid or duplicate folder name"
        );
        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [
                    {
                        ...migration,
                        id: `20260804022252_${"a".repeat(114)}`,
                    },
                ],
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

    test("reports runtime order before malformed checksums", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [
                    { ...migration, migrationSha256: "not-a-checksum" },
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

    test("rejects a non-string checksum from an unknown manifest", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [{ ...migration, migrationSha256: 1 }],
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

    test("rejects malformed migration folder names from the filesystem", async () => {
        const directory = await copyMigrationGraph();
        await cp(
            `${directory}/${reviewedMigration().id}`,
            `${directory}/not-a-migration`,
            { recursive: true }
        );

        await expectRejection(
            loadVerifiedMigrations({ directory }),
            "Migration directory does not match the reviewed manifest"
        );
    });

    test("rejects every unreviewed top-level entry type", async () => {
        for (const entryType of ["file", "fifo", "symlink"] as const) {
            const directory = await copyMigrationGraph();
            const extraEntry = path.join(directory, `unreviewed-${entryType}`);
            if (entryType === "file") {
                await writeFile(extraEntry, "unreviewed", "utf8");
            } else if (entryType === "symlink") {
                await symlink(reviewedMigration().id, extraEntry);
            } else {
                const creation = Bun.spawnSync({
                    cmd: ["mkfifo", extraEntry],
                    stderr: "pipe",
                    stdout: "ignore",
                });
                expect(creation.success).toBeTrue();
            }

            const error = await expectRejection(
                loadVerifiedMigrations({ directory }),
                "Migration directory does not match the reviewed manifest"
            );
            expect(String(error)).not.toContain(directory);
        }
    });

    test("requires exactly migration.sql and snapshot.json in each node", async () => {
        for (const mutation of ["extra", "missing"] as const) {
            const directory = await copyMigrationGraph();
            const migrationDirectory = path.join(directory, reviewedMigration().id);
            await (mutation === "extra"
                ? writeFile(
                      path.join(migrationDirectory, "unreviewed.txt"),
                      "unreviewed",
                      "utf8"
                  )
                : rm(path.join(migrationDirectory, "snapshot.json")));

            await expectRejection(
                loadVerifiedMigrations({ directory }),
                "Migration node does not contain the exact reviewed artifacts"
            );
        }
    });

    test("rejects symlink, FIFO, and directory artifacts without blocking", async () => {
        for (const artifactType of ["symlink", "fifo", "directory"] as const) {
            const directory = await copyMigrationGraph();
            const migrationDirectory = path.join(directory, reviewedMigration().id);
            const migrationSql = path.join(migrationDirectory, "migration.sql");
            await rm(migrationSql);
            if (artifactType === "symlink") {
                await symlink("snapshot.json", migrationSql);
            } else if (artifactType === "directory") {
                await mkdir(migrationSql);
            } else {
                const creation = Bun.spawnSync({
                    cmd: ["mkfifo", migrationSql],
                    stderr: "pipe",
                    stdout: "ignore",
                });
                expect(creation.success).toBeTrue();
            }

            const error = await expectRejection(
                loadVerifiedMigrations({ directory }),
                "Migration artifact graph is not a stable regular-file graph"
            );
            expect(String(error)).not.toContain(migrationSql);
        }
    }, 2000);

    test("rejects a hardlinked reviewed artifact", async () => {
        const directory = await copyMigrationGraph();
        const migrationSql = path.join(
            directory,
            reviewedMigration().id,
            "migration.sql"
        );
        const secondLink = `${directory}-migration-hardlink`;
        temporaryDirectories.push(secondLink);
        await link(migrationSql, secondLink);

        await expectRejection(
            loadVerifiedMigrations({ directory }),
            "Migration artifact graph is not a stable regular-file graph"
        );
    });

    test("rejects migration-root and reviewed-node symlinks", async () => {
        const rootTarget = await copyMigrationGraph();
        const rootLink = `${rootTarget}-root-link`;
        temporaryDirectories.push(rootLink);
        await symlink(rootTarget, rootLink);
        await expectRejection(
            loadVerifiedMigrations({ directory: rootLink }),
            "Migration directory does not match the reviewed manifest"
        );

        const directory = await copyMigrationGraph();
        const node = path.join(directory, reviewedMigration().id);
        const nodeTarget = `${directory}-node-target`;
        temporaryDirectories.push(nodeTarget);
        await rename(node, nodeTarget);
        await symlink(nodeTarget, node);
        await expectRejection(
            loadVerifiedMigrations({ directory }),
            "Migration artifact graph is not a stable regular-file graph"
        );
    });

    test("rejects a device where a migration directory is required", async () => {
        await expectRejection(
            loadVerifiedMigrations({ directory: "/dev/null" }),
            "Migration directory does not match the reviewed manifest"
        );
    });

    test("enforces per-file byte limits before reading", async () => {
        for (const [filename, maximumBytes] of [
            ["migration.sql", migrationArtifactByteLimits.migrationSql],
            ["snapshot.json", migrationArtifactByteLimits.snapshot],
        ] as const) {
            const directory = await copyMigrationGraph();
            await truncate(
                path.join(directory, reviewedMigration().id, filename),
                maximumBytes + 1
            );

            await expectRejection(
                loadVerifiedMigrations({ directory }),
                "Migration artifact graph exceeds the reviewed byte budget"
            );
        }
    });

    test("enforces the total graph byte limit before reading artifacts", async () => {
        const directory = await copyMigrationGraph();
        const sourceNode = path.join(directory, reviewedMigration().id);
        const manifest = [];
        for (let index = 0; index < 7; index += 1) {
            const id = `2026080402230${index}_bounded-graph-${index}`;
            const node = path.join(directory, id);
            await cp(sourceNode, node, { recursive: true });
            await truncate(
                path.join(node, "migration.sql"),
                migrationArtifactByteLimits.migrationSql
            );
            await truncate(
                path.join(node, "snapshot.json"),
                migrationArtifactByteLimits.snapshot
            );
            manifest.push({
                id,
                migrationSha256: "0".repeat(64),
                snapshotSha256: "0".repeat(64),
            });
        }
        await rm(sourceNode, { recursive: true });

        await expectRejection(
            loadVerifiedMigrations({ directory, manifest }),
            "Migration artifact graph exceeds the reviewed byte budget"
        );
    });

    test("rejects migration SQL that is not strict UTF-8 after checksum verification", async () => {
        const directory = await copyMigrationGraph();
        const migration = reviewedMigration();
        const invalidUtf8 = Buffer.from([195, 40]);
        await writeFile(path.join(directory, migration.id, "migration.sql"), invalidUtf8);

        await expectRejection(
            loadVerifiedMigrations({
                directory,
                manifest: [
                    {
                        ...migration,
                        migrationSha256: sha256Hex(invalidUtf8),
                    },
                ],
            }),
            `Migration SQL is not valid UTF-8: ${migration.id}`
        );
    });

    test("rejects deterministic shrink and growth after descriptor stat", async () => {
        for (const mutation of ["shrink", "grow"] as const) {
            const directory = await copyMigrationGraph();
            const migrationSql = path.join(
                directory,
                reviewedMigration().id,
                "migration.sql"
            );
            const error = await rejectAfterStage(
                directory,
                "migration-sql-initial-stat",
                () =>
                    mutation === "shrink"
                        ? truncate(migrationSql, 4)
                        : appendFile(migrationSql, "\nSELECT 1;", "utf8")
            );
            expect(String(error)).not.toContain(migrationSql);
        }
    });

    test("rejects a deterministic same-size overwrite after descriptor stat", async () => {
        const directory = await copyMigrationGraph();
        const migrationSql = path.join(
            directory,
            reviewedMigration().id,
            "migration.sql"
        );
        const mutator = await open(migrationSql, "r+");
        try {
            await rejectAfterStage(directory, "migration-sql-initial-stat", async () => {
                await mutator.write(Buffer.from("tampered"), 0, 8, 0);
                await mutator.sync();
            });
        } finally {
            await mutator.close();
        }
    });

    test("rejects requested artifact path replacement with identical bytes", async () => {
        const directory = await copyMigrationGraph();
        const migrationSql = path.join(
            directory,
            reviewedMigration().id,
            "migration.sql"
        );
        const replacement = `${directory}-replacement.sql`;
        temporaryDirectories.push(replacement);
        await cp(migrationSql, replacement);

        await rejectAfterStage(directory, "migration-sql-initial-stat", () =>
            rename(replacement, migrationSql)
        );
    });

    test("rejects reviewed node directory replacement with identical contents", async () => {
        const directory = await copyMigrationGraph();
        const node = path.join(directory, reviewedMigration().id);
        const originalNode = `${directory}-original-node`;
        const replacementNode = `${directory}-replacement-node`;
        temporaryDirectories.push(originalNode, replacementNode);
        await cp(node, replacementNode, { recursive: true });

        await rejectAfterStage(directory, "node-inventory", async () => {
            await rename(node, originalNode);
            await rename(replacementNode, node);
        });
    });

    test("rejects migration root replacement with an identical graph", async () => {
        const directory = await copyMigrationGraph();
        const originalRoot = `${directory}-original-root`;
        const replacementRoot = `${directory}-replacement-root`;
        temporaryDirectories.push(originalRoot, replacementRoot);
        await cp(directory, replacementRoot, { recursive: true });

        await rejectAfterStage(directory, "root-inventory", async () => {
            await rename(directory, originalRoot);
            await rename(replacementRoot, directory);
        });
    });
});
