import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, ManagedRuntime } from "effect";

import {
    databaseCandidateMigrationLayer,
    databaseRuntimeLayer,
} from "../../src/server/database/runtime/databaseService.ts";
import {
    createVerifiedDatabaseSnapshot,
    type DatabaseSnapshotResult,
} from "../../src/server/database/runtime/databaseSnapshot.ts";
import { migrationManifest } from "../../src/shared/databaseMigrationManifest.ts";
import { parseProductionActivationTransition } from "../../src/shared/productionActivationTransition.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import {
    discardDatabaseTransitionWorkspace,
    inspectDatabaseTransitionRecovery,
    prepareDatabaseTransitionWorkspace,
    prepareDatabaseRollbackCandidate,
    promoteDatabaseTransitionCandidate,
    restorePromotedDatabaseState,
    verifyDatabaseTransitionCandidate,
} from "./databaseTransitionFilesystem.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";

const migrationsDirectory = path.resolve(import.meta.dir, "../../migrations");
const initialReleaseId = "a".repeat(40);
const candidateReleaseId = "b".repeat(40);
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
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-db-transition-"));
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return { paths, state };
}

async function initializeLiveDatabase(stateDirectory: string): Promise<void> {
    const runtime = ManagedRuntime.make(
        databaseRuntimeLayer({
            migrationsDirectory,
            releaseId: initialReleaseId,
            startupMode: "initialize-empty",
            stateDirectory,
        })
    );
    runtimes.push(runtime);
    await runtime.context();
    await runtime.dispose();
}

async function maintainCandidate(
    stateDirectory: string,
    releaseId = candidateReleaseId
): Promise<void> {
    const runtime = ManagedRuntime.make(
        databaseCandidateMigrationLayer({
            migrationsDirectory,
            releaseId,
            stateDirectory,
        })
    );
    runtimes.push(runtime);
    await runtime.context();
    await runtime.dispose();
}

async function snapshot(
    stateDirectory: string,
    transitionId: string,
    expectedState: "absent" | "present"
): Promise<DatabaseSnapshotResult> {
    return Effect.runPromise(
        createVerifiedDatabaseSnapshot(
            expectedState === "absent"
                ? { expectedState, stateDirectory, transitionId }
                : {
                      expectedState,
                      migrationsDirectory,
                      releaseId: initialReleaseId,
                      stateDirectory,
                      transitionId,
                  }
        )
    );
}

describe("database transition filesystem", () => {
    test("promotes a newly initialized candidate over expected absent live state", async () => {
        const { paths } = await fixture();
        const transitionId = Bun.randomUUIDv7();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const previous = await snapshot(paths.stateDirectory, transitionId, "absent");
            const workspace = await prepareDatabaseTransitionWorkspace(
                lease,
                paths,
                transitionId,
                previous
            );
            await maintainCandidate(workspace.candidateDirectory);
            const candidate = await verifyDatabaseTransitionCandidate(workspace);
            const promoted = await promoteDatabaseTransitionCandidate(
                lease,
                paths,
                candidate
            );
            expect(promoted.previous).toEqual(previous);
            await discardDatabaseTransitionWorkspace(lease, paths, workspace);
        });

        const liveDatabase = path.join(paths.stateDirectory, "mira-dashboard.db");
        const database = new Database(liveDatabase, { readonly: true, strict: true });
        try {
            expect(
                database
                    .query<{ count: number }, []>(
                        "SELECT COUNT(*) AS count FROM schema_migrations"
                    )
                    .get()
            ).toEqual({ count: migrationManifest.length });
        } finally {
            database.close(true);
        }
        const stateEntries = await readdir(paths.stateDirectory);
        expect(
            stateEntries.filter((entry) => entry.startsWith(".database-transition-"))
        ).toEqual([]);
    });

    test("copies a verified snapshot and rejects live identity drift before promotion", async () => {
        const { paths } = await fixture();
        await initializeLiveDatabase(paths.stateDirectory);
        const transitionId = Bun.randomUUIDv7();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const previous = await snapshot(
                paths.stateDirectory,
                transitionId,
                "present"
            );
            if (previous.state !== "present") throw new Error("Expected snapshot");
            const workspace = await prepareDatabaseTransitionWorkspace(
                lease,
                paths,
                transitionId,
                previous
            );
            await maintainCandidate(workspace.candidateDirectory);
            const candidate = await verifyDatabaseTransitionCandidate(workspace);
            const liveDatabase = path.join(paths.stateDirectory, "mira-dashboard.db");
            await chmod(liveDatabase, 0o400);

            const failure = await rejectionError(
                promoteDatabaseTransitionCandidate(lease, paths, candidate)
            );
            expect(failure.message).toBe(
                "Database transition filesystem operation failed"
            );
            expect(await stat(workspace.candidateDatabase)).toBeDefined();
            await chmod(liveDatabase, 0o600);
            await discardDatabaseTransitionWorkspace(lease, paths, workspace);
        });
    });

    test("restores the previous release database from its immutable snapshot", async () => {
        const { paths } = await fixture();
        await initializeLiveDatabase(paths.stateDirectory);
        const transitionId = Bun.randomUUIDv7();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const previous = await snapshot(
                paths.stateDirectory,
                transitionId,
                "present"
            );
            if (previous.state !== "present") throw new Error("Expected snapshot");
            const workspace = await prepareDatabaseTransitionWorkspace(
                lease,
                paths,
                transitionId,
                previous
            );
            await maintainCandidate(workspace.candidateDirectory);
            const candidate = await verifyDatabaseTransitionCandidate(workspace);
            const promoted = await promoteDatabaseTransitionCandidate(
                lease,
                paths,
                candidate
            );

            await prepareDatabaseRollbackCandidate(promoted, workspace);
            const recovery = await inspectDatabaseTransitionRecovery(
                lease,
                paths,
                parseProductionActivationTransition({
                    candidate: {
                        releaseId: candidateReleaseId,
                        runtimeRevision: "c".repeat(40),
                    },
                    formatVersion: 1,
                    phase: "rollback-required",
                    previousActivation: {
                        current: {
                            releaseId: initialReleaseId,
                            runtimeRevision: "c".repeat(40),
                        },
                        formatVersion: 1,
                        previous: null,
                        transitionId: Bun.randomUUIDv7(),
                    },
                    previousDatabase: {
                        manifest: previous.manifest,
                        sourceDatabase: previous.sourceDatabase,
                        state: "present",
                    },
                    transitionId,
                })
            );
            if (recovery.state !== "promoted") {
                throw new Error("Expected promoted recovery state");
            }
            await prepareDatabaseRollbackCandidate(recovery.promoted, recovery.workspace);
            await maintainCandidate(
                recovery.workspace.candidateDirectory,
                initialReleaseId
            );
            const rollbackCandidate = await verifyDatabaseTransitionCandidate(
                recovery.workspace
            );
            await restorePromotedDatabaseState(
                lease,
                paths,
                recovery.promoted,
                rollbackCandidate
            );
            await discardDatabaseTransitionWorkspace(lease, paths, recovery.workspace);
        });

        const restored = new Database(
            path.join(paths.stateDirectory, "mira-dashboard.db"),
            { readonly: true, strict: true }
        );
        try {
            expect(
                restored
                    .query<{ releaseId: string }, []>(
                        "SELECT release_id AS releaseId FROM schema_migrations"
                    )
                    .get()
            ).toEqual({ releaseId: initialReleaseId });
        } finally {
            restored.close(true);
        }
    });
});
