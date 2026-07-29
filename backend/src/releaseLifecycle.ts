import { Database } from "bun:sqlite";

import {
    assertMiraDatabasePathSafeForEnvironment,
    getMiraDatabasePath,
} from "./database.ts";
import { validateDatabaseMigrationHistory } from "./databaseMigrationRunner.ts";
import { writeCliError, writeCliOutput } from "./lib/cliOutput.ts";
import type {
    DashboardReleaseManagerOptions,
    DashboardReleaseState,
} from "./releaseManager.ts";
import {
    activateDashboardRelease,
    pruneDashboardReleases,
    readDashboardReleaseState,
    resolveDashboardReleasesRoot,
    restoreDashboardReleaseAfterFailedActivation,
    rollbackDashboardRelease,
} from "./releaseManager.ts";
import {
    createVerifiedSqliteCutoverSnapshot,
    didDiscardSqliteCutoverSnapshot,
    restoreVerifiedSqliteCutoverSnapshot,
    verifySqliteCutoverSnapshot,
} from "./sqliteBackup.ts";

const COORDINATED_SCHEMA_CUTOVER_FLAG = "--coordinated-schema-cutover";
const RELEASE_TRANSITION_LOCK_WAIT_MS = 30_000;

function summarizeDashboardRelease(release: DashboardReleaseState["current"]) {
    return release
        ? {
              commitSha: release.commitSha,
              commitTitle: release.manifest.commitTitle,
              path: release.path,
              schema: release.manifest.schema,
          }
        : undefined;
}

function releaseSummary(state: DashboardReleaseState) {
    return {
        current: summarizeDashboardRelease(state.current),
        previous: summarizeDashboardRelease(state.previous),
        root: state.root,
    };
}

function requireSnapshotId(arguments_: string[], command: string): string {
    const [snapshotId] = arguments_;
    if (!snapshotId || arguments_.length !== 1) {
        throw new TypeError(
            `Release lifecycle ${command} requires exactly one snapshot id`
        );
    }
    return snapshotId;
}

function createCutoverDatabaseSnapshot(snapshotId: string) {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    const sourceDatabase = new Database(databasePath, { readonly: true });
    try {
        sourceDatabase.run("PRAGMA busy_timeout = 5000");
        validateDatabaseMigrationHistory(sourceDatabase);
        const snapshot = createVerifiedSqliteCutoverSnapshot(
            sourceDatabase,
            databasePath,
            snapshotId,
            { validateRestore: validateDatabaseMigrationHistory }
        );
        return {
            bytes: snapshot.bytes,
            createdAt: snapshot.createdAt,
            snapshotId,
        };
    } finally {
        sourceDatabase.close();
    }
}

function restoreCutoverDatabaseSnapshot(snapshotId: string) {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    const snapshot = restoreVerifiedSqliteCutoverSnapshot(databasePath, snapshotId, {
        validateRestore: validateDatabaseMigrationHistory,
    });
    return {
        bytes: snapshot.bytes,
        restored: true,
        snapshotId,
    };
}

function discardCutoverDatabaseSnapshot(snapshotId: string) {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    return {
        discarded: didDiscardSqliteCutoverSnapshot(databasePath, snapshotId),
        snapshotId,
    };
}

function verifyCutoverDatabaseSnapshot(snapshotId: string) {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    const snapshot = verifySqliteCutoverSnapshot(databasePath, snapshotId, {
        validateRestore: validateDatabaseMigrationHistory,
    });
    return {
        bytes: snapshot.bytes,
        snapshotId,
        verified: true,
    };
}

