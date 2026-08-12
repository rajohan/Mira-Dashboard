import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    open,
    readdir,
    realpath,
    rename,
    rmdir,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { lowercaseUuidV7Schema } from "../../src/shared/validation.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";

const retentionFailureMessage = "Database snapshot retention failed";
const databaseFileName = "mira-dashboard.db";
const manifestFileName = "snapshot-manifest.json";
const cutoverRetentionMaximum = 5;
const cutoverRetentionMaximumAgeMs = 2 * 24 * 60 * 60_000;
const rootEntryMaximum = 128;
const stagePrefix = ".stage-";
const retirePrefix = ".retire-";
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;

interface OpenedDirectory {
    readonly device: bigint;
    readonly handle: FileHandle;
    readonly inode: bigint;
    readonly path: string;
}

type SnapshotEntryKind = "published" | "retired" | "stage";

interface CutoverSnapshotIdentity {
    readonly createdAtMs: number;
    readonly device: bigint;
    readonly id: string;
    readonly inode: bigint;
    readonly kind: SnapshotEntryKind;
    readonly name: string;
}

export interface DatabaseSnapshotRetentionInput {
    readonly activationTransitionIds: readonly string[];
    readonly journalTransitionId?: string;
    readonly nowMs?: number;
}

/** Deterministic crash/race boundaries exposed only to delivery tests. */
export interface DatabaseSnapshotRetentionTestHooks {
    readonly afterRetiredDirectorySynced?: (transitionId: string) => Promise<void> | void;
    readonly afterRetiredFileRemoved?: (
        transitionId: string,
        fileName: string
    ) => Promise<void> | void;
    readonly beforeSnapshotRetired?: (transitionId: string) => Promise<void> | void;
}

function failure(): Error {
    return new Error(retentionFailureMessage);
}

function validDirectory(status: BigIntStats, device?: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
        (status.mode & 0o7777n) === 0o700n &&
        (device === undefined || status.dev === device)
    );
}

async function closeHandle(handle: FileHandle | undefined): Promise<boolean> {
    if (handle === undefined) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

async function openDirectory(
    directory: string,
    expectedDevice?: bigint
): Promise<OpenedDirectory> {
    if (process.platform !== "linux") throw failure();
    let handle: FileHandle | undefined;
    try {
        handle = await open(directory, directoryFlags);
        const [held, pathStatus, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== directory ||
            !validDirectory(held, expectedDevice) ||
            !validDirectory(pathStatus, expectedDevice) ||
            held.dev !== pathStatus.dev ||
            held.ino !== pathStatus.ino
        ) {
            throw failure();
        }
        return Object.freeze({
            device: held.dev,
            handle,
            inode: held.ino,
            path: directory,
        });
    } catch {
        await closeHandle(handle);
        throw failure();
    }
}

function uuidTimestamp(transitionId: string): number {
    const value = Number.parseInt(transitionId.replaceAll("-", "").slice(0, 12), 16);
    if (!Number.isSafeInteger(value) || value < 0) throw failure();
    return value;
}

function isUuidV7(value: string): boolean {
    return v.safeParse(lowercaseUuidV7Schema(), value, { abortEarly: true }).success;
}

function parseSnapshotEntry(name: string):
    | {
          readonly id: string;
          readonly kind: SnapshotEntryKind;
      }
    | undefined {
    if (isUuidV7(name)) return { id: name, kind: "published" };
    for (const prefix of [".retire-final-", ".retire-stage-"] as const) {
        if (!name.startsWith(prefix)) continue;
        const id = name.slice(prefix.length);
        if (isUuidV7(id)) return { id, kind: "retired" };
    }
    for (const [prefix, kind] of [
        [stagePrefix, "stage"],
        [retirePrefix, "retired"],
    ] as const) {
        if (!name.startsWith(prefix)) continue;
        const id = name.slice(prefix.length);
        if (isUuidV7(id)) return { id, kind };
    }
    return undefined;
}

async function inspectSnapshotEntry(
    backups: OpenedDirectory,
    name: string,
    kind: SnapshotEntryKind,
    id: string
): Promise<CutoverSnapshotIdentity> {
    const anchored = path.join(`/proc/self/fd/${backups.handle.fd}`, name);
    const status = await lstat(anchored, { bigint: true });
    const allowedModes = kind === "published" ? [0o500n] : [0o500n, 0o700n];
    if (
        typeof process.getuid !== "function" ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.nlink !== 2n ||
        status.uid !== BigInt(process.getuid()) ||
        status.dev !== backups.device ||
        !allowedModes.includes(status.mode & 0o7777n)
    ) {
        throw failure();
    }
    return Object.freeze({
        createdAtMs: uuidTimestamp(id),
        device: status.dev,
        id,
        inode: status.ino,
        kind,
        name,
    });
}

async function openPinnedSnapshot(
    backups: OpenedDirectory,
    snapshot: CutoverSnapshotIdentity
): Promise<FileHandle> {
    const anchored = path.join(`/proc/self/fd/${backups.handle.fd}`, snapshot.name);
    let handle: FileHandle | undefined;
    try {
        handle = await open(anchored, directoryFlags);
        const [held, named] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(anchored, { bigint: true }),
        ]);
        const allowedModes = snapshot.kind === "published" ? [0o500n] : [0o500n, 0o700n];
        if (
            typeof process.getuid !== "function" ||
            !held.isDirectory() ||
            held.isSymbolicLink() ||
            held.nlink !== 2n ||
            held.uid !== BigInt(process.getuid()) ||
            held.dev !== snapshot.device ||
            held.ino !== snapshot.inode ||
            !allowedModes.includes(held.mode & 0o7777n) ||
            !named.isDirectory() ||
            named.isSymbolicLink() ||
            named.dev !== held.dev ||
            named.ino !== held.ino ||
            named.uid !== held.uid ||
            named.nlink !== 2n ||
            !allowedModes.includes(named.mode & 0o7777n)
        ) {
            throw failure();
        }
        return handle;
    } catch {
        await closeHandle(handle);
        throw failure();
    }
}

