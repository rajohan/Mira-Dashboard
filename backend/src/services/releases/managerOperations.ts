import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
    applyReleaseLinkState,
    assertDashboardReleaseRuntimeAvailable,
    assertDashboardReleaseStateMatches,
    assertManagedDashboardReleaseRollbackSchemaCompatible,
    assertReleaseActivationCompatible,
    assertReleaseCanActivateLiveSchema,
    assertReleaseCommitSha,
    assertReleaseMigrationHistoryCompatible,
    compareStrings,
    ensureDashboardReleaseLayout,
    ensureManagedLauncherExecutable,
    isSameReleaseDirectoryInode,
    loadManagedReleaseFromLayout,
    readActivationReleaseStateFromLayout,
    readDashboardReleaseStateFromLayout,
    readReleaseTransitionJournal,
    recoverInterruptedReleaseTransition,
    releaseDirectoryIdentity,
    releaseLinkStateFromDashboardState,
    removeReleaseTransitionControlFile,
    replaceReleaseLink,
    resolveDashboardReleasesRoot,
    resolveLiveSchemaState,
    restoreInterruptedReleaseTransition,
    RETIRED_RELEASE_DIRECTORY_PATTERN,
    RELEASE_COMMIT_SHA_PATTERN,
    RELEASE_PUBLICATION_LOCK_WAIT_MS,
    RELEASE_TRANSITION_FORMAT_VERSION,
    RELEASE_TRANSITION_JOURNAL_FILE_NAME,
    type DashboardReleaseFailedActivationRestoreOptions,
    type DashboardReleaseLayout,
    type DashboardReleaseManagerOptions,
    type DashboardReleasePublicationOptions,
    type DashboardReleaseRetentionResult,
    type DashboardReleaseRollbackOptions,
    type DashboardReleaseState,
    type ManagedDashboardRelease,
    type ReleaseTransitionJournal,
    STAGING_RELEASE_DIRECTORY_PATTERN,
    STALE_STAGING_RELEASE_AGE_MS,
    syncDirectory,
    syncFile,
    withPreparedReleaseTransition,
    withReleaseTransitionLock,
    writeReleaseTransitionJournal,
} from "./managerCore.ts";
import {
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY,
    loadReleaseManifest,
    RELEASE_MANIFEST_FILE_NAME,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./manifest.ts";
import { hasManagedBunRuntime, pruneManagedBunRuntimes } from "./runtime.ts";
import { MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT } from "./systemdPolicy.ts";

/**
 * Copies a verified build into the immutable release store while excluding
 * activation, rollback, pruning, and another publisher from its staging path.
 * @param buildRoot Build root value.
 * @param commitSha Commit sha value.
 * @param releasesRoot Releases root value.
 * @param options Operation options.
 * @returns Promise resolving to the publish verified dashboard release result.
 */
export async function publishVerifiedDashboardRelease(
    buildRoot: string,
    commitSha: string,
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleasePublicationOptions = {}
): Promise<ManagedDashboardRelease> {
    assertReleaseCommitSha(commitSha);
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    const manifest = await loadReleaseManifest(buildRoot);
    await verifyReleaseArtifacts(buildRoot, manifest);
    await verifyReleaseBuildIdentities(buildRoot, manifest);
    if (manifest.commitSha !== commitSha) {
        throw new Error(
            `Built release identity ${manifest.commitSha} does not match ${commitSha}`
        );
    }

    return withReleaseTransitionLock(
        layout,
        "exclusive",
        async () => {
            await recoverInterruptedReleaseTransition(layout);
            await options.prepareManifest?.(manifest);
            let existingRelease: ManagedDashboardRelease | undefined;
            try {
                existingRelease = await loadManagedReleaseFromLayout(layout, commitSha);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
            if (existingRelease) {
                await ensureManagedLauncherExecutable(existingRelease);
                return existingRelease;
            }

            const finalPath = path.join(layout.releasesPath, commitSha);
            const stagingPath = path.join(
                layout.releasesPath,
                `.staging-${commitSha}-${randomUUID()}`
            );
            await fsp.mkdir(stagingPath, { mode: 0o755 });
            try {
                const files = [
                    ...manifest.artifacts.map((artifact) => artifact.path),
                    RELEASE_MANIFEST_FILE_NAME,
                ];
                const createdDirectories = new Set<string>([stagingPath]);
                for (const relativePath of files) {
                    const sourcePath = path.join(buildRoot, relativePath);
                    const destinationPath = path.join(stagingPath, relativePath);
                    const destinationDirectory = path.dirname(destinationPath);
                    await fsp.mkdir(destinationDirectory, {
                        mode: 0o755,
                        recursive: true,
                    });
                    for (
                        let directory = destinationDirectory;
                        directory.startsWith(`${stagingPath}${path.sep}`);
                        directory = path.dirname(directory)
                    ) {
                        createdDirectories.add(directory);
                    }
                    await fsp.copyFile(
                        sourcePath,
                        destinationPath,
                        fs.constants.COPYFILE_EXCL
                    );
                    if (relativePath === MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT) {
                        await fsp.chmod(destinationPath, 0o755);
                    }
                    await syncFile(destinationPath);
                }

                const stagedManifest = await loadReleaseManifest(stagingPath);
                await verifyReleaseArtifacts(stagingPath, stagedManifest);
                await verifyReleaseBuildIdentities(stagingPath, stagedManifest);
                if (stagedManifest.commitSha !== commitSha) {
                    throw new Error(
                        `Staged release identity ${stagedManifest.commitSha} does not match ${commitSha}`
                    );
                }
                const deepestFirst = [...createdDirectories].toSorted(
                    (left, right) => right.length - left.length
                );
                for (const directory of deepestFirst) {
                    await syncDirectory(directory);
                }
                try {
                    await fsp.rename(stagingPath, finalPath);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code !== "EEXIST" && code !== "ENOTEMPTY") {
                        throw error;
                    }
                    // A publisher from an older process may have won the same SHA.
                    const concurrentlyPublished = await loadManagedReleaseFromLayout(
                        layout,
                        commitSha
                    );
                    await ensureManagedLauncherExecutable(concurrentlyPublished);
                    await fsp.rm(stagingPath, { recursive: true });
                    await syncDirectory(layout.releasesPath);
                    return concurrentlyPublished;
                }
                await syncDirectory(layout.releasesPath);
            } catch (error) {
                await fsp.rm(stagingPath, { force: true, recursive: true });
                throw error;
            }
            return loadManagedReleaseFromLayout(layout, commitSha);
        },
        RELEASE_PUBLICATION_LOCK_WAIT_MS,
        options.onTransitionLockContention
    );
}

async function executeReleaseTransition(
    layout: DashboardReleaseLayout,
    journal: ReleaseTransitionJournal,
    apply: () => Promise<void>
): Promise<DashboardReleaseState> {
    const snapshot = await writeReleaseTransitionJournal(layout, journal);
    try {
        await apply();
        const state = await readDashboardReleaseStateFromLayout(layout);
        assertDashboardReleaseStateMatches(state, journal.after);
        await removeReleaseTransitionControlFile(
            layout,
            RELEASE_TRANSITION_JOURNAL_FILE_NAME,
            snapshot
        );
        return state;
    } catch (error) {
        try {
            await restoreInterruptedReleaseTransition(layout, snapshot);
        } catch (recoveryError) {
            const transitionFailure = new AggregateError(
                [error, recoveryError],
                "Managed release transition and recovery both failed",
                { cause: error }
            );
            throw transitionFailure;
        }
        throw error;
    }
}

export async function readDashboardReleaseState(
    releasesRoot = resolveDashboardReleasesRoot(),
    options: Pick<DashboardReleaseManagerOptions, "transitionLockWaitMs"> = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "shared",
        async () => {
            if (await readReleaseTransitionJournal(layout)) {
                throw new Error(
                    "Managed release status requires activate, restore, or rollback to recover an interrupted transition"
                );
            }
            return readDashboardReleaseStateFromLayout(layout);
        },
        options.transitionLockWaitMs
    );
}

