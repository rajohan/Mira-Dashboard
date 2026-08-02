import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isPlainRecord } from "../../../../contracts/runtime.ts";
import {
    assertMiraDatabasePathSafeForEnvironment,
    getMiraDatabasePath,
} from "../../database.ts";
import { readAppliedDatabaseMigrationHistory } from "../../databaseMigrationRunner.ts";
import type { DatabaseMigrationIdentity } from "../../databaseMigrations/index.ts";
import {
    configuredDashboardProjectPaths,
    resolveDashboardProjectPaths,
    resolveDashboardRuntimePath,
} from "../../lib/dashboardPaths.ts";
import { guardedPath, writeTextNoFollowGuarded } from "../../lib/guardedOps.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";
import {
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY,
    type DashboardReleaseManifest,
    loadReleaseManifest,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./manifest.ts";
import { hasManagedBunRuntime, isBunRuntimeVersion } from "./runtime.ts";
import { MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT } from "./systemdPolicy.ts";

export const MANAGED_RELEASES_DIRECTORY_NAME = "releases";

export const RELEASE_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
export const RELEASE_TRANSITION_FORMAT_VERSION = 1;
export const RELEASE_TRANSITION_JOURNAL_FILE_NAME = ".release-transition.json";
export const RELEASE_TRANSITION_LOCK_FILE_NAME = ".release-transition.lock";
export const RETIRED_RELEASE_DIRECTORY_PATTERN =
    /^\.retired-[\da-f]{40}-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
export const STAGING_RELEASE_DIRECTORY_PATTERN =
    /^\.staging-([\da-f]{40})-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
export const STALE_STAGING_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;
export const RELEASE_PUBLICATION_LOCK_WAIT_MS = 2 * 60 * 1000;
const RELEASE_TRANSITION_LOCK_RETRY_MS = 50;
const MAX_RELEASE_TRANSITION_FILE_BYTES = 4096;
export const RELEASE_TRANSITION_LOCK_PROGRAM = "/usr/bin/flock";

export type ReleaseLinkName = "current" | "previous";

export interface ManagedDashboardRelease {
    commitSha: string;
    directoryIdentity: string;
    manifest: DashboardReleaseManifest;
    manifestIdentity: string;
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

export interface DashboardReleaseRetentionResult {
    removed: string[];
    removedRuntimes: string[];
    retained: string[];
    retainedRuntimes: string[];
    warnings: string[];
}

export interface DashboardReleaseRuntimeAvailabilityOptions {
    hasRuntime?: (version: string) => boolean;
}

export interface DashboardReleaseTransitionPreparation {
    rollback: () => Promise<void>;
}

export interface DashboardReleaseManagerOptions extends DashboardReleaseRuntimeAvailabilityOptions {
    prepareReleaseTransition?: (
        target: ManagedDashboardRelease
    ) => Promise<DashboardReleaseTransitionPreparation>;
    readLiveSchemaState?: (
        maximumCompatibleVersion: number
    ) => DashboardLiveSchemaState | Promise<DashboardLiveSchemaState>;
    schemaCutoverMode?: "coordinated";
    transitionLockWaitMs?: number;
}

export interface DashboardReleaseRollbackExpectation {
    currentCommitSha: string;
    targetCommitSha: string;
}

export interface DashboardReleaseRollbackOptions extends DashboardReleaseManagerOptions {
    expected?: DashboardReleaseRollbackExpectation;
}

export interface DashboardReleaseFailedActivationRestoreExpectation {
    candidateCommitSha: string;
    previousCommitSha?: string;
    rollbackCommitSha: string;
}

export interface DashboardReleaseFailedActivationRestoreOptions extends DashboardReleaseManagerOptions {
    expected: DashboardReleaseFailedActivationRestoreExpectation;
}

export interface DashboardReleasePublicationOptions {
    onTransitionLockContention?: () => void;
    prepareManifest?: (manifest: DashboardReleaseManifest) => Promise<void>;
}

export interface DashboardLiveSchemaState {
    migrations: DatabaseMigrationIdentity[];
    version: number;
}

export interface ReleaseLinkState {
    current: false | string;
    previous: false | string;
}

export interface ReleaseTransitionJournal {
    after: ReleaseLinkState;
    before: ReleaseLinkState;
    formatVersion: 1;
    operation: "activate" | "restore" | "rollback";
}

export interface ReleaseTransitionJournalSnapshot {
    device: number;
    inode: number;
    journal: ReleaseTransitionJournal;
}

export function compareStrings(left: string, right: string): number {
    return left.localeCompare(right);
}

export function assertReleaseCommitSha(commitSha: string): void {
    if (!RELEASE_COMMIT_SHA_PATTERN.test(commitSha)) {
        throw new TypeError("Managed release commit must be a full lowercase Git SHA");
    }
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

export async function syncDirectory(directoryPath: string): Promise<void> {
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

export async function syncFile(filePath: string): Promise<void> {
    const file = await fsp.open(filePath, fs.constants.O_RDONLY);
    try {
        await file.sync();
    } finally {
        await file.close();
    }
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
    const actual = Object.keys(record).toSorted(compareStrings);
    const sortedExpected = expected.toSorted(compareStrings);
    return (
        actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index])
    );
}

function parseOptionalCommitSha(value: unknown): false | string {
    if (value === false) {
        return false;
    }
    if (typeof value !== "string" || !RELEASE_COMMIT_SHA_PATTERN.test(value)) {
        throw new TypeError("Release transition contains an invalid commit SHA");
    }
    return value;
}

function parseReleaseLinkState(value: unknown): ReleaseLinkState {
    if (!isPlainRecord(value) || !hasExactKeys(value, ["current", "previous"])) {
        throw new TypeError("Release transition contains an invalid link state");
    }
    const state = {
        current: parseOptionalCommitSha(value.current),
        previous: parseOptionalCommitSha(value.previous),
    };
    if (!state.current && state.previous) {
        throw new TypeError("Release transition cannot have previous without current");
    }
    if (state.current && state.current === state.previous) {
        throw new TypeError("Release transition requires distinct release slots");
    }
    return state;
}

function parseReleaseTransitionJournal(value: unknown): ReleaseTransitionJournal {
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, ["after", "before", "formatVersion", "operation"]) ||
        value.formatVersion !== RELEASE_TRANSITION_FORMAT_VERSION ||
        (value.operation !== "activate" &&
            value.operation !== "restore" &&
            value.operation !== "rollback")
    ) {
        throw new TypeError("Release transition journal is invalid");
    }
    const before = parseReleaseLinkState(value.before);
    const after = parseReleaseLinkState(value.after);
    if (!after.current || after.current === before.current) {
        throw new TypeError("Release transition journal does not change current");
    }
    if (value.operation === "activate") {
        if (after.previous !== before.current) {
            throw new TypeError("Activation journal has an invalid rollback slot");
        }
    } else if (value.operation === "rollback") {
        if (
            !before.current ||
            !before.previous ||
            after.current !== before.previous ||
            after.previous !== before.current
        ) {
            throw new TypeError("Rollback journal has an invalid release swap");
        }
    } else if (!before.current || !before.previous || after.current !== before.previous) {
        throw new TypeError(
            "Failed activation restore journal has an invalid release state"
        );
    }
    return {
        after,
        before,
        formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
        operation: value.operation,
    };
}