async function retireSnapshot(
    backups: OpenedDirectory,
    snapshot: CutoverSnapshotIdentity,
    hooks?: DatabaseSnapshotRetentionTestHooks
): Promise<CutoverSnapshotIdentity> {
    if (snapshot.kind === "retired") return snapshot;
    const retiredName = `${retirePrefix}${snapshot.id}`;
    const parent = `/proc/self/fd/${backups.handle.fd}`;
    const source = path.join(parent, snapshot.name);
    const target = path.join(parent, retiredName);
    const child = await openPinnedSnapshot(backups, snapshot);
    let failed = false;
    try {
        await hooks?.beforeSnapshotRetired?.(snapshot.id);
        const named = await lstat(source, { bigint: true });
        if (named.dev !== snapshot.device || named.ino !== snapshot.inode) {
            throw failure();
        }
        await rename(source, target);
        const retired = await lstat(target, { bigint: true });
        if (retired.dev !== snapshot.device || retired.ino !== snapshot.inode) {
            throw failure();
        }
        await backups.handle.sync();
        await hooks?.afterRetiredDirectorySynced?.(snapshot.id);
    } catch {
        failed = true;
    }
    if (!(await closeHandle(child)) || failed) throw failure();
    return Object.freeze({ ...snapshot, kind: "retired", name: retiredName });
}

async function reapRetiredSnapshot(
    backups: OpenedDirectory,
    snapshot: CutoverSnapshotIdentity,
    hooks?: DatabaseSnapshotRetentionTestHooks
): Promise<void> {
    if (snapshot.kind !== "retired") throw failure();
    if (typeof process.getuid !== "function") throw failure();
    const expectedUid = BigInt(process.getuid());
    const child = await openPinnedSnapshot(backups, snapshot);
    const descriptor = `/proc/self/fd/${child.fd}`;
    let failed = false;
    try {
        const entries = await readdir(descriptor, { withFileTypes: true });
        if (
            entries.length > 2 ||
            entries.some(
                (entry) =>
                    !entry.isFile() ||
                    ![databaseFileName, manifestFileName].includes(entry.name)
            )
        ) {
            throw failure();
        }
        await child.chmod(0o700);
        for (const fileName of [databaseFileName, manifestFileName] as const) {
            if (!entries.some((entry) => entry.name === fileName)) continue;
            const anchored = path.join(descriptor, fileName);
            let file: FileHandle | undefined;
            let fileFailed = false;
            try {
                file = await open(
                    anchored,
                    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
                );
                const [held, named] = await Promise.all([
                    file.stat({ bigint: true }),
                    lstat(anchored, { bigint: true }),
                ]);
                if (
                    typeof process.getuid !== "function" ||
                    !held.isFile() ||
                    held.isSymbolicLink() ||
                    held.nlink !== 1n ||
                    held.uid !== BigInt(process.getuid()) ||
                    held.dev !== backups.device ||
                    ![0o400n, 0o600n].includes(held.mode & 0o7777n) ||
                    !named.isFile() ||
                    named.isSymbolicLink() ||
                    named.dev !== held.dev ||
                    named.ino !== held.ino ||
                    named.nlink !== 1n ||
                    named.uid !== held.uid ||
                    ![0o400n, 0o600n].includes(named.mode & 0o7777n)
                ) {
                    throw failure();
                }
                await file.chmod(0o600);
                await unlink(anchored);
                await hooks?.afterRetiredFileRemoved?.(snapshot.id, fileName);
            } catch {
                fileFailed = true;
            }
            if (!(await closeHandle(file)) || fileFailed) throw failure();
        }
        const remainingEntries = await readdir(descriptor);
        if (remainingEntries.length > 0) throw failure();
        const named = await lstat(
            path.join(`/proc/self/fd/${backups.handle.fd}`, snapshot.name),
            { bigint: true }
        );
        if (named.dev !== snapshot.device || named.ino !== snapshot.inode) {
            throw failure();
        }
    } catch {
        failed = true;
    }
    if (!(await closeHandle(child)) || failed) throw failure();
    const parentEntry = path.join(`/proc/self/fd/${backups.handle.fd}`, snapshot.name);
    const finalNamed = await lstat(parentEntry, { bigint: true });
    if (
        !finalNamed.isDirectory() ||
        finalNamed.isSymbolicLink() ||
        finalNamed.dev !== snapshot.device ||
        finalNamed.ino !== snapshot.inode ||
        finalNamed.nlink !== 2n ||
        finalNamed.uid !== expectedUid ||
        (finalNamed.mode & 0o7777n) !== 0o700n
    ) {
        throw failure();
    }
    await rmdir(parentEntry);
    await backups.handle.sync();
}

