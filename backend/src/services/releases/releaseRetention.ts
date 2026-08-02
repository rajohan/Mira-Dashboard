import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { pruneManagedBunRuntimes } from "./managedRuntimeStore.ts";
import {
    compareStrings,
    RELEASE_COMMIT_SHA_PATTERN,
    RETIRED_RELEASE_DIRECTORY_PATTERN,
    STAGING_RELEASE_DIRECTORY_PATTERN,
    STALE_STAGING_RELEASE_AGE_MS,
    type DashboardReleaseRetentionResult,
    type ManagedDashboardRelease,
} from "./managerModel.ts";
import {
    ensureDashboardReleaseLayout,
    isSameReleaseDirectoryInode,
    loadManagedReleaseFromLayout,
    readDashboardReleaseStateFromLayout,
    recoverInterruptedReleaseTransition,
    releaseDirectoryIdentity,
    resolveDashboardReleasesRoot,
} from "./releaseLayout.ts";
import { hasManagedBunRuntime } from "./runtime.ts";
import { syncDirectory } from "./transitionJournal.ts";
import { withReleaseTransitionLock } from "./transitionLock.ts";

/**
 * Removes stale staging directories and unprotected immutable releases while
 * preserving the configured number of release/runtime pairs.
 * @param retainCount Number of release commits to retain.
 * @param releasesRoot Managed releases root.
 * @param runtimeRoot Optional managed runtime root.
 * @returns Release and runtime retention summary.
 */
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
