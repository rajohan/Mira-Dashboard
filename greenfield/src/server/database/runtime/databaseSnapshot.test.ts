import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    copyFile,
    link,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, ManagedRuntime } from "effect";

import { withDeploymentLease } from "../../../../scripts/delivery/deploymentLease.ts";
import { prepareProtectedProductionStatePath } from "../../../../scripts/delivery/productionStateFilesystem.ts";
import { rejectionError } from "../../../../scripts/testSupport/rejection.ts";
import {
    parseDatabaseSnapshotManifest,
    serializeDatabaseSnapshotManifest,
} from "../../../shared/databaseSnapshotManifest.ts";
import { databaseRuntimeLayer, DatabaseRuntimeService } from "./databaseService.ts";
import {
    createVerifiedDatabaseSnapshot,
    createVerifiedSqliteMaintenanceSnapshot,
    DatabaseSnapshotError,
    readVerifiedSqliteMaintenanceInventory,
} from "./databaseSnapshot.ts";

const migrationsDirectory = path.resolve(import.meta.dir, "../../../../migrations");
const releaseId = "a".repeat(40);
const temporaryDirectories: string[] = [];
const runtimes: Array<{ dispose(): Promise<void> }> = [];

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await stat(directory).catch(() => null);
    if (!status?.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await restoreOwnerWrite(entryPath);
        } else if (entry.isFile()) {
            await chmod(entryPath, 0o600);
        }
    }
}

afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function fixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-db-snapshot-"));
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    return { projectRoot, state };
}

async function withProcessUmask<T>(
    mask: number,
    operation: () => Promise<T>
): Promise<T> {
    const previous = process.umask(mask);
    try {
        return await operation();
    } finally {
        process.umask(previous);
    }
}

async function initializeDatabase(stateDirectory: string): Promise<void> {
    const runtime = ManagedRuntime.make(
        databaseRuntimeLayer({
            migrationsDirectory,
            releaseId,
            startupMode: "initialize-empty",
            stateDirectory,
        })
    );
    runtimes.push(runtime);
    await runtime.context();
    await runtime.dispose();
}