/**
 * Prunes only unreferenced immutable activation snapshots under the deployment lease.
 * Current, previous, and in-flight journal transition identities are never removed.
 */
export async function retainProductionDatabaseSnapshots(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    input: DatabaseSnapshotRetentionInput,
    hooks?: DatabaseSnapshotRetentionTestHooks
): Promise<void> {
    const nowMs = input.nowMs ?? Date.now();
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        !input.activationTransitionIds.every((id) => v.is(lowercaseUuidV7Schema(), id)) ||
        (input.journalTransitionId !== undefined &&
            !v.is(lowercaseUuidV7Schema(), input.journalTransitionId))
    ) {
        throw failure();
    }
    const protectedIds = new Set(input.activationTransitionIds);
    if (input.journalTransitionId !== undefined) {
        protectedIds.add(input.journalTransitionId);
    }
    const state = await openDirectory(paths.stateDirectory);
    let backups: OpenedDirectory | undefined;
    let failed = false;
    try {
        backups = await openDirectory(
            path.join(paths.stateDirectory, "backups"),
            state.device
        );
        const entries = await readdir(backups.path, { withFileTypes: true });
        if (entries.length > rootEntryMaximum) throw failure();
        const snapshots: CutoverSnapshotIdentity[] = [];
        for (const entry of entries) {
            if (entry.name === "sqlite-maintenance") {
                if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure();
                continue;
            }
            const parsed = parseSnapshotEntry(entry.name);
            if (!entry.isDirectory() || parsed === undefined) throw failure();
            snapshots.push(
                await inspectSnapshotEntry(backups, entry.name, parsed.kind, parsed.id)
            );
        }
        if (snapshots.some(({ createdAtMs }) => createdAtMs > nowMs)) {
            throw failure();
        }
        if (
            snapshots.some(({ id, kind }) => kind === "retired" && protectedIds.has(id))
        ) {
            throw failure();
        }
        for (const snapshot of snapshots.filter(({ kind }) => kind === "retired")) {
            await reapRetiredSnapshot(backups, snapshot, hooks);
        }
        for (const snapshot of snapshots.filter(({ kind }) => kind === "stage")) {
            if (protectedIds.has(snapshot.id)) continue;
            const retired = await retireSnapshot(backups, snapshot, hooks);
            await reapRetiredSnapshot(backups, retired, hooks);
        }
        const published = snapshots
            .filter(({ kind }) => kind === "published")
            .toSorted((left, right) => right.id.localeCompare(left.id));
        const protectedSnapshotCount = published.filter(({ id }) =>
            protectedIds.has(id)
        ).length;
        const unprotectedRetentionMaximum = Math.max(
            0,
            cutoverRetentionMaximum - protectedSnapshotCount
        );
        const keptUnprotected = new Set(
            published
                .filter(({ id }) => !protectedIds.has(id))
                .filter(
                    ({ createdAtMs }) =>
                        nowMs - createdAtMs <= cutoverRetentionMaximumAgeMs
                )
                .slice(0, unprotectedRetentionMaximum)
                .map(({ id }) => id)
        );
        for (const snapshot of published) {
            if (protectedIds.has(snapshot.id) || keptUnprotected.has(snapshot.id)) {
                continue;
            }
            const retired = await retireSnapshot(backups, snapshot, hooks);
            await reapRetiredSnapshot(backups, retired, hooks);
        }
        await backups.handle.sync();
    } catch {
        failed = true;
    }
    const [backupsClosed, stateClosed] = await Promise.all([
        closeHandle(backups?.handle),
        closeHandle(state.handle),
    ]);
    if (failed || !backupsClosed || !stateClosed) throw failure();
}