async function readBoundedControlFile(filePath: string): Promise<
    | {
          device: number;
          inode: number;
          serialized: string;
      }
    | undefined
> {
    let file: fs.promises.FileHandle;
    try {
        file = await fsp.open(
            filePath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    try {
        const stat = await file.stat();
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size === 0 ||
            stat.size > MAX_RELEASE_TRANSITION_FILE_BYTES
        ) {
            throw new TypeError(
                "Release transition control file must be a bounded regular file"
            );
        }
        return {
            device: stat.dev,
            inode: stat.ino,
            serialized: await file.readFile("utf8"),
        };
    } finally {
        await file.close();
    }
}

export async function readReleaseTransitionJournal(
    layout: DashboardReleaseLayout
): Promise<ReleaseTransitionJournalSnapshot | undefined> {
    const file = await readBoundedControlFile(
        path.join(layout.root, RELEASE_TRANSITION_JOURNAL_FILE_NAME)
    );
    return file
        ? {
              device: file.device,
              inode: file.inode,
              journal: parseReleaseTransitionJournal(
                  JSON.parse(file.serialized) as unknown
              ),
          }
        : undefined;
}

export async function removeReleaseTransitionControlFile(
    layout: DashboardReleaseLayout,
    fileName: string,
    expected?: { device: number; inode: number }
): Promise<void> {
    const filePath = path.join(layout.root, fileName);
    let stat: fs.Stats;
    try {
        stat = await fsp.lstat(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (expected !== undefined &&
            (stat.dev !== expected.device || stat.ino !== expected.inode))
    ) {
        throw new TypeError("Release transition control file identity changed");
    }
    await fsp.unlink(filePath);
    await syncDirectory(layout.root);
}

export async function writeReleaseTransitionJournal(
    layout: DashboardReleaseLayout,
    journal: ReleaseTransitionJournal
): Promise<ReleaseTransitionJournalSnapshot> {
    const journalPath = path.join(layout.root, RELEASE_TRANSITION_JOURNAL_FILE_NAME);
    try {
        await fsp.lstat(journalPath);
        throw new Error("Release transition journal already exists");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    await writeTextNoFollowGuarded(
        guardedPath(journalPath),
        `${JSON.stringify(journal)}\n`,
        0o600
    );
    const snapshot = await readReleaseTransitionJournal(layout);
    if (!snapshot) {
        throw new Error("Release transition journal disappeared after creation");
    }
    return snapshot;
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

function readLiveDatabaseSchemaState(
    maximumCompatibleVersion: number
): DashboardLiveSchemaState {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    const database = new Database(databasePath, { readonly: true });
    try {
        database.run("PRAGMA busy_timeout = 5000");
        const migrations = readAppliedDatabaseMigrationHistory(
            database,
            maximumCompatibleVersion
        );
        return {
            migrations,
            version: migrations.length,
        };
    } finally {
        database.close();
    }
}

function assertLiveSchemaState(value: DashboardLiveSchemaState): void {
    if (
        !Number.isSafeInteger(value.version) ||
        value.version < 0 ||
        !Array.isArray(value.migrations) ||
        value.migrations.length !== value.version ||
        value.migrations.some(
            (migration, index) =>
                migration.version !== index + 1 ||
                !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(migration.name) ||
                !/^[\da-f]{64}$/u.test(migration.checksum)
        )
    ) {
        throw new TypeError("Live SQLite schema state is invalid");
    }
}

export async function resolveLiveSchemaState(
    options: DashboardReleaseManagerOptions,
    maximumCompatibleVersion: number
): Promise<DashboardLiveSchemaState> {
    const readLiveSchemaState =
        options.readLiveSchemaState ?? readLiveDatabaseSchemaState;
    const state = await readLiveSchemaState(maximumCompatibleVersion);
    assertLiveSchemaState(state);
    return state;
}

export function assertReleaseMigrationHistoryCompatible(
    release: DashboardReleaseManifest,
    liveState: DashboardLiveSchemaState,
    action: "Activation" | "Rollback"
): void {
    const expectedMigrations = release.schema.migrations;
    for (const actual of liveState.migrations.slice(0, release.schema.target)) {
        const expected = expectedMigrations[actual.version - 1];
        if (
            !expected ||
            actual.name !== expected.name ||
            actual.checksum !== expected.checksum
        ) {
            throw new Error(
                `${action} release SQLite migration ${actual.version} identity does not match live history`
            );
        }
    }
}

export function assertReleaseCanOpenLiveSchema(
    release: DashboardReleaseManifest,
    liveSchemaVersion: number,
    action: "Activation" | "Rollback"
): void {
    if (
        liveSchemaVersion < release.schema.minimumCompatible ||
        liveSchemaVersion > release.schema.maximumCompatible
    ) {
        throw new Error(
            `${action} release cannot open live SQLite schema ${liveSchemaVersion}`
        );
    }
}

export function assertDashboardReleaseRuntimeAvailable(
    release: ManagedDashboardRelease,
    options: DashboardReleaseRuntimeAvailabilityOptions = {}
): void {
    const releaseVersion = release.manifest.bunVersion;
    const hasRuntime = options.hasRuntime ?? hasManagedBunRuntime;
    if (!isBunRuntimeVersion(releaseVersion) || !hasRuntime(releaseVersion)) {
        throw new Error(
            `Release ${release.commitSha} requires unavailable managed Bun runtime ${releaseVersion}`
        );
    }
}

function requiresCurrentSchemaCutover(
    candidate: DashboardReleaseManifest,
    current: DashboardReleaseManifest
): boolean {
    return (
        candidate.schema.target < current.schema.minimumCompatible ||
        candidate.schema.target > current.schema.maximumCompatible
    );
}

function requiresLiveSchemaCutover(
    release: DashboardReleaseManifest,
    liveSchemaVersion: number
): boolean {
    return (
        liveSchemaVersion < release.schema.minimumCompatible &&
        liveSchemaVersion < release.schema.target
    );
}

export function assertReleaseActivationCompatible(
    candidate: DashboardReleaseManifest,
    current: DashboardReleaseManifest,
    schemaCutoverMode?: DashboardReleaseManagerOptions["schemaCutoverMode"]
): void {
    if (candidate.schema.target < current.schema.target) {
        throw new Error(
            "Forward activation cannot lower the managed SQLite schema target"
        );
    }
    const requiresCoordinatedCutover = requiresCurrentSchemaCutover(candidate, current);
    if (requiresCoordinatedCutover && schemaCutoverMode !== "coordinated") {
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
    rollback: DashboardReleaseManifest,
    liveSchemaVersion: number
): void {
    if (
        liveSchemaVersion < rollback.schema.minimumCompatible ||
        liveSchemaVersion > rollback.schema.maximumCompatible
    ) {
        throw new Error(
            `Rollback release cannot open SQLite schema ${liveSchemaVersion}`
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

/**
 * Verifies that a managed rollback release can open the live schema and agrees
 * with its applied migration history.
 */
export async function assertManagedDashboardReleaseRollbackSchemaCompatible(
    activeRelease: ManagedDashboardRelease,
    rollbackRelease: ManagedDashboardRelease,
    options: DashboardReleaseManagerOptions = {}
): Promise<void> {
    const maximumInspectableSchemaVersion = Math.max(
        DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
        activeRelease.manifest.schema.maximumCompatible,
        rollbackRelease.manifest.schema.maximumCompatible
    );
    const liveSchemaState = await resolveLiveSchemaState(
        options,
        maximumInspectableSchemaVersion
    );
    assertReleaseRollbackCompatible(
        activeRelease.manifest,
        rollbackRelease.manifest,
        liveSchemaState.version
    );
    assertReleaseMigrationHistoryCompatible(
        rollbackRelease.manifest,
        liveSchemaState,
        "Rollback"
    );
}

export function assertReleaseCanActivateLiveSchema(
    release: DashboardReleaseManifest,
    liveSchemaVersion: number,
    schemaCutoverMode?: DashboardReleaseManagerOptions["schemaCutoverMode"]
): void {
    if (
        schemaCutoverMode === "coordinated" &&
        requiresLiveSchemaCutover(release, liveSchemaVersion)
    ) {
        return;
    }
    assertReleaseCanOpenLiveSchema(release, liveSchemaVersion, "Activation");
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

async function openReleaseTransitionLockFile(
    layout: DashboardReleaseLayout
): Promise<fs.promises.FileHandle> {
    const lockPath = path.join(layout.root, RELEASE_TRANSITION_LOCK_FILE_NAME);
    const file = await fsp.open(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_RDWR,
        0o600
    );
    const descriptorStat = await file.stat();
    const pathStat = await fsp.lstat(lockPath);
    if (
        !descriptorStat.isFile() ||
        descriptorStat.nlink !== 1 ||
        !pathStat.isFile() ||
        pathStat.isSymbolicLink() ||
        pathStat.nlink !== 1 ||
        descriptorStat.dev !== pathStat.dev ||
        descriptorStat.ino !== pathStat.ino
    ) {
        await file.close();
        throw new TypeError("Release transition lock must be a single-link regular file");
    }
    return file;
}

export function isReleaseTransitionLockAvailable(): boolean {
    try {
        fs.accessSync(RELEASE_TRANSITION_LOCK_PROGRAM, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function assertReleaseTransitionLockCommandSucceeded(
    error: NodeJS.ErrnoException | undefined,
    status: number | null | undefined,
    stderr: string
): void {
    if (error) {
        throw new Error(
            error.code === "ENOENT"
                ? `Managed release transitions require executable ${RELEASE_TRANSITION_LOCK_PROGRAM}`
                : `Managed release transition lock failed: ${error.message}`,
            { cause: error }
        );
    }
    if (status === 0) {
        return;
    }
    if (status === 75) {
        throw new Error("Another managed release transition is in progress");
    }
    const diagnostic = stderr.trim();
    throw new Error(
        `Managed release transition lock exited ${status ?? "by signal"}${
            diagnostic ? `: ${diagnostic.slice(0, 1000)}` : ""
        }`
    );
}

async function acquireReleaseTransitionLock(
    layout: DashboardReleaseLayout,
    lockMode: "exclusive" | "shared",
    waitTimeoutMs = 0,
    onContention?: () => void
): Promise<fs.promises.FileHandle> {
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
        throw new RangeError(
            "Managed release transition lock wait must be a finite non-negative number"
        );
    }
    const deadline = Date.now() + waitTimeoutMs;
    while (true) {
        const lockFile = await openReleaseTransitionLockFile(layout);
        const result = spawnSync(
            RELEASE_TRANSITION_LOCK_PROGRAM,
            [
                lockMode === "exclusive" ? "--exclusive" : "--shared",
                "--nonblock",
                "--conflict-exit-code",
                "75",
                "3",
            ],
            {
                stdio: ["ignore", "ignore", "pipe", lockFile.fd],
            }
        );
        if (result.status === 0 && !result.error) {
            return lockFile;
        }
        await lockFile.close();
        if (result.status === 75 && Date.now() < deadline) {
            onContention?.();
            await Bun.sleep(
                Math.min(RELEASE_TRANSITION_LOCK_RETRY_MS, deadline - Date.now())
            );
            continue;
        }
        assertReleaseTransitionLockCommandSucceeded(
            result.error,
            result.status,
            result.stderr?.toString("utf8") ?? ""
        );
    }
}

export async function withReleaseTransitionLock<T>(
    layout: DashboardReleaseLayout,
    lockMode: "exclusive" | "shared",
    transition: () => Promise<T>,
    waitTimeoutMs = 0,
    onContention?: () => void
): Promise<T> {
    const lockFile = await acquireReleaseTransitionLock(
        layout,
        lockMode,
        waitTimeoutMs,
        onContention
    );
    let result: T | undefined;
    let transitionError: Error | undefined;
    try {
        result = await transition();
    } catch (primaryError) {
        transitionError =
            primaryError instanceof Error
                ? primaryError
                : new Error("Managed release transition failed", {
                      cause: primaryError,
                  });
    }
    try {
        await lockFile.close();
    } catch (cleanupError) {
        if (transitionError !== undefined) {
            const transitionFailure = new AggregateError(
                [transitionError, cleanupError],
                "Managed release transition failed and its lock could not be released",
                { cause: transitionError }
            );
            throw transitionFailure;
        }
        throw cleanupError;
    }
    if (transitionError !== undefined) {
        throw transitionError;
    }
    return result as T;
}

export async function withPreparedReleaseTransition<T>(
    target: ManagedDashboardRelease,
    options: DashboardReleaseManagerOptions,
    transition: () => Promise<T>
): Promise<T> {
    const preparation = await options.prepareReleaseTransition?.(target);
    try {
        return await transition();
    } catch (transitionError) {
        if (!preparation) {
            throw transitionError;
        }
        try {
            await preparation.rollback();
        } catch (rollbackError) {
            const transitionFailure = new AggregateError(
                [transitionError, rollbackError],
                "Managed release transition and preparation rollback failed",
                { cause: transitionError }
            );
            throw transitionFailure;
        }
        throw transitionError;
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
