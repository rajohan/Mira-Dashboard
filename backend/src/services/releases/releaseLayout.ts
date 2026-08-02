import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
    configuredDashboardProjectPaths,
    resolveDashboardProjectPaths,
    resolveDashboardRuntimePath,
} from "../../lib/dashboardPaths.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";
import {
    assertReleaseCommitSha,
    compareStrings,
    type DashboardReleaseLayout,
    type DashboardReleaseState,
    MANAGED_RELEASES_DIRECTORY_NAME,
    type ManagedDashboardRelease,
    RELEASE_COMMIT_SHA_PATTERN,
    RELEASE_TRANSITION_JOURNAL_FILE_NAME,
    type ReleaseLinkName,
    type ReleaseLinkState,
    type ReleaseTransitionJournalSnapshot,
} from "./managerModel.ts";
import {
    type DashboardReleaseManifest,
    loadReleaseManifest,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./manifest.ts";
import { MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT } from "./systemdPolicy.ts";
import {
    readReleaseTransitionJournal,
    removeReleaseTransitionControlFile,
    syncDirectory,
} from "./transitionJournal.ts";

async function assertRealDirectory(directoryPath: string): Promise<void> {
    const stat = await fsp.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError(
            `Managed release path must be a real directory: ${directoryPath}`
        );
    }
    const realPath = await fsp.realpath(directoryPath);
    if (realPath !== directoryPath) {
        throw new TypeError(
            `Managed release path must not traverse symlinks: ${directoryPath}`
        );
    }
}

export function resolveDashboardReleasesRoot(
    configuredRoot = resolveDashboardRuntimePath(
        configuredDashboardProjectPaths()?.productionReleasesRoot ??
            resolveDashboardProjectPaths({}).productionReleasesRoot,
        process.env.MIRA_DASHBOARD_RELEASES_ROOT
    ) ?? resolveDashboardProjectPaths({}).productionReleasesRoot
): string {
    return resolveAbsoluteNonRootPath(configuredRoot, "Dashboard releases root");
}