export async function activateDashboardRelease(
    commitSha: string,
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "exclusive",
        async () => {
            await recoverInterruptedReleaseTransition(layout);
            const candidate = await loadManagedReleaseFromLayout(layout, commitSha);
            assertDashboardReleaseRuntimeAvailable(candidate, options);
            const state = await readActivationReleaseStateFromLayout(layout);
            if (state.current) {
                assertReleaseActivationCompatible(
                    candidate.manifest,
                    state.current.manifest,
                    options.schemaCutoverMode
                );
            } else if (options.schemaCutoverMode === "coordinated") {
                throw new Error(
                    "Coordinated schema cutover mode requires an active current release"
                );
            }
            const maximumInspectableSchemaVersion = Math.max(
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
                candidate.manifest.schema.maximumCompatible,
                state.current?.manifest.schema.maximumCompatible ?? 0
            );
            const liveSchemaState = await resolveLiveSchemaState(
                options,
                maximumInspectableSchemaVersion
            );
            assertReleaseCanActivateLiveSchema(
                candidate.manifest,
                liveSchemaState.version,
                options.schemaCutoverMode
            );
            assertReleaseMigrationHistoryCompatible(
                candidate.manifest,
                liveSchemaState,
                "Activation"
            );
            return withPreparedReleaseTransition(candidate, options, async () => {
                if (state.current?.commitSha === candidate.commitSha) {
                    return state;
                }

                const before = releaseLinkStateFromDashboardState(state);
                const journal: ReleaseTransitionJournal = {
                    after: {
                        current: candidate.commitSha,
                        previous: before.current,
                    },
                    before,
                    formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
                    operation: "activate",
                };
                return await executeReleaseTransition(layout, journal, async () => {
                    const expectedReleases = new Map<string, ManagedDashboardRelease>([
                        [candidate.commitSha, candidate],
                    ]);
                    if (state.current) {
                        expectedReleases.set(state.current.commitSha, state.current);
                    }
                    await applyReleaseLinkState(layout, journal.after, expectedReleases);
                });
            });
        },
        options.transitionLockWaitMs
    );
}

