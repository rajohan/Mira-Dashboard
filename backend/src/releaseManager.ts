import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { Database } from "bun:sqlite";

import {
    assertMiraDatabasePathSafeForEnvironment,
    getMiraDatabasePath,
} from "./database.ts";
import { readAppliedDatabaseMigrationHistory } from "./databaseMigrationRunner.ts";
import type { DatabaseMigrationIdentity } from "./databaseMigrations/index.ts";
import { guardedPath, writeTextNoFollowGuarded } from "./lib/guardedOps.ts";
import { resolveAbsoluteNonRootPath } from "./lib/safePath.ts";
import {
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY,
    type DashboardReleaseManifest,
    loadReleaseManifest,
    RELEASE_MANIFEST_FILE_NAME,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./releaseManifest.ts";

export const DEFAULT_DASHBOARD_RELEASES_ROOT =
    "/home/ubuntu/projects/mira-dashboard-releases";
export const MANAGED_RELEASES_DIRECTORY_NAME = "releases";

const RELEASE_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const RELEASE_TRANSITION_FORMAT_VERSION = 1;
const RELEASE_TRANSITION_JOURNAL_FILE_NAME = ".release-transition.json";
export const RELEASE_TRANSITION_LOCK_FILE_NAME = ".release-transition.lock";
const RETIRED_RELEASE_DIRECTORY_PATTERN =
    /^\.retired-[\da-f]{40}-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const STAGING_RELEASE_DIRECTORY_PATTERN =
    /^\.staging-([\da-f]{40})-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const STALE_STAGING_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;
const RELEASE_PUBLICATION_LOCK_WAIT_MS = 2 * 60 * 1000;
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
    retained: string[];
    warnings: string[];
}

export interface DashboardReleaseManagerOptions {
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
}

export interface DashboardLiveSchemaState {
    migrations: DatabaseMigrationIdentity[];
    version: number;
}

interface ReleaseLinkState {
    current: false | string;
    previous: false | string;
}

interface ReleaseTransitionJournal {
    after: ReleaseLinkState;
    before: ReleaseLinkState;
    formatVersion: 1;
    operation: "activate" | "restore" | "rollback";
}

interface ReleaseTransitionJournalSnapshot {
    device: number;
    inode: number;
    journal: ReleaseTransitionJournal;
}

function compareStrings(left: string, right: string): number {
    return left.localeCompare(right);
}

