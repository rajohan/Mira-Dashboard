import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
    type DashboardReleaseManifest,
    loadReleaseManifest,
    verifyReleaseArtifacts,
} from "./releaseManifest.ts";

export const DEFAULT_DASHBOARD_RELEASES_ROOT =
    "/home/ubuntu/projects/mira-dashboard-releases";
export const MANAGED_RELEASES_DIRECTORY_NAME = "releases";

const RELEASE_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;

export type ReleaseLinkName = "current" | "previous";

export interface ManagedDashboardRelease {
    commitSha: string;
    manifest: DashboardReleaseManifest;
    path: string;
}

export interface DashboardReleaseLayout {
    releasesPath: string;
    root: string;
}

export interface DashboardReleaseState {
    current?: ManagedDashboardRelease;
    previous?: ManagedDashboardRelease;
    root: string;
}

function assertReleaseCommitSha(commitSha: string): void {
    if (!RELEASE_COMMIT_SHA_PATTERN.test(commitSha)) {
        throw new TypeError("Managed release commit must be a full lowercase Git SHA");
    }
}

function assertAbsoluteNonRootPath(value: string): string {
    if (!value || value.includes("\0") || !path.isAbsolute(value)) {
        throw new TypeError("Dashboard releases root must be an absolute non-root path");
    }
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError("Dashboard releases root must be an absolute non-root path");
    }
    return resolved;
}

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

async function syncDirectory(directoryPath: string): Promise<void> {
    const directory = await fsp.open(
        directoryPath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
    );
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

export function resolveDashboardReleasesRoot(
    configuredRoot = process.env.MIRA_DASHBOARD_RELEASES_ROOT ??
        DEFAULT_DASHBOARD_RELEASES_ROOT
): string {
    return assertAbsoluteNonRootPath(configuredRoot.trim());
}

export async function ensureDashboardReleaseLayout(
    configuredRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseLayout> {
    const root = assertAbsoluteNonRootPath(configuredRoot);
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
        assertAbsoluteNonRootPath(releasesRoot),
        MANAGED_RELEASES_DIRECTORY_NAME,
        commitSha
    );
}

async function loadManagedReleaseFromLayout(
    layout: DashboardReleaseLayout,
    commitSha: string
): Promise<ManagedDashboardRelease> {
    assertReleaseCommitSha(commitSha);
    const releasePath = path.join(layout.releasesPath, commitSha);
    await assertRealDirectory(releasePath);
    const manifest = await loadReleaseManifest(releasePath);
    await verifyReleaseArtifacts(releasePath, manifest);
    if (manifest.commitSha !== commitSha) {
        throw new Error(
            `Managed release directory ${commitSha} contains manifest ${manifest.commitSha}`
        );
    }
    return {
        commitSha,
        manifest,
        path: releasePath,
    };
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

async function readReleaseLink(
    layout: DashboardReleaseLayout,
    linkName: ReleaseLinkName
): Promise<ManagedDashboardRelease | undefined> {
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
    return loadManagedReleaseFromLayout(layout, commitSha);
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

async function replaceReleaseLink(
    layout: DashboardReleaseLayout,
    linkName: ReleaseLinkName,
    commitSha: string
): Promise<void> {
    await assertReleaseLinkSlot(layout, linkName);
    const temporaryPath = path.join(
        layout.root,
        `.${linkName}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
        await fsp.symlink(releaseLinkTarget(commitSha), temporaryPath, "dir");
        await fsp.rename(temporaryPath, path.join(layout.root, linkName));
        await syncDirectory(layout.root);
    } finally {
        await fsp.rm(temporaryPath, { force: true });
    }
}

function assertHostRuntimeCompatible(release: ManagedDashboardRelease): void {
    if (release.manifest.bunVersion !== Bun.version) {
        throw new Error(
            `Release ${release.commitSha} requires Bun ${release.manifest.bunVersion}; host runs ${Bun.version}`
        );
    }
}

export function assertReleaseActivationCompatible(
    candidate: DashboardReleaseManifest,
    current: DashboardReleaseManifest
): void {
    if (candidate.schema.target < current.schema.target) {
        throw new Error(
            "Forward activation cannot lower the managed SQLite schema target"
        );
    }
    if (
        candidate.schema.target < current.schema.minimumCompatible ||
        candidate.schema.target > current.schema.maximumCompatible
    ) {
        throw new Error(
            `Current release cannot roll back after SQLite schema ${candidate.schema.target}`
        );
    }
    if (
        candidate.schema.target === current.schema.target &&
        candidate.schema.migrationRegistrySha256 !==
            current.schema.migrationRegistrySha256
    ) {
        throw new Error(
            "Release migration registry changed without a new SQLite schema version"
        );
    }
}

export function assertReleaseRollbackCompatible(
    active: DashboardReleaseManifest,
    rollback: DashboardReleaseManifest
): void {
    if (
        active.schema.target < rollback.schema.minimumCompatible ||
        active.schema.target > rollback.schema.maximumCompatible
    ) {
        throw new Error(
            `Rollback release cannot open SQLite schema ${active.schema.target}`
        );
    }
    if (
        active.schema.target === rollback.schema.target &&
        active.schema.migrationRegistrySha256 !== rollback.schema.migrationRegistrySha256
    ) {
        throw new Error(
            "Rollback release has a different migration registry for the live SQLite schema"
        );
    }
}

async function readDashboardReleaseStateFromLayout(
    layout: DashboardReleaseLayout
): Promise<DashboardReleaseState> {
    const current = await readReleaseLink(layout, "current");
    const previous = await readReleaseLink(layout, "previous");
    if (!current && previous) {
        throw new Error("Managed release layout has previous without current");
    }
    return {
        ...(current && { current }),
        ...(previous && { previous }),
        root: layout.root,
    };
}

export async function readDashboardReleaseState(
    releasesRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return readDashboardReleaseStateFromLayout(layout);
}

export async function activateDashboardRelease(
    commitSha: string,
    releasesRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    const candidate = await loadManagedReleaseFromLayout(layout, commitSha);
    assertHostRuntimeCompatible(candidate);

    const state = await readDashboardReleaseStateFromLayout(layout);
    if (state.current?.commitSha === candidate.commitSha) {
        return state;
    }
    if (state.current) {
        assertReleaseActivationCompatible(candidate.manifest, state.current.manifest);
        await replaceReleaseLink(layout, "previous", state.current.commitSha);
    }
    await replaceReleaseLink(layout, "current", candidate.commitSha);
    return readDashboardReleaseStateFromLayout(layout);
}

export async function rollbackDashboardRelease(
    releasesRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    const state = await readDashboardReleaseStateFromLayout(layout);
    if (!state.current || !state.previous) {
        throw new Error("Managed release rollback requires current and previous");
    }
    if (state.current.commitSha === state.previous.commitSha) {
        throw new Error("Managed release rollback requires two distinct releases");
    }

    assertHostRuntimeCompatible(state.previous);
    assertReleaseRollbackCompatible(state.current.manifest, state.previous.manifest);

    await replaceReleaseLink(layout, "current", state.previous.commitSha);
    await replaceReleaseLink(layout, "previous", state.current.commitSha);
    return readDashboardReleaseStateFromLayout(layout);
}