export async function ensureDashboardReleaseLayout(
    configuredRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseLayout> {
    const root = resolveAbsoluteNonRootPath(configuredRoot, "Dashboard releases root");
    const releasesPath = path.join(root, MANAGED_RELEASES_DIRECTORY_NAME);
    await assertRealDirectory(path.dirname(root));
    try {
        await fsp.mkdir(root, { mode: 0o755 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    }
    await assertRealDirectory(root);
    try {
        await fsp.mkdir(releasesPath, { mode: 0o755 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    }
    await assertRealDirectory(releasesPath);
    return { releasesPath, root };
}

export function managedReleasePath(releasesRoot: string, commitSha: string): string {
    assertReleaseCommitSha(commitSha);
    return path.join(
        resolveAbsoluteNonRootPath(releasesRoot, "Dashboard releases root"),
        MANAGED_RELEASES_DIRECTORY_NAME,
        commitSha
    );
}

export async function loadManagedReleaseFromLayout(
    layout: DashboardReleaseLayout,
    commitSha: string
): Promise<ManagedDashboardRelease> {
    assertReleaseCommitSha(commitSha);
    const releasePath = path.join(layout.releasesPath, commitSha);
    await assertRealDirectory(releasePath);
    const directoryBefore = await fsp.lstat(releasePath, { bigint: true });
    const manifest = await loadReleaseManifest(releasePath);
    await verifyReleaseArtifacts(releasePath, manifest);
    await verifyReleaseBuildIdentities(releasePath, manifest);
    const directoryAfter = await fsp.lstat(releasePath, { bigint: true });
    const directoryIdentityBefore = releaseDirectoryIdentity(directoryBefore);
    const directoryIdentityAfter = releaseDirectoryIdentity(directoryAfter);
    if (directoryIdentityAfter !== directoryIdentityBefore) {
        throw new Error(`Managed release directory changed while verifying ${commitSha}`);
    }
    if (manifest.commitSha !== commitSha) {
        throw new Error(
            `Managed release directory ${commitSha} contains manifest ${manifest.commitSha}`
        );
    }
    return {
        commitSha,
        directoryIdentity: directoryIdentityAfter,
        manifest,
        manifestIdentity: releaseManifestIdentity(manifest),
        path: releasePath,
    };
}

export function releaseDirectoryIdentity(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.ctimeNs, stat.birthtimeNs].join(":");
}

export function isSameReleaseDirectoryInode(
    left: fs.BigIntStats,
    right: fs.BigIntStats
): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.birthtimeNs === right.birthtimeNs
    );
}

function releaseManifestIdentity(manifest: DashboardReleaseManifest): string {
    const canonicalManifest = {
        artifacts: manifest.artifacts
            .map(({ path: artifactPath, sha256, sizeBytes }) => ({
                path: artifactPath,
                sha256,
                sizeBytes,
            }))
            .toSorted((left, right) => compareStrings(left.path, right.path)),
        builtAt: manifest.builtAt,
        bunVersion: manifest.bunVersion,
        commitSha: manifest.commitSha,
        commitShort: manifest.commitShort,
        commitTitle: manifest.commitTitle,
        components: {
            backendCommit: manifest.components.backendCommit,
            frontendCommit: manifest.components.frontendCommit,
        },
        formatVersion: manifest.formatVersion,
        schema: {
            maximumCompatible: manifest.schema.maximumCompatible,
            migrations: manifest.schema.migrations
                ?.map(({ checksum, name, version }) => ({
                    checksum,
                    name,
                    version,
                }))
                .toSorted((left, right) => left.version - right.version),
            migrationInventorySha256: manifest.schema.migrationInventorySha256,
            migrationRegistrySha256: manifest.schema.migrationRegistrySha256,
            minimumCompatible: manifest.schema.minimumCompatible,
            target: manifest.schema.target,
        },
    };
    return createHash("sha256").update(JSON.stringify(canonicalManifest)).digest("hex");
}

function isSameManagedReleaseSnapshot(
    actual: ManagedDashboardRelease,
    expected: ManagedDashboardRelease
): boolean {
    return (
        actual.commitSha === expected.commitSha &&
        actual.directoryIdentity === expected.directoryIdentity &&
        actual.manifestIdentity === expected.manifestIdentity
    );
}

export async function loadManagedRelease(
    releasesRoot: string,
    commitSha: string
): Promise<ManagedDashboardRelease> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return loadManagedReleaseFromLayout(layout, commitSha);
}

function releaseLinkTarget(commitSha: string): string {
    assertReleaseCommitSha(commitSha);
    return path.posix.join(MANAGED_RELEASES_DIRECTORY_NAME, commitSha);
}

function parseReleaseLinkTarget(target: string): string {
    const prefix = `${MANAGED_RELEASES_DIRECTORY_NAME}/`;
    if (!target.startsWith(prefix)) {
        throw new TypeError(`Managed release link target is invalid: ${target}`);
    }
    const commitSha = target.slice(prefix.length);
    if (
        !RELEASE_COMMIT_SHA_PATTERN.test(commitSha) ||
        target !== releaseLinkTarget(commitSha)
    ) {
        throw new TypeError(`Managed release link target is invalid: ${target}`);
    }
    return commitSha;
}

async function readReleaseLinkCommitSha(
    layout: DashboardReleaseLayout,
    linkName: ReleaseLinkName
): Promise<string | undefined> {
    const linkPath = path.join(layout.root, linkName);
    let stat: fs.Stats;
    try {
        stat = await fsp.lstat(linkPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    if (!stat.isSymbolicLink()) {
        throw new TypeError(`Managed release ${linkName} slot must be a symlink`);
    }

    const target = await fsp.readlink(linkPath);
    const commitSha = parseReleaseLinkTarget(target);
    const expectedPath = path.join(layout.releasesPath, commitSha);
    if ((await fsp.realpath(linkPath)) !== expectedPath) {
        throw new TypeError(`Managed release ${linkName} link escapes its layout`);
    }
    return commitSha;
}

async function readReleaseLink(
    layout: DashboardReleaseLayout,
    linkName: ReleaseLinkName
): Promise<ManagedDashboardRelease | undefined> {
    const commitSha = await readReleaseLinkCommitSha(layout, linkName);
    return commitSha ? loadManagedReleaseFromLayout(layout, commitSha) : undefined;
}

async function readRollbackReleaseLink(
    layout: DashboardReleaseLayout
): Promise<ManagedDashboardRelease | undefined> {
    const commitSha = await readReleaseLinkCommitSha(layout, "previous");
    if (!commitSha) return undefined;
    try {
        return await loadManagedReleaseFromLayout(layout, commitSha);
    } catch {
        // A structurally confined but unverifiable rollback slot is never runnable.
        // Keep the verified current release available and replace this slot on the
        // next successful activation.
        return undefined;
    }
}

async function assertReleaseLinkSlot(
    layout: DashboardReleaseLayout,
    linkName: ReleaseLinkName
): Promise<void> {
    try {
        const stat = await fsp.lstat(path.join(layout.root, linkName));
        if (!stat.isSymbolicLink()) {
            throw new TypeError(`Managed release ${linkName} slot must be a symlink`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

export async function replaceReleaseLink(
    layout: DashboardReleaseLayout,
    linkName: ReleaseLinkName,
    commitSha: string,
    expectedRelease: ManagedDashboardRelease
): Promise<void> {
    await assertReleaseLinkSlot(layout, linkName);
    const verifiedRelease = await loadManagedReleaseFromLayout(layout, commitSha);
    if (!isSameManagedReleaseSnapshot(verifiedRelease, expectedRelease)) {
        throw new Error(`Managed release snapshot changed before linking ${commitSha}`);
    }
    const temporaryPath = path.join(
        layout.root,
        `.${linkName}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
        await fsp.symlink(releaseLinkTarget(commitSha), temporaryPath, "dir");
        await fsp.rename(temporaryPath, path.join(layout.root, linkName));
        await syncDirectory(layout.root);
        try {
            const linkedRelease = await readReleaseLink(layout, linkName);
            if (
                !linkedRelease ||
                !isSameManagedReleaseSnapshot(linkedRelease, expectedRelease)
            ) {
                throw new Error("Linked release snapshot does not match");
            }
        } catch (error) {
            throw new Error(
                `Managed release snapshot changed while linking ${commitSha}`,
                { cause: error }
            );
        }
    } finally {
        await fsp.rm(temporaryPath, { force: true });
    }
}

async function removeReleaseLink(
    layout: DashboardReleaseLayout,
    linkName: ReleaseLinkName
): Promise<void> {
    const linkPath = path.join(layout.root, linkName);
    let stat: fs.Stats;
    try {
        stat = await fsp.lstat(linkPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
    if (!stat.isSymbolicLink()) {
        throw new TypeError(`Managed release ${linkName} slot must be a symlink`);
    }
    await fsp.unlink(linkPath);
    await syncDirectory(layout.root);
}

export async function readDashboardReleaseStateFromLayout(
    layout: DashboardReleaseLayout
): Promise<DashboardReleaseState> {
    const current = await readReleaseLink(layout, "current");
    const previous = await readRollbackReleaseLink(layout);
    if (!current && previous) {
        throw new Error("Managed release layout has previous without current");
    }
    return {
        ...(current && { current }),
        ...(previous && { previous }),
        root: layout.root,
    };
}

export async function readActivationReleaseStateFromLayout(
    layout: DashboardReleaseLayout
): Promise<DashboardReleaseState> {
    const current = await readReleaseLink(layout, "current");
    if (!current) {
        // An orphaned previous link is not a usable release state. Activation
        // canonicalizes it to an empty state through the transition journal.
        await assertReleaseLinkSlot(layout, "previous");
        return { root: layout.root };
    }
    const previous = await readRollbackReleaseLink(layout);
    return {
        current,
        ...(previous && { previous }),
        root: layout.root,
    };
}

export function releaseLinkStateFromDashboardState(
    state: DashboardReleaseState
): ReleaseLinkState {
    return {
        current: state.current?.commitSha ?? false,
        previous: state.previous?.commitSha ?? false,
    };
}

export function assertDashboardReleaseStateMatches(
    state: DashboardReleaseState,
    expected: ReleaseLinkState
): void {
    const actual = releaseLinkStateFromDashboardState(state);
    if (actual.current !== expected.current || actual.previous !== expected.previous) {
        throw new Error("Managed release transition did not reach its recorded state");
    }
}

async function validateReleaseLinkState(
    layout: DashboardReleaseLayout,
    state: ReleaseLinkState
): Promise<Map<string, ManagedDashboardRelease>> {
    const commits = new Set(
        [state.current, state.previous].filter(
            (commitSha): commitSha is string => typeof commitSha === "string"
        )
    );
    const releases = new Map<string, ManagedDashboardRelease>();
    for (const commitSha of commits) {
        releases.set(commitSha, await loadManagedReleaseFromLayout(layout, commitSha));
    }
    return releases;
}

export async function applyReleaseLinkState(
    layout: DashboardReleaseLayout,
    state: ReleaseLinkState,
    expectedReleases?: Map<string, ManagedDashboardRelease>
): Promise<void> {
    const releases = expectedReleases ?? (await validateReleaseLinkState(layout, state));
    await (state.current
        ? replaceReleaseLink(
              layout,
              "current",
              state.current,
              requireValidatedRelease(releases, state.current)
          )
        : removeReleaseLink(layout, "current"));
    await (state.previous
        ? replaceReleaseLink(
              layout,
              "previous",
              state.previous,
              requireValidatedRelease(releases, state.previous)
          )
        : removeReleaseLink(layout, "previous"));
}

function requireValidatedRelease(
    releases: Map<string, ManagedDashboardRelease>,
    commitSha: string
): ManagedDashboardRelease {
    const release = releases.get(commitSha);
    if (!release) {
        throw new Error(`Managed release validation result is missing ${commitSha}`);
    }
    return release;
}

export async function restoreInterruptedReleaseTransition(
    layout: DashboardReleaseLayout,
    snapshot: ReleaseTransitionJournalSnapshot
): Promise<void> {
    await applyReleaseLinkState(layout, snapshot.journal.before);
    const restored = await readDashboardReleaseStateFromLayout(layout);
    assertDashboardReleaseStateMatches(restored, snapshot.journal.before);
    await removeReleaseTransitionControlFile(
        layout,
        RELEASE_TRANSITION_JOURNAL_FILE_NAME,
        snapshot
    );
}

export async function recoverInterruptedReleaseTransition(
    layout: DashboardReleaseLayout
): Promise<void> {
    const snapshot = await readReleaseTransitionJournal(layout);
    if (snapshot) {
        await restoreInterruptedReleaseTransition(layout, snapshot);
    }
}

export async function ensureManagedLauncherExecutable(
    release: ManagedDashboardRelease
): Promise<void> {
    await fsp.chmod(
        path.join(release.path, MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT),
        0o755
    );
}