export async function rollbackDashboardRelease(
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseRollbackOptions = {}
): Promise<DashboardReleaseState> {
    const expectation = options.expected;
    if (expectation) {
        assertReleaseCommitSha(expectation.currentCommitSha);
        assertReleaseCommitSha(expectation.targetCommitSha);
        if (expectation.currentCommitSha === expectation.targetCommitSha) {
            throw new TypeError(
                "Managed release rollback expectation requires distinct releases"
            );
        }
    }
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "exclusive",
        async () => {
            await recoverInterruptedReleaseTransition(layout);
            const state = await readDashboardReleaseStateFromLayout(layout);
            if (!state.current || !state.previous) {
                throw new Error("Managed release rollback requires current and previous");
            }
            if (state.current.commitSha === state.previous.commitSha) {
                throw new Error(
                    "Managed release rollback requires two distinct releases"
                );
            }
            if (
                expectation &&
                (state.current.commitSha !== expectation.currentCommitSha ||
                    state.previous.commitSha !== expectation.targetCommitSha)
            ) {
                throw new Error(
                    "Managed release rollback slots changed before the guarded transition"
                );
            }

            const activeRelease = state.current;
            const rollbackRelease = state.previous;
            assertDashboardReleaseRuntimeAvailable(rollbackRelease, options);
            await assertManagedDashboardReleaseRollbackSchemaCompatible(
                activeRelease,
                rollbackRelease,
                options
            );

            const before = releaseLinkStateFromDashboardState(state);
            const journal: ReleaseTransitionJournal = {
                after: {
                    current: rollbackRelease.commitSha,
                    previous: activeRelease.commitSha,
                },
                before,
                formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
                operation: "rollback",
            };
            return withPreparedReleaseTransition(rollbackRelease, options, async () =>
                executeReleaseTransition(layout, journal, async () => {
                    await replaceReleaseLink(
                        layout,
                        "current",
                        rollbackRelease.commitSha,
                        rollbackRelease
                    );
                    await replaceReleaseLink(
                        layout,
                        "previous",
                        activeRelease.commitSha,
                        activeRelease
                    );
                })
            );
        },
        options.transitionLockWaitMs
    );
}

/**
 * Restores the exact current/previous snapshot that existed before a failed
 * activation. Unlike a manual rollback, the failed candidate is not retained
 * in the previous slot.
 * @returns Promise resolving to the restore dashboard release after failed activation result.
 */