export async function runReleaseLifecycleCommand(
    arguments_: string[],
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
) {
    const [command, ...commandArguments] = arguments_;
    if (command === "snapshot-database") {
        return createCutoverDatabaseSnapshot(
            requireSnapshotId(commandArguments, command)
        );
    }
    if (command === "restore-database") {
        return restoreCutoverDatabaseSnapshot(
            requireSnapshotId(commandArguments, command)
        );
    }
    if (command === "discard-database-snapshot") {
        return discardCutoverDatabaseSnapshot(
            requireSnapshotId(commandArguments, command)
        );
    }
    if (command === "verify-database-snapshot") {
        return verifyCutoverDatabaseSnapshot(
            requireSnapshotId(commandArguments, command)
        );
    }
    const [commitSha, ...extra] = commandArguments;
    const isCoordinatedSchemaCutover =
        command === "activate" &&
        extra.length === 1 &&
        extra[0] === COORDINATED_SCHEMA_CUTOVER_FLAG;

    let state: DashboardReleaseState;
    const transitionOptions: DashboardReleaseManagerOptions = {
        ...options,
        transitionLockWaitMs:
            options.transitionLockWaitMs ?? RELEASE_TRANSITION_LOCK_WAIT_MS,
    };
    switch (command) {
        case "activate": {
            if (!isCoordinatedSchemaCutover && extra.length > 0) {
                throw new TypeError(
                    "Release lifecycle command received unexpected arguments"
                );
            }
            if (!commitSha) {
                throw new TypeError("Release lifecycle activate requires a commit SHA");
            }
            state = await activateDashboardRelease(commitSha, releasesRoot, {
                ...transitionOptions,
                ...(isCoordinatedSchemaCutover && {
                    schemaCutoverMode: "coordinated" as const,
                }),
            });
            break;
        }
        case "rollback": {
            const [expectedCurrentCommitSha, expectedTargetCommitSha] = commandArguments;
            if (
                !expectedCurrentCommitSha ||
                !expectedTargetCommitSha ||
                commandArguments.length !== 2
            ) {
                throw new TypeError(
                    "Release lifecycle rollback requires expected current and target commit SHAs"
                );
            }
            state = await rollbackDashboardRelease(releasesRoot, {
                ...transitionOptions,
                expected: {
                    currentCommitSha: expectedCurrentCommitSha,
                    targetCommitSha: expectedTargetCommitSha,
                },
            });
            break;
        }
        case "restore": {
            const [
                expectedCandidateCommitSha,
                expectedRollbackCommitSha,
                previousCommitSha,
            ] = commandArguments;
            if (
                !expectedCandidateCommitSha ||
                !expectedRollbackCommitSha ||
                commandArguments.length < 2 ||
                commandArguments.length > 3
            ) {
                throw new TypeError(
                    "Release lifecycle restore requires expected candidate and rollback commit SHAs, with an optional previous commit SHA"
                );
            }
            state = await restoreDashboardReleaseAfterFailedActivation(
                {
                    ...transitionOptions,
                    expected: {
                        candidateCommitSha: expectedCandidateCommitSha,
                        ...(previousCommitSha && { previousCommitSha }),
                        rollbackCommitSha: expectedRollbackCommitSha,
                    },
                },
                releasesRoot
            );
            break;
        }
        case "status": {
            if (commandArguments.length > 0) {
                throw new TypeError("Release lifecycle status takes no commit SHA");
            }
            state = await readDashboardReleaseState(releasesRoot, transitionOptions);
            break;
        }
        case "prune": {
            if (extra.length > 0) {
                throw new TypeError(
                    "Release lifecycle command received unexpected arguments"
                );
            }
            const retainCount = commitSha === undefined ? 3 : Number(commitSha);
            return pruneDashboardReleases(retainCount, releasesRoot);
        }
        default: {
            throw new TypeError(
                "Usage: releaseLifecycle.js <status|activate COMMIT_SHA [--coordinated-schema-cutover]|snapshot-database SNAPSHOT_ID|verify-database-snapshot SNAPSHOT_ID|restore-database SNAPSHOT_ID|discard-database-snapshot SNAPSHOT_ID|restore EXPECTED_CANDIDATE_SHA EXPECTED_ROLLBACK_SHA [PREVIOUS_SHA]|rollback EXPECTED_CURRENT_SHA EXPECTED_TARGET_SHA|prune [RETAIN_COUNT]>"
            );
        }
    }
    return releaseSummary(state);
}

if (import.meta.main) {
    try {
        const result = await runReleaseLifecycleCommand(Bun.argv.slice(2));
        writeCliOutput(JSON.stringify(result));
    } catch (error) {
        writeCliError(
            error instanceof Error ? error.message : "Release lifecycle failed"
        );
        process.exitCode = 1;
    }
}
