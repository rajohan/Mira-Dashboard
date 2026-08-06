import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, ManagedRuntime } from "effect";

import { withDeploymentLease } from "../../../../scripts/delivery/deploymentLease.ts";
import { prepareProtectedProductionStatePath } from "../../../../scripts/delivery/productionStateFilesystem.ts";
import { rejectionError } from "../../../../scripts/testSupport/rejection.ts";
import { parseDatabaseSnapshotManifest } from "../../../shared/databaseSnapshotManifest.ts";
import { databaseRuntimeLayer } from "./databaseService.ts";
import {
    createVerifiedDatabaseSnapshot,
    DatabaseSnapshotError,
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

describe("verified database snapshots", () => {
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
        for (const suffix of ["-journal", "-shm", "-wal"] as const) {
            expect(
                await stat(
                    path.join(state.stateDirectory, `mira-dashboard.db${suffix}`)
                ).catch(() => null)
            ).toBeNull();
        }
    });

    test("fails closed on expectation mismatch and removes only its owned stage", async () => {
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
        const tamperFailure = await rejectionError(
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
                        afterSnapshotCreated: (snapshotFile) =>
                            writeFile(snapshotFile, "tampered"),
                    }
                )
            )
        );

        expect(tamperFailure).toBeInstanceOf(DatabaseSnapshotError);
        expect(await readdir(state.backupsDirectory)).toEqual([]);
    });
});
