import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
    assertReleaseCommitSha,
    RELEASE_PUBLICATION_LOCK_WAIT_MS,
    type DashboardReleasePublicationOptions,
    type ManagedDashboardRelease,
} from "./managerModel.ts";
import {
    loadReleaseManifest,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./manifestArtifacts.ts";
import { RELEASE_MANIFEST_FILE_NAME } from "./manifestPolicy.ts";
import {
    ensureDashboardReleaseLayout,
    ensureManagedLauncherExecutable,
    loadManagedReleaseFromLayout,
    recoverInterruptedReleaseTransition,
    resolveDashboardReleasesRoot,
} from "./releaseLayout.ts";
import { MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT } from "./systemdPolicy.ts";
import { syncDirectory, syncFile } from "./transitionJournal.ts";
import { withReleaseTransitionLock } from "./transitionLock.ts";

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