export async function restoreDashboardReleaseAfterFailedActivation(
    options: DashboardReleaseFailedActivationRestoreOptions,
    releasesRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseState> {
    const { candidateCommitSha, previousCommitSha, rollbackCommitSha } = options.expected;
    assertReleaseCommitSha(candidateCommitSha);
    assertReleaseCommitSha(rollbackCommitSha);
    if (previousCommitSha) {
        assertReleaseCommitSha(previousCommitSha);
    }
    if (
        candidateCommitSha === rollbackCommitSha ||
        rollbackCommitSha === previousCommitSha
    ) {
        throw new TypeError(
            "Failed activation restore requires distinct managed releases"
        );
    }

    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "exclusive",
        async () => {
            await recoverInterruptedReleaseTransition(layout);
            const state = await readDashboardReleaseStateFromLayout(layout);
            if (
                state.current?.commitSha === rollbackCommitSha &&
                state.previous?.commitSha === previousCommitSha
            ) {
                assertDashboardReleaseRuntimeAvailable(state.current, options);
                await assertManagedDashboardReleaseRollbackSchemaCompatible(
                    state.current,
                    state.current,
                    options
                );
                return withPreparedReleaseTransition(state.current, options, () =>
                    Promise.resolve(state)
                );
            }
            if (
                state.current?.commitSha !== candidateCommitSha ||
                state.previous?.commitSha !== rollbackCommitSha
            ) {
                throw new Error(
                    "Managed release slots changed before the failed activation restore"
                );
            }

            const candidateRelease = state.current;
            const rollbackRelease = state.previous;
            assertDashboardReleaseRuntimeAvailable(rollbackRelease, options);
            const restoredPreviousRelease = previousCommitSha
                ? await loadManagedReleaseFromLayout(layout, previousCommitSha)
                : undefined;
            await assertManagedDashboardReleaseRollbackSchemaCompatible(
                candidateRelease,
                rollbackRelease,
                options
            );

            const before = releaseLinkStateFromDashboardState(state);
            const journal: ReleaseTransitionJournal = {
                after: {
                    current: rollbackCommitSha,
                    previous: previousCommitSha ?? false,
                },
                before,
                formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
                operation: "restore",
            };
            return withPreparedReleaseTransition(rollbackRelease, options, () =>
                executeReleaseTransition(layout, journal, async () => {
                    const expectedReleases = new Map<string, ManagedDashboardRelease>([
                        [candidateCommitSha, candidateRelease],
                        [rollbackCommitSha, rollbackRelease],
                    ]);
                    if (restoredPreviousRelease) {
                        expectedReleases.set(
                            restoredPreviousRelease.commitSha,
                            restoredPreviousRelease
                        );
                    }
                    await applyReleaseLinkState(layout, journal.after, expectedReleases);
                })
            );
        },
        options.transitionLockWaitMs
    );
}

