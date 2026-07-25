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
const TRANSITION_LOCK_INITIALIZATION_GRACE_MS = 5000;

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

interface ReleaseTransitionLock {
    formatVersion: 1;
    ownerPid: number;
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

function parseReleaseTransitionLock(value: unknown): ReleaseTransitionLock {
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, ["formatVersion", "ownerPid"]) ||
        value.formatVersion !== RELEASE_TRANSITION_FORMAT_VERSION ||
        !Number.isSafeInteger(value.ownerPid) ||
        (value.ownerPid as number) <= 0
    ) {
        throw new TypeError("Release transition lock is invalid");
    }
    return {
        formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
        ownerPid: value.ownerPid as number,
    };
}

async function readBoundedControlFile(
    filePath: string
): Promise<{ modifiedAtMs: number; serialized: string } | undefined> {
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
            modifiedAtMs: stat.mtimeMs,
            serialized: await file.readFile("utf8"),
        };
    } finally {
        await file.close();
    }
}

async function readReleaseTransitionJournal(
    layout: DashboardReleaseLayout
): Promise<ReleaseTransitionJournal | undefined> {
    const file = await readBoundedControlFile(
        path.join(layout.root, RELEASE_TRANSITION_JOURNAL_FILE_NAME)
    );
    return file
        ? parseReleaseTransitionJournal(JSON.parse(file.serialized) as unknown)
        : undefined;
}

async function readReleaseTransitionLock(
    layout: DashboardReleaseLayout
): Promise<(ReleaseTransitionLock & { modifiedAtMs: number }) | undefined> {
    const file = await readBoundedControlFile(
        path.join(layout.root, RELEASE_TRANSITION_LOCK_FILE_NAME)
    );
    if (!file) {
        return undefined;
    }
    return {
        ...parseReleaseTransitionLock(JSON.parse(file.serialized) as unknown),
        modifiedAtMs: file.modifiedAtMs,
    };
}

async function removeReleaseTransitionControlFile(
    layout: DashboardReleaseLayout,
    fileName: string
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new TypeError(
            "Release transition control file must be a single-link regular file"
        );
    }
    await fsp.unlink(filePath);
    await syncDirectory(layout.root);
}

async function writeReleaseTransitionJournal(
    layout: DashboardReleaseLayout,
    journal: ReleaseTransitionJournal
): Promise<void> {
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
}