function assertReleaseCommitSha(commitSha: string): void {
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

async function syncFile(filePath: string): Promise<void> {
    const file = await fsp.open(filePath, fs.constants.O_RDONLY);
    try {
        await file.sync();
    } finally {
        await file.close();
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
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

async function readReleaseTransitionJournal(
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

async function removeReleaseTransitionControlFile(
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

async function writeReleaseTransitionJournal(
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
    configuredRoot = process.env.MIRA_DASHBOARD_RELEASES_ROOT ??
        DEFAULT_DASHBOARD_RELEASES_ROOT
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

async function loadManagedReleaseFromLayout(
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

function releaseDirectoryIdentity(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.ctimeNs, stat.birthtimeNs].join(":");
}

function isSameReleaseDirectoryInode(
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

async function readLiveDatabaseSchemaState(
    maximumCompatibleVersion: number
): Promise<DashboardLiveSchemaState> {
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

async function resolveLiveSchemaState(
    options: DashboardReleaseManagerOptions,
    maximumCompatibleVersion: number
): Promise<DashboardLiveSchemaState> {
    const readLiveSchemaState =
        options.readLiveSchemaState ?? readLiveDatabaseSchemaState;
    const state = await readLiveSchemaState(maximumCompatibleVersion);
    assertLiveSchemaState(state);
    return state;
}

function assertReleaseMigrationHistoryCompatible(
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

export function assertDashboardReleaseHostRuntimeCompatible(
    release: ManagedDashboardRelease
): void {
    if (release.manifest.bunVersion !== Bun.version) {
        throw new Error(
            `Release ${release.commitSha} requires Bun ${release.manifest.bunVersion}; host runs ${Bun.version}`
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

function assertReleaseCanActivateLiveSchema(
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

async function readActivationReleaseStateFromLayout(
    layout: DashboardReleaseLayout
): Promise<DashboardReleaseState> {
    const current = await readReleaseLink(layout, "current");
    if (!current) {
        // An orphaned previous link is not a usable release state. Activation
        // canonicalizes it to an empty state through the transition journal.
        await assertReleaseLinkSlot(layout, "previous");
        return { root: layout.root };
    }
    const previous = await readReleaseLink(layout, "previous");
    return {
        current,
        ...(previous && { previous }),
        root: layout.root,
    };
}

function releaseLinkStateFromDashboardState(
    state: DashboardReleaseState
): ReleaseLinkState {
    return {
        current: state.current?.commitSha ?? false,
        previous: state.previous?.commitSha ?? false,
    };
}

function assertDashboardReleaseStateMatches(
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

async function applyReleaseLinkState(
    layout: DashboardReleaseLayout,
    state: ReleaseLinkState,
    expectedReleases?: Map<string, ManagedDashboardRelease>
): Promise<void> {
    const releases = expectedReleases ?? (await validateReleaseLinkState(layout, state));
    if (state.current) {
        await replaceReleaseLink(
            layout,
            "current",
            state.current,
            requireValidatedRelease(releases, state.current)
        );
    } else {
        await removeReleaseLink(layout, "current");
    }
    if (state.previous) {
        await replaceReleaseLink(
            layout,
            "previous",
            state.previous,
            requireValidatedRelease(releases, state.previous)
        );
    } else {
        await removeReleaseLink(layout, "previous");
    }
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

async function restoreInterruptedReleaseTransition(
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

async function recoverInterruptedReleaseTransition(
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
            result.error as NodeJS.ErrnoException | undefined,
            result.status,
            result.stderr?.toString("utf8") ?? ""
        );
    }
}

async function withReleaseTransitionLock<T>(
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
    let transitionError: unknown;
    try {
        result = await transition();
    } catch (primaryError) {
        transitionError = primaryError;
    }
    try {
        await lockFile.close();
    } catch (cleanupError) {
        if (transitionError !== undefined) {
            throw new AggregateError(
                [transitionError, cleanupError],
                "Managed release transition failed and its lock could not be released",
                { cause: cleanupError }
            );
        }
        throw cleanupError;
    }
    if (transitionError !== undefined) {
        throw transitionError;
    }
    return result as T;
}

/**
 * Copies a verified build into the immutable release store while excluding
 * activation, rollback, pruning, and another publisher from its staging path.
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
            try {
                return await loadManagedReleaseFromLayout(layout, commitSha);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
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
            throw new AggregateError(
                [error, recoveryError],
                "Managed release transition and recovery both failed",
                { cause: recoveryError }
            );
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
            assertDashboardReleaseHostRuntimeCompatible(candidate);
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
            const requiresCoordinatedCutover =
                requiresLiveSchemaCutover(candidate.manifest, liveSchemaState.version) ||
                (state.current !== undefined &&
                    requiresCurrentSchemaCutover(
                        candidate.manifest,
                        state.current.manifest
                    ));
            if (
                !requiresCoordinatedCutover &&
                options.schemaCutoverMode === "coordinated"
            ) {
                throw new Error(
                    "Coordinated schema cutover mode requires an incompatible schema boundary"
                );
            }
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
            assertDashboardReleaseHostRuntimeCompatible(rollbackRelease);
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
            return await executeReleaseTransition(layout, journal, async () => {
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
            });
        },
        options.transitionLockWaitMs
    );
}

/**
 * Restores the exact current/previous snapshot that existed before a failed
 * activation. Unlike a manual rollback, the failed candidate is not retained
 * in the previous slot.
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
                state.current?.commitSha !== candidateCommitSha ||
                state.previous?.commitSha !== rollbackCommitSha
            ) {
                throw new Error(
                    "Managed release slots changed before the failed activation restore"
                );
            }

            const candidateRelease = state.current;
            const rollbackRelease = state.previous;
            assertDashboardReleaseHostRuntimeCompatible(rollbackRelease);
            const restoredPreviousRelease = previousCommitSha
                ? await loadManagedReleaseFromLayout(layout, previousCommitSha)
                : undefined;
            const maximumInspectableSchemaVersion = Math.max(
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
                candidateRelease.manifest.schema.maximumCompatible,
                rollbackRelease.manifest.schema.maximumCompatible
            );
            const liveSchemaState = await resolveLiveSchemaState(
                options,
                maximumInspectableSchemaVersion
            );
            assertReleaseRollbackCompatible(
                candidateRelease.manifest,
                rollbackRelease.manifest,
                liveSchemaState.version
            );
            assertReleaseMigrationHistoryCompatible(
                rollbackRelease.manifest,
                liveSchemaState,
                "Rollback"
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
            return executeReleaseTransition(layout, journal, async () => {
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
            });
        },
        options.transitionLockWaitMs
    );
}

export async function pruneDashboardReleases(
    retainCount = 3,
    releasesRoot = resolveDashboardReleasesRoot()
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

        return {
            removed,
            retained: newestFirst
                .map(({ release }) => release)
                .filter((release) => retained.has(release.commitSha))
                .map((release) => release.commitSha),
            warnings: warnings.toSorted(compareStrings),
        };
    });
}