export async function pruneDashboardReleases(
    retainCount = 3,
    releasesRoot = resolveDashboardReleasesRoot(),
    runtimeRoot?: string
): Promise<DashboardReleaseRetentionResult> {
    if (!Number.isSafeInteger(retainCount) || retainCount < 3 || retainCount > 20) {
        throw new TypeError("Managed release retention must be between 3 and 20");
    }

    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(layout, "exclusive", async () => {
        await recoverInterruptedReleaseTransition(layout);
        const state = await readDashboardReleaseStateFromLayout(layout);
        const protectedCommits = new Set(
            [state.current?.commitSha, state.previous?.commitSha].filter(
                (commitSha): commitSha is string => commitSha !== undefined
            )
        );
        const entries = await fsp.readdir(layout.releasesPath, {
            withFileTypes: true,
        });
        let hasFilesystemChanges = false;
        const releases: Array<{
            publishedAtNs: bigint;
            release: ManagedDashboardRelease;
        }> = [];
        const warnings: string[] = [];
        for (const entry of entries) {
            if (RETIRED_RELEASE_DIRECTORY_PATTERN.test(entry.name)) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) {
                    throw new TypeError(
                        `Retired release entry must be a real directory: ${entry.name}`
                    );
                }
                await fsp.rm(path.join(layout.releasesPath, entry.name), {
                    recursive: true,
                });
                hasFilesystemChanges = true;
                continue;
            }
            const stagingMatch = STAGING_RELEASE_DIRECTORY_PATTERN.exec(entry.name);
            if (stagingMatch) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) {
                    throw new TypeError(
                        `Staging release entry must be a real directory: ${entry.name}`
                    );
                }
                const stagingPath = path.join(layout.releasesPath, entry.name);
                const stagingStat = await fsp.lstat(stagingPath, { bigint: true });
                const staleBeforeNs =
                    BigInt(Math.max(0, Date.now() - STALE_STAGING_RELEASE_AGE_MS)) *
                    1_000_000n;
                if (stagingStat.mtimeNs > staleBeforeNs) {
                    continue;
                }
                const currentStat = await fsp.lstat(stagingPath, { bigint: true });
                if (
                    !currentStat.isDirectory() ||
                    currentStat.isSymbolicLink() ||
                    !isSameReleaseDirectoryInode(stagingStat, currentStat)
                ) {
                    throw new Error(
                        `Staging release changed before cleanup: ${entry.name}`
                    );
                }
                const retiredPath = path.join(
                    layout.releasesPath,
                    `.retired-${stagingMatch[1]}-${randomUUID()}`
                );
                await fsp.rename(stagingPath, retiredPath);
                await syncDirectory(layout.releasesPath);
                const retiredStat = await fsp.lstat(retiredPath, { bigint: true });
                if (
                    !retiredStat.isDirectory() ||
                    retiredStat.isSymbolicLink() ||
                    !isSameReleaseDirectoryInode(currentStat, retiredStat)
                ) {
                    throw new Error(
                        `Staging release changed during cleanup: ${entry.name}`
                    );
                }
                await fsp.rm(retiredPath, { recursive: true });
                hasFilesystemChanges = true;
                continue;
            }
            if (!RELEASE_COMMIT_SHA_PATTERN.test(entry.name)) {
                continue;
            }
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                throw new TypeError(
                    `Managed release entry must be a real directory: ${entry.name}`
                );
            }
            try {
                const release = await loadManagedReleaseFromLayout(layout, entry.name);
                const directoryStat = await fsp.lstat(release.path, { bigint: true });
                if (
                    !directoryStat.isDirectory() ||
                    directoryStat.isSymbolicLink() ||
                    releaseDirectoryIdentity(directoryStat) !== release.directoryIdentity
                ) {
                    throw new Error(
                        `Managed release changed before retention ordering: ${entry.name}`
                    );
                }
                releases.push({
                    publishedAtNs: directoryStat.birthtimeNs,
                    release,
                });
            } catch (error) {
                if (protectedCommits.has(entry.name)) {
                    throw error;
                }
                warnings.push(`Skipped unverifiable release ${entry.name}`);
            }
        }

        const newestFirst = releases.toSorted((left, right) => {
            if (left.release.manifest.builtAt !== right.release.manifest.builtAt) {
                return left.release.manifest.builtAt < right.release.manifest.builtAt
                    ? 1
                    : -1;
            }
            if (left.publishedAtNs === right.publishedAtNs) {
                // Once the build and filesystem publication timestamps tie,
                // the SHA is a deterministic fallback rather than a recency signal.
                if (left.release.commitSha === right.release.commitSha) {
                    return 0;
                }
                return left.release.commitSha < right.release.commitSha ? 1 : -1;
            }
            return left.publishedAtNs < right.publishedAtNs ? 1 : -1;
        });
        const retained = new Set(protectedCommits);
        for (const { release } of newestFirst) {
            if (retained.size >= retainCount) {
                break;
            }
            retained.add(release.commitSha);
        }
        const retainedReleases = newestFirst
            .map(({ release }) => release)
            .filter((release) => retained.has(release.commitSha));
        const retainedRuntimeVersions = new Set(
            retainedReleases.map((release) => release.manifest.bunVersion)
        );
        if (runtimeRoot) {
            for (const version of retainedRuntimeVersions) {
                if (!hasManagedBunRuntime(version, runtimeRoot)) {
                    throw new Error(
                        `Retained release requires unavailable managed Bun runtime ${version}`
                    );
                }
            }
        }

        const removed: string[] = [];
        for (const { release } of newestFirst.toReversed()) {
            if (retained.has(release.commitSha)) {
                continue;
            }
            const currentStat = await fsp.lstat(release.path, { bigint: true });
            if (
                !currentStat.isDirectory() ||
                currentStat.isSymbolicLink() ||
                releaseDirectoryIdentity(currentStat) !== release.directoryIdentity
            ) {
                throw new Error(
                    `Managed release changed before retention cleanup: ${release.commitSha}`
                );
            }
            const retiredPath = path.join(
                layout.releasesPath,
                `.retired-${release.commitSha}-${randomUUID()}`
            );
            await fsp.rename(release.path, retiredPath);
            await syncDirectory(layout.releasesPath);
            const retiredStat = await fsp.lstat(retiredPath, { bigint: true });
            if (
                !retiredStat.isDirectory() ||
                retiredStat.isSymbolicLink() ||
                !isSameReleaseDirectoryInode(currentStat, retiredStat)
            ) {
                throw new Error(
                    `Managed release changed during retention cleanup: ${release.commitSha}`
                );
            }
            await fsp.rm(retiredPath, { recursive: true });
            hasFilesystemChanges = true;
            removed.push(release.commitSha);
        }
        if (hasFilesystemChanges) {
            await syncDirectory(layout.releasesPath);
        }

        const runtimeRetention = runtimeRoot
            ? await pruneManagedBunRuntimes(retainedRuntimeVersions, runtimeRoot)
            : { removed: [], retained: [], warnings: [] };
        return {
            removed,
            removedRuntimes: runtimeRetention.removed,
            retained: retainedReleases.map((release) => release.commitSha),
            retainedRuntimes: runtimeRetention.retained,
            warnings: [...warnings, ...runtimeRetention.warnings].toSorted(
                compareStrings
            ),
        };
    });
}