async function acquireReleaseTransitionLock(
    layout: DashboardReleaseLayout
): Promise<void> {
    const lockPath = path.join(layout.root, RELEASE_TRANSITION_LOCK_FILE_NAME);
    let file: fs.promises.FileHandle | undefined;
    let isLockCreated = false;
    try {
        file = await fsp.open(
            lockPath,
            fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW,
            0o600
        );
        isLockCreated = true;
        await file.writeFile(
            `${JSON.stringify({
                formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
                ownerPid: process.pid,
            })}\n`,
            "utf8"
        );
        await file.sync();
        await file.close();
        file = undefined;
        await syncDirectory(layout.root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("Another managed release transition is in progress", {
                cause: error,
            });
        }
        await file?.close();
        file = undefined;
        if (isLockCreated) {
            try {
                await fsp.unlink(lockPath);
                await syncDirectory(layout.root);
            } catch {
                // Preserve the lock acquisition failure.
            }
        }
        throw error;
    } finally {
        await file?.close();
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
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
    journal: ReleaseTransitionJournal
): Promise<void> {
    await applyReleaseLinkState(layout, journal.before);
    const restored = await readDashboardReleaseStateFromLayout(layout);
    assertDashboardReleaseStateMatches(restored, journal.before);
    await removeReleaseTransitionControlFile(
        layout,
        RELEASE_TRANSITION_JOURNAL_FILE_NAME
    );
}

async function recoverInterruptedReleaseTransition(
    layout: DashboardReleaseLayout
): Promise<void> {
    let lock: Awaited<ReturnType<typeof readReleaseTransitionLock>>;
    try {
        lock = await readReleaseTransitionLock(layout);
    } catch (error) {
        const journal = await readReleaseTransitionJournal(layout);
        if (journal) {
            throw error;
        }
        const lockPath = path.join(layout.root, RELEASE_TRANSITION_LOCK_FILE_NAME);
        const stat = await fsp.lstat(lockPath);
        if (Date.now() - stat.mtimeMs < TRANSITION_LOCK_INITIALIZATION_GRACE_MS) {
            throw new Error("Managed release transition lock is still initializing", {
                cause: error,
            });
        }
        await removeReleaseTransitionControlFile(
            layout,
            RELEASE_TRANSITION_LOCK_FILE_NAME
        );
        return;
    }

    const journal = await readReleaseTransitionJournal(layout);
    if (!lock && !journal) {
        return;
    }
    if (lock && isProcessAlive(lock.ownerPid)) {
        throw new Error(
            `Managed release transition is active in process ${lock.ownerPid}`
        );
    }
    if (journal) {
        await restoreInterruptedReleaseTransition(layout, journal);
    }
    if (lock) {
        await removeReleaseTransitionControlFile(
            layout,
            RELEASE_TRANSITION_LOCK_FILE_NAME
        );
    }
}

async function releaseOwnedTransitionLock(layout: DashboardReleaseLayout): Promise<void> {
    const lock = await readReleaseTransitionLock(layout);
    if (!lock || lock.ownerPid !== process.pid) {
        throw new Error("Managed release transition lock ownership changed");
    }
    await removeReleaseTransitionControlFile(layout, RELEASE_TRANSITION_LOCK_FILE_NAME);
}

async function executeReleaseTransition(
    layout: DashboardReleaseLayout,
    journal: ReleaseTransitionJournal,
    apply: () => Promise<void>
): Promise<DashboardReleaseState> {
    await writeReleaseTransitionJournal(layout, journal);
    try {
        await apply();
        const state = await readDashboardReleaseStateFromLayout(layout);
        assertDashboardReleaseStateMatches(state, journal.after);
        await removeReleaseTransitionControlFile(
            layout,
            RELEASE_TRANSITION_JOURNAL_FILE_NAME
        );
        return state;
    } catch (error) {
        try {
            await restoreInterruptedReleaseTransition(layout, journal);
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
    await recoverInterruptedReleaseTransition(layout);
    return readDashboardReleaseStateFromLayout(layout);
}

export async function activateDashboardRelease(
    commitSha: string,
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    await recoverInterruptedReleaseTransition(layout);
    const candidate = await loadManagedReleaseFromLayout(layout, commitSha);
    assertHostRuntimeCompatible(candidate);

    await acquireReleaseTransitionLock(layout);
    try {
        const state = await readDashboardReleaseStateFromLayout(layout);
        if (state.current?.commitSha === candidate.commitSha) {
            return state;
        }
        if (state.current) {
            assertReleaseActivationCompatible(candidate.manifest, state.current.manifest);
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
        assertReleaseCanOpenLiveSchema(
            candidate.manifest,
            liveSchemaVersion,
            "Activation"
        );

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
    } finally {
        await releaseOwnedTransitionLock(layout);
    }
}

export async function rollbackDashboardRelease(
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    await recoverInterruptedReleaseTransition(layout);
    await acquireReleaseTransitionLock(layout);
    try {
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
        assertReleaseRollbackCompatible(activeRelease.manifest, rollbackRelease.manifest);
        const maximumInspectableSchemaVersion = Math.max(
            DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
            activeRelease.manifest.schema.maximumCompatible,
            rollbackRelease.manifest.schema.maximumCompatible
        );
        const liveSchemaVersion = await resolveLiveSchemaVersion(
            options,
            maximumInspectableSchemaVersion
        );
        assertReleaseCanOpenLiveSchema(
            rollbackRelease.manifest,
            liveSchemaVersion,
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
            await replaceReleaseLink(layout, "current", rollbackRelease.commitSha);
            await replaceReleaseLink(layout, "previous", activeRelease.commitSha);
        });
    } finally {
        await releaseOwnedTransitionLock(layout);
    }
}