function uuidV7At(timestampMs: number, suffix: number): string {
    const timestamp = timestampMs.toString(16).padStart(12, "0");
    return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

async function cloneMaintenanceSnapshot(
    sourceDirectory: string,
    targetDirectory: string,
    transitionId: string,
    restoreVerifiedAtMs: number
): Promise<void> {
    await mkdir(targetDirectory, { mode: 0o700 });
    await copyFile(
        path.join(sourceDirectory, "mira-dashboard.db"),
        path.join(targetDirectory, "mira-dashboard.db")
    );
    await chmod(path.join(targetDirectory, "mira-dashboard.db"), 0o400);
    const sourceManifest = parseDatabaseSnapshotManifest(
        JSON.parse(
            await readFile(path.join(sourceDirectory, "snapshot-manifest.json"), "utf8")
        ) as unknown
    );
    const manifest = parseDatabaseSnapshotManifest({
        ...sourceManifest,
        restoreVerifiedAtMs,
        transitionId,
    });
    const manifestFile = path.join(targetDirectory, "snapshot-manifest.json");
    await writeFile(manifestFile, serializeDatabaseSnapshotManifest(manifest), {
        mode: 0o600,
    });
    await chmod(manifestFile, 0o400);
    await chmod(targetDirectory, 0o500);
}

describe("verified database snapshots", () => {
    test("publishes one verified online maintenance snapshot in its isolated namespace", async () => {
        const { state } = await fixture();
        const runtime = ManagedRuntime.make(
            databaseRuntimeLayer({
                migrationsDirectory,
                releaseId,
                startupMode: "initialize-empty",
                stateDirectory: state.stateDirectory,
            })
        );
        runtimes.push(runtime);
        await runtime.runPromise(DatabaseRuntimeService);
        const transitionId = uuidV7At(Date.now() - 1000, 100);
        const result = await withProcessUmask(0o022, () =>
            Effect.runPromise(
                createVerifiedSqliteMaintenanceSnapshot({
                    migrationsDirectory,
                    releaseId,
                    stateDirectory: state.stateDirectory,
                    transitionId,
                })
            )
        );
        expect(result.backupCreatedAtMs).toBe(
            Number.parseInt(transitionId.replaceAll("-", "").slice(0, 12), 16)
        );

        expect(result.status).toBe("completed");
        expect(result.retainedBackupCount).toBe(1);
        expect(Number.isSafeInteger(result.checkpoint.busyFrames)).toBe(true);
        expect(Number.isSafeInteger(result.checkpoint.checkpointedFrames)).toBe(true);
        expect(Number.isSafeInteger(result.checkpoint.logFrames)).toBe(true);
        expect(result.backupBytes).toBeGreaterThan(0);
        expect(result.retainedBackupBytes).toBe(result.backupBytes);
        expect(result.completedAtMs).toBeGreaterThan(0);
        expect(await readdir(state.backupsDirectory)).toEqual(["sqlite-maintenance"]);
        const snapshotDirectory = path.join(
            state.backupsDirectory,
            "sqlite-maintenance",
            transitionId
        );
        const [snapshotDirectoryStatus, snapshotFileStatus] = await Promise.all([
            stat(snapshotDirectory),
            stat(path.join(snapshotDirectory, "mira-dashboard.db")),
        ]);
        expect(snapshotDirectoryStatus.mode & 0o777).toBe(0o500);
        expect(snapshotFileStatus.mode & 0o777).toBe(0o400);
        const inventory = await readVerifiedSqliteMaintenanceInventory(
            state.stateDirectory
        );
        const restoreVerifiedAtMs = inventory.backups[0]?.restoreVerifiedAtMs;
        expect(restoreVerifiedAtMs).toBeDefined();
        if (restoreVerifiedAtMs === undefined) throw new Error("missing verification");
        expect(restoreVerifiedAtMs >= result.backupCreatedAtMs).toBe(true);
        expect(restoreVerifiedAtMs <= result.completedAtMs).toBe(true);
        expect(inventory).toEqual({
            backups: [
                {
                    bytes: result.backupBytes,
                    createdAtMs: result.backupCreatedAtMs,
                    kind: "scheduled",
                    restoreVerifiedAtMs: expect.any(Number),
                    verificationLevel: "restore-copy-verified",
                },
            ],
            totalBytes: result.backupBytes,
        });
    });

    test("fails closed when the isolated restore-verification copy is corrupt", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const transitionId = Bun.randomUUIDv7();
        let restoreCopyFile: string | undefined;
        const failure = await rejectionError(
            Effect.runPromise(
                createVerifiedSqliteMaintenanceSnapshot(
                    {
                        migrationsDirectory,
                        releaseId,
                        stateDirectory: state.stateDirectory,
                        transitionId,
                    },
                    {
                        afterRestoreCopyCreated: async (candidate) => {
                            restoreCopyFile = candidate;
                            await writeFile(candidate, "corrupt restore copy");
                        },
                    }
                )
            )
        );

        expect(failure).toBeInstanceOf(DatabaseSnapshotError);
        expect(restoreCopyFile).toContain(`.verify-${transitionId}`);
        expect(
            await readdir(path.join(state.backupsDirectory, "sqlite-maintenance"))
        ).toEqual([]);
        expect(
            await readVerifiedSqliteMaintenanceInventory(state.stateDirectory)
        ).toEqual({ backups: [], totalBytes: 0 });
    });

    test("recovers bounded crash remnants before retention without deleting cutover snapshots", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const baseTimestamp = Date.now() - 120_000;
        const cutoverId = uuidV7At(baseTimestamp, 1);
        await withDeploymentLease(state.stateDirectory, async () =>
            Effect.runPromise(
                createVerifiedDatabaseSnapshot({
                    expectedState: "present",
                    migrationsDirectory,
                    releaseId,
                    stateDirectory: state.stateDirectory,
                    transitionId: cutoverId,
                })
            )
        );
        const firstScheduledId = uuidV7At(baseTimestamp + 10_000, 2);
        await Effect.runPromise(
            createVerifiedSqliteMaintenanceSnapshot({
                migrationsDirectory,
                releaseId,
                stateDirectory: state.stateDirectory,
                transitionId: firstScheduledId,
            })
        );
        const maintenanceDirectory = path.join(
            state.backupsDirectory,
            "sqlite-maintenance"
        );
        const firstScheduledDirectory = path.join(maintenanceDirectory, firstScheduledId);
        for (let index = 1; index < 14; index += 1) {
            const transitionId = uuidV7At(
                baseTimestamp + 10_000 + index * 1000,
                index + 2
            );
            await cloneMaintenanceSnapshot(
                firstScheduledDirectory,
                path.join(maintenanceDirectory, transitionId),
                transitionId,
                baseTimestamp + 30_000
            );
        }
        const staleStageId = uuidV7At(baseTimestamp + 40_000, 30);
        const staleVerifyId = uuidV7At(baseTimestamp + 41_000, 31);
        await mkdir(path.join(maintenanceDirectory, `.stage-${staleStageId}`), {
            mode: 0o700,
        });
        await mkdir(path.join(maintenanceDirectory, `.verify-${staleVerifyId}`), {
            mode: 0o700,
        });

        const nextId = uuidV7At(baseTimestamp + 50_000, 32);
        const result = await Effect.runPromise(
            createVerifiedSqliteMaintenanceSnapshot({
                migrationsDirectory,
                releaseId,
                stateDirectory: state.stateDirectory,
                transitionId: nextId,
            })
        );

        const retained = await readdir(maintenanceDirectory);
        expect(retained).toHaveLength(14);
        expect(retained).toContain(nextId);
        expect(retained.some((entry) => entry.startsWith("."))).toBe(false);
        expect(await stat(path.join(state.backupsDirectory, cutoverId))).toMatchObject({
            mode: expect.any(Number),
        });
        expect(result.retainedBackupCount).toBe(14);
        const inventory = await readVerifiedSqliteMaintenanceInventory(
            state.stateDirectory
        );
        expect(inventory.backups.some(({ kind }) => kind === "cutover")).toBe(true);
        expect(inventory.backups.filter(({ kind }) => kind === "scheduled")).toHaveLength(
            14
        );
        expect(inventory.backups).toHaveLength(15);
        expect(inventory.totalBytes).toBe(
            inventory.backups.reduce((total, backup) => total + backup.bytes, 0)
        );
    });

    test("preserves the committed new snapshot when retention fails after retiring an old one", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const baseTimestamp = Date.now() - 120_000;
        const firstScheduledId = uuidV7At(baseTimestamp + 10_000, 101);
        await Effect.runPromise(
            createVerifiedSqliteMaintenanceSnapshot({
                migrationsDirectory,
                releaseId,
                stateDirectory: state.stateDirectory,
                transitionId: firstScheduledId,
            })
        );
        const maintenanceDirectory = path.join(
            state.backupsDirectory,
            "sqlite-maintenance"
        );
        const firstScheduledDirectory = path.join(maintenanceDirectory, firstScheduledId);
        for (let index = 1; index < 14; index += 1) {
            const transitionId = uuidV7At(
                baseTimestamp + 10_000 + index * 1000,
                index + 101
            );
            await cloneMaintenanceSnapshot(
                firstScheduledDirectory,
                path.join(maintenanceDirectory, transitionId),
                transitionId,
                baseTimestamp + 30_000
            );
        }

        const committedId = uuidV7At(baseTimestamp + 50_000, 120);
        let interrupted = false;
        const failure = await rejectionError(
            Effect.runPromise(
                createVerifiedSqliteMaintenanceSnapshot(
                    {
                        migrationsDirectory,
                        releaseId,
                        stateDirectory: state.stateDirectory,
                        transitionId: committedId,
                    },
                    {
                        afterRetiredDirectorySynced: (ownedName) => {
                            if (ownedName === firstScheduledId && !interrupted) {
                                interrupted = true;
                                throw new Error("simulated retention crash after retire");
                            }
                        },
                    }
                )
            )
        );

        expect(failure).toBeInstanceOf(DatabaseSnapshotError);
        expect(interrupted).toBe(true);
        expect(await readdir(maintenanceDirectory)).toEqual(
            expect.arrayContaining([committedId, `.retire-final-${firstScheduledId}`])
        );
        const interruptedInventory = await readVerifiedSqliteMaintenanceInventory(
            state.stateDirectory
        );
        expect(
            interruptedInventory.backups.filter(({ kind }) => kind === "scheduled")
        ).toHaveLength(14);

        const recoveryId = uuidV7At(baseTimestamp + 60_000, 121);
        const recovered = await Effect.runPromise(
            createVerifiedSqliteMaintenanceSnapshot({
                migrationsDirectory,
                releaseId,
                stateDirectory: state.stateDirectory,
                transitionId: recoveryId,
            })
        );
        const recoveredEntries = await readdir(maintenanceDirectory);
        expect(recovered.status).toBe("completed");
        expect(recovered.retainedBackupCount).toBe(14);
        expect(recoveredEntries).toHaveLength(14);
        expect(recoveredEntries).toContain(committedId);
        expect(recoveredEntries).toContain(recoveryId);
        expect(recoveredEntries.some((name) => name.startsWith("."))).toBe(false);
    });

    test("resumes scheduled cleanup after retire rename and partial unlink crashes", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const maintenanceDirectory = path.join(
            state.backupsDirectory,
            "sqlite-maintenance"
        );
        await mkdir(maintenanceDirectory, { mode: 0o700 });
        const nowMs = Date.now();
        const firstStaleId = uuidV7At(nowMs - 3000, 301);
        await mkdir(path.join(maintenanceDirectory, `.stage-${firstStaleId}`), {
            mode: 0o700,
        });

        const firstFailure = await rejectionError(
            Effect.runPromise(
                createVerifiedSqliteMaintenanceSnapshot(
                    {
                        migrationsDirectory,
                        releaseId,
                        stateDirectory: state.stateDirectory,
                        transitionId: uuidV7At(nowMs - 2000, 302),
                    },
                    {
                        afterRetiredDirectorySynced: (ownedName) => {
                            if (ownedName === `.stage-${firstStaleId}`) {
                                throw new Error("simulated crash after retire rename");
                            }
                        },
                    }
                )
            )
        );
        expect(firstFailure).toBeInstanceOf(DatabaseSnapshotError);
        expect(await readdir(maintenanceDirectory)).toContain(
            `.retire-stage-${firstStaleId}`
        );

        const secondStaleId = uuidV7At(nowMs - 1500, 303);
        const secondStage = path.join(maintenanceDirectory, `.stage-${secondStaleId}`);
        await mkdir(secondStage, { mode: 0o700 });
        await writeFile(path.join(secondStage, "mira-dashboard.db"), "fixture", {
            mode: 0o600,
        });
        let interrupted = false;
        const secondFailure = await rejectionError(
            Effect.runPromise(
                createVerifiedSqliteMaintenanceSnapshot(
                    {
                        migrationsDirectory,
                        releaseId,
                        stateDirectory: state.stateDirectory,
                        transitionId: uuidV7At(nowMs - 1000, 304),
                    },
                    {
                        afterRetiredFileRemoved: (ownedName) => {
                            if (
                                ownedName === `.retire-stage-${secondStaleId}` &&
                                !interrupted
                            ) {
                                interrupted = true;
                                throw new Error("simulated crash after unlink");
                            }
                        },
                    }
                )
            )
        );
        expect(secondFailure).toBeInstanceOf(DatabaseSnapshotError);
        expect(await readdir(maintenanceDirectory)).toContain(
            `.retire-stage-${secondStaleId}`
        );

        const result = await Effect.runPromise(
            createVerifiedSqliteMaintenanceSnapshot({
                migrationsDirectory,
                releaseId,
                stateDirectory: state.stateDirectory,
                transitionId: uuidV7At(nowMs, 305),
            })
        );
        expect(result.status).toBe("completed");
        const maintenanceEntries = await readdir(maintenanceDirectory);
        expect(maintenanceEntries.some((name) => name.startsWith("."))).toBe(false);
    });

    test("fails closed on scheduled cleanup parent swaps and future UUIDs", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const maintenanceDirectory = path.join(
            state.backupsDirectory,
            "sqlite-maintenance"
        );
        await mkdir(maintenanceDirectory, { mode: 0o700 });
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 1000, 401);
        const stage = path.join(maintenanceDirectory, `.stage-${staleId}`);
        const moved = path.join(maintenanceDirectory, `.raced-${staleId}`);
        await mkdir(stage, { mode: 0o700 });

        const swapped = await rejectionError(
            Effect.runPromise(
                createVerifiedSqliteMaintenanceSnapshot(
                    {
                        migrationsDirectory,
                        releaseId,
                        stateDirectory: state.stateDirectory,
                        transitionId: uuidV7At(nowMs, 402),
                    },
                    {
                        beforeOwnedSnapshotRetired: async (ownedName) => {
                            if (ownedName !== `.stage-${staleId}`) return;
                            await rename(stage, moved);
                            await mkdir(stage, { mode: 0o700 });
                            await writeFile(
                                path.join(stage, "mira-dashboard.db"),
                                "replacement",
                                {
                                    mode: 0o600,
                                }
                            );
                        },
                    }
                )
            )
        );
        expect(swapped).toBeInstanceOf(DatabaseSnapshotError);
        expect(await readFile(path.join(stage, "mira-dashboard.db"), "utf8")).toBe(
            "replacement"
        );

        await rm(moved, { recursive: true });
        await rm(stage, { recursive: true });
        const futureId = uuidV7At(nowMs + 60_000, 403);
        await mkdir(path.join(maintenanceDirectory, `.stage-${futureId}`), {
            mode: 0o700,
        });
        const future = await rejectionError(
            Effect.runPromise(
                createVerifiedSqliteMaintenanceSnapshot({
                    migrationsDirectory,
                    releaseId,
                    stateDirectory: state.stateDirectory,
                    transitionId: uuidV7At(nowMs + 1, 404),
                })
            )
        );
        expect(future).toBeInstanceOf(DatabaseSnapshotError);
        expect(await readdir(maintenanceDirectory)).toContain(`.stage-${futureId}`);
    });

    test("quarantines scheduled transient symlinks and hardlinks without deleting targets", async () => {
        for (const kind of ["hardlink", "symlink"] as const) {
            const { state } = await fixture();
            await initializeDatabase(state.stateDirectory);
            const maintenanceDirectory = path.join(
                state.backupsDirectory,
                "sqlite-maintenance"
            );
            await mkdir(maintenanceDirectory, { mode: 0o700 });
            const nowMs = Date.now();
            const staleId = uuidV7At(nowMs - 1000, kind === "hardlink" ? 501 : 502);
            const stage = path.join(maintenanceDirectory, `.stage-${staleId}`);
            const target = path.join(state.stateDirectory, `${kind}-target`);
            await mkdir(stage, { mode: 0o700 });
            await writeFile(target, "protected", { mode: 0o600 });
            await (kind === "hardlink"
                ? link(target, path.join(stage, "mira-dashboard.db"))
                : symlink(target, path.join(stage, "mira-dashboard.db")));

            const failure = await rejectionError(
                Effect.runPromise(
                    createVerifiedSqliteMaintenanceSnapshot({
                        migrationsDirectory,
                        releaseId,
                        stateDirectory: state.stateDirectory,
                        transitionId: uuidV7At(nowMs, kind === "hardlink" ? 503 : 504),
                    })
                )
            );
            expect(failure).toBeInstanceOf(DatabaseSnapshotError);
            expect(await readFile(target, "utf8")).toBe("protected");
        }
    });

    test("orders scheduled and cutover records created in the same millisecond", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const timestamp = Date.now() - 1000;
        const cutoverId = uuidV7At(timestamp, 201);
        await withDeploymentLease(state.stateDirectory, async () =>
            Effect.runPromise(
                createVerifiedDatabaseSnapshot({
                    expectedState: "present",
                    migrationsDirectory,
                    releaseId,
                    stateDirectory: state.stateDirectory,
                    transitionId: cutoverId,
                })
            )
        );
        const scheduledId = uuidV7At(timestamp, 202);
        await Effect.runPromise(
            createVerifiedSqliteMaintenanceSnapshot({
                migrationsDirectory,
                releaseId,
                stateDirectory: state.stateDirectory,
                transitionId: scheduledId,
            })
        );

        const inventory = await readVerifiedSqliteMaintenanceInventory(
            state.stateDirectory
        );
        expect(inventory.backups.map(({ createdAtMs }) => createdAtMs)).toEqual([
            timestamp,
            timestamp,
        ]);
        expect(inventory.backups.map(({ kind }) => kind).toSorted()).toEqual([
            "cutover",
            "scheduled",
        ]);
    });

    test("records an expected absent state without creating a backup artifact", async () => {
        const { state } = await fixture();
        const transitionId = Bun.randomUUIDv7();
        const result = await withDeploymentLease(state.stateDirectory, async () =>
            Effect.runPromise(
                createVerifiedDatabaseSnapshot({
                    expectedState: "absent",
                    stateDirectory: state.stateDirectory,
                    transitionId,
                })
            )
        );

        expect(result).toEqual({ state: "absent", transitionId });
        expect(await readdir(state.backupsDirectory)).toEqual([]);
    });

    test("creates one immutable release-bound WAL-safe snapshot", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const transitionId = Bun.randomUUIDv7();
        const result = await withDeploymentLease(state.stateDirectory, async () =>
            Effect.runPromise(
                createVerifiedDatabaseSnapshot({
                    expectedState: "present",
                    migrationsDirectory,
                    releaseId,
                    stateDirectory: state.stateDirectory,
                    transitionId,
                })
            )
        );
        if (result.state !== "present") throw new Error("Expected snapshot artifact");

        expect(result.snapshotDirectory).toBe(
            path.join(state.backupsDirectory, transitionId)
        );
        const [snapshotDirectoryStatus, snapshotFileStatus] = await Promise.all([
            stat(result.snapshotDirectory),
            stat(result.snapshotFile),
        ]);
        expect(snapshotDirectoryStatus.mode & 0o777).toBe(0o500);
        expect(snapshotFileStatus.mode & 0o777).toBe(0o400);
        expect(result.manifest.releaseId).toBe(releaseId);
        expect(result.manifest.database.bytes).toBeGreaterThan(0);
        expect(result.manifest.migrations).toHaveLength(1);
        const manifestPath = path.join(
            result.snapshotDirectory,
            "snapshot-manifest.json"
        );
        const manifestText = await readFile(manifestPath, "utf8");
        const manifestValue: unknown = JSON.parse(manifestText);
        const storedManifest = parseDatabaseSnapshotManifest(manifestValue);
        expect(storedManifest).toEqual(result.manifest);

        const snapshot = new Database(result.snapshotFile, {
            readonly: true,
            strict: true,
        });
        try {
            expect(
                snapshot
                    .query<{ count: number; releaseId: string }, []>(`
                        SELECT COUNT(*) AS count, MIN(release_id) AS releaseId
                        FROM schema_migrations
                    `)
                    .get()
            ).toEqual({ count: 1, releaseId });
        } finally {
            snapshot.close(true);
        }
        expect(
            await readVerifiedSqliteMaintenanceInventory(state.stateDirectory)
        ).toEqual({
            backups: [
                {
                    bytes: result.manifest.database.bytes,
                    createdAtMs: expect.any(Number),
                    kind: "cutover",
                    verificationLevel: "manifest-verified",
                },
            ],
            totalBytes: result.manifest.database.bytes,
        });
        for (const suffix of ["-journal", "-shm", "-wal"] as const) {
            expect(
                await stat(
                    path.join(state.stateDirectory, `mira-dashboard.db${suffix}`)
                ).catch(() => null)
            ).toBeNull();
        }
    });

    test("fails closed under a permissive umask and removes only its owned stage", async () => {
        const { state } = await fixture();
        await initializeDatabase(state.stateDirectory);
        const absentTransitionId = Bun.randomUUIDv7();
        const absentFailure = await Effect.runPromise(
            Effect.result(
                createVerifiedDatabaseSnapshot({
                    expectedState: "absent",
                    stateDirectory: state.stateDirectory,
                    transitionId: absentTransitionId,
                })
            )
        );
        expect(absentFailure._tag).toBe("Failure");

        const transitionId = Bun.randomUUIDv7();
        const tamperFailure = await withProcessUmask(0o022, () =>
            rejectionError(
                Effect.runPromise(
                    createVerifiedDatabaseSnapshot(
                        {
                            expectedState: "present",
                            migrationsDirectory,
                            releaseId,
                            stateDirectory: state.stateDirectory,
                            transitionId,
                        },
                        {
                            afterSnapshotCreated: async (snapshotFile) => {
                                const snapshotStatus = await stat(snapshotFile);
                                expect(snapshotStatus.mode & 0o777).toBe(0o600);
                                await writeFile(snapshotFile, "tampered");
                            },
                        }
                    )
                )
            )
        );

        expect(tamperFailure).toBeInstanceOf(DatabaseSnapshotError);
        expect(await readdir(state.backupsDirectory)).toEqual([]);

        const replacementFailure = await withProcessUmask(0o022, () =>
            rejectionError(
                Effect.runPromise(
                    createVerifiedDatabaseSnapshot(
                        {
                            expectedState: "present",
                            migrationsDirectory,
                            releaseId,
                            stateDirectory: state.stateDirectory,
                            transitionId: Bun.randomUUIDv7(),
                        },
                        { afterSnapshotFileOpen: unlink }
                    )
                )
            )
        );
        expect(replacementFailure).toBeInstanceOf(DatabaseSnapshotError);
        expect(await readdir(state.backupsDirectory)).toEqual([]);
    });
});
