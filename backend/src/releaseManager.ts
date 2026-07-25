import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { Database } from "bun:sqlite";

import {
    assertMiraDatabasePathSafeForEnvironment,
    getMiraDatabasePath,
} from "./database.ts";
import { validateDatabaseMigrationHistory } from "./databaseMigrationRunner.ts";
import { guardedPath, writeTextNoFollowGuarded } from "./lib/guardedOps.ts";
import {
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY,
    type DashboardReleaseManifest,
    loadReleaseManifest,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./releaseManifest.ts";

export const DEFAULT_DASHBOARD_RELEASES_ROOT =
    "/home/ubuntu/projects/mira-dashboard-releases";
export const MANAGED_RELEASES_DIRECTORY_NAME = "releases";

const RELEASE_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const RELEASE_TRANSITION_FORMAT_VERSION = 1;
const RELEASE_TRANSITION_JOURNAL_FILE_NAME = ".release-transition.json";
const RELEASE_TRANSITION_LOCK_FILE_NAME = ".release-transition.lock";
const MAX_RELEASE_TRANSITION_FILE_BYTES = 4096;
const RELEASE_TRANSITION_LOCK_PROGRAM = "/usr/bin/flock";

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

export interface DashboardReleaseManagerOptions {
    readLiveSchemaVersion?: (
        maximumCompatibleVersion: number
    ) => number | Promise<number>;
    schemaCutoverMode?: "coordinated";
}

interface ReleaseLinkState {
    current: false | string;
    previous: false | string;
}

interface ReleaseTransitionJournal {
    after: ReleaseLinkState;
    before: ReleaseLinkState;
    formatVersion: 1;
    operation: "activate" | "rollback";
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
        (value.operation !== "activate" && value.operation !== "rollback")
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
    } else if (
        !before.current ||
        !before.previous ||
        after.current !== before.previous ||
        after.previous !== before.current
    ) {
        throw new TypeError("Rollback journal has an invalid release swap");
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
    await verifyReleaseBuildIdentities(releasePath, manifest);
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

async function readLiveDatabaseSchemaVersion(
    maximumCompatibleVersion: number
): Promise<number> {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    const database = new Database(databasePath, { readonly: true });
    try {
        database.run("PRAGMA busy_timeout = 5000");
        return validateDatabaseMigrationHistory(database, maximumCompatibleVersion);
    } finally {
        database.close();
    }
}

async function resolveLiveSchemaVersion(
    options: DashboardReleaseManagerOptions,
    maximumCompatibleVersion: number
): Promise<number> {
    const readLiveSchemaVersion =
        options.readLiveSchemaVersion ?? readLiveDatabaseSchemaVersion;
    const schemaVersion = await readLiveSchemaVersion(maximumCompatibleVersion);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        throw new TypeError("Live SQLite schema version is invalid");
    }
    return schemaVersion;
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

function assertHostRuntimeCompatible(release: ManagedDashboardRelease): void {
    if (release.manifest.bunVersion !== Bun.version) {
        throw new Error(
            `Release ${release.commitSha} requires Bun ${release.manifest.bunVersion}; host runs ${Bun.version}`
        );
    }
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
    const requiresCoordinatedCutover =
        candidate.schema.target < current.schema.minimumCompatible ||
        candidate.schema.target > current.schema.maximumCompatible;
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
        liveSchemaVersion < release.schema.minimumCompatible &&
        liveSchemaVersion < release.schema.target
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
): Promise<void> {
    const commits = new Set(
        [state.current, state.previous].filter(
            (commitSha): commitSha is string => typeof commitSha === "string"
        )
    );
    for (const commitSha of commits) {
        await loadManagedReleaseFromLayout(layout, commitSha);
    }
}

async function applyReleaseLinkState(
    layout: DashboardReleaseLayout,
    state: ReleaseLinkState
): Promise<void> {
    await validateReleaseLinkState(layout, state);
    if (state.current) {
        await replaceReleaseLink(layout, "current", state.current);
    } else {
        await removeReleaseLink(layout, "current");
    }
    if (state.previous) {
        await replaceReleaseLink(layout, "previous", state.previous);
    } else {
        await removeReleaseLink(layout, "previous");
    }
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

async function acquireReleaseTransitionLock(
    layout: DashboardReleaseLayout
): Promise<fs.promises.FileHandle> {
    const lockFile = await openReleaseTransitionLockFile(layout);
    const result = spawnSync(
        RELEASE_TRANSITION_LOCK_PROGRAM,
        ["--exclusive", "--nonblock", "3"],
        {
            stdio: ["ignore", "ignore", "pipe", lockFile.fd],
        }
    );
    if (result.error || result.status !== 0) {
        await lockFile.close();
        if (result.error) {
            throw result.error;
        }
        throw new Error("Another managed release transition is in progress");
    }
    return lockFile;
}

async function withReleaseTransitionLock<T>(
    layout: DashboardReleaseLayout,
    transition: () => Promise<T>
): Promise<T> {
    const lockFile = await acquireReleaseTransitionLock(layout);
    let result: T | undefined;
    let transitionError: unknown;
    try {
        await recoverInterruptedReleaseTransition(layout);
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
    releasesRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(layout, () =>
        readDashboardReleaseStateFromLayout(layout)
    );
}

export async function activateDashboardRelease(
    commitSha: string,
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    const candidate = await loadManagedReleaseFromLayout(layout, commitSha);
    assertHostRuntimeCompatible(candidate);

    return withReleaseTransitionLock(layout, async () => {
        const state = await readDashboardReleaseStateFromLayout(layout);
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
        const liveSchemaVersion = await resolveLiveSchemaVersion(
            options,
            maximumInspectableSchemaVersion
        );
        const requiresCoordinatedCutover =
            (liveSchemaVersion < candidate.manifest.schema.minimumCompatible &&
                liveSchemaVersion < candidate.manifest.schema.target) ||
            (state.current !== undefined &&
                (candidate.manifest.schema.target <
                    state.current.manifest.schema.minimumCompatible ||
                    candidate.manifest.schema.target >
                        state.current.manifest.schema.maximumCompatible));
        if (!requiresCoordinatedCutover && options.schemaCutoverMode === "coordinated") {
            throw new Error(
                "Coordinated schema cutover mode requires an incompatible schema boundary"
            );
        }
        assertReleaseCanActivateLiveSchema(
            candidate.manifest,
            liveSchemaVersion,
            options.schemaCutoverMode
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
            if (state.current) {
                await replaceReleaseLink(layout, "previous", state.current.commitSha);
            }
            await replaceReleaseLink(layout, "current", candidate.commitSha);
        });
    });
}

export async function rollbackDashboardRelease(
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(layout, async () => {
        const state = await readDashboardReleaseStateFromLayout(layout);
        if (!state.current || !state.previous) {
            throw new Error("Managed release rollback requires current and previous");
        }
        if (state.current.commitSha === state.previous.commitSha) {
            throw new Error("Managed release rollback requires two distinct releases");
        }

        const activeRelease = state.current;
        const rollbackRelease = state.previous;
        assertHostRuntimeCompatible(rollbackRelease);
        const maximumInspectableSchemaVersion = Math.max(
            DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
            activeRelease.manifest.schema.maximumCompatible,
            rollbackRelease.manifest.schema.maximumCompatible
        );
        const liveSchemaVersion = await resolveLiveSchemaVersion(
            options,
            maximumInspectableSchemaVersion
        );
        assertReleaseRollbackCompatible(
            activeRelease.manifest,
            rollbackRelease.manifest,
            liveSchemaVersion
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
            await replaceReleaseLink(layout, "current", rollbackRelease.commitSha);
            await replaceReleaseLink(layout, "previous", activeRelease.commitSha);
        });
    });
}
