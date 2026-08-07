import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    mkdir,
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

import {
    parseDatabaseSnapshotManifest,
    type DatabaseSnapshotManifest,
} from "../../src/shared/databaseSnapshotManifest.ts";
import type { ProductionActivationTransition } from "../../src/shared/productionActivationTransition.ts";
import { lowercaseUuidV7Schema } from "../../src/shared/validation.ts";
import type { PublishedDatabaseSnapshotResult } from "./databaseMaintenanceProcess.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";

const transitionFilesystemFailureMessage =
    "Database transition filesystem operation failed";
const databaseFileName = "mira-dashboard.db";
const snapshotManifestFileName = "snapshot-manifest.json";
const maximumDatabaseBytes = 64 * 1024 * 1024 * 1024;
const maximumManifestBytes = 64 * 1024;
const copyBufferBytes = 1024 * 1024;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const sourceFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const destinationFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const workspaceBrand: unique symbol = Symbol("DatabaseTransitionWorkspace");
const candidateBrand: unique symbol = Symbol("VerifiedDatabaseCandidate");
const promotedBrand: unique symbol = Symbol("PromotedDatabaseState");
const allowedCandidateFiles = new Set([
    databaseFileName,
    `${databaseFileName}-journal`,
    `${databaseFileName}-shm`,
    `${databaseFileName}-wal`,
]);

interface FileIdentity {
    readonly ctimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mtimeNs: bigint;
    readonly size: bigint;
    readonly uid: bigint;
}

interface DirectoryIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
}

interface OpenedDirectory {
    readonly handle: FileHandle;
    readonly identity: DirectoryIdentity;
    readonly lookupPath: string;
    readonly path: string;
}

/** Private candidate workspace created below project-local production state. */
export interface DatabaseTransitionWorkspace {
    readonly [workspaceBrand]: true;
    readonly candidateDatabase: string;
    readonly candidateDirectory: string;
    readonly previous: PublishedDatabaseSnapshotResult;
    readonly root: string;
    readonly transitionId: string;
}

/** Candidate whose file identity was checked after the maintenance process exited. */
export interface VerifiedDatabaseCandidate {
    readonly [candidateBrand]: true;
    readonly fileIdentity: FileIdentity;
    readonly workspace: DatabaseTransitionWorkspace;
}

/** Live database identity returned after one atomic candidate promotion. */
export interface PromotedDatabaseState {
    readonly [promotedBrand]: true;
    readonly fileIdentity: FileIdentity;
    readonly previous: PublishedDatabaseSnapshotResult;
    readonly transitionId: string;
}

/** Recovery inspection result for a crash-interrupted prepared journal. */
export type DatabaseTransitionRecovery =
    | Readonly<{ state: "not-promoted"; transitionId: string }>
    | Readonly<{
          promoted: PromotedDatabaseState;
          state: "promoted";
          workspace: DatabaseTransitionWorkspace;
      }>;

function transitionFailure(): Error {
    return new Error(transitionFilesystemFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function directoryIdentity(status: BigIntStats): DirectoryIdentity {
    return Object.freeze({ dev: status.dev, ino: status.ino });
}

function fileIdentity(status: BigIntStats): FileIdentity {
    if (
        typeof process.getuid !== "function" ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o7777n) !== 0o600n ||
        status.size <= 0n ||
        status.size > BigInt(maximumDatabaseBytes)
    ) {
        throw transitionFailure();
    }
    return Object.freeze({
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
        uid: status.uid,
    });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.ctimeNs === right.ctimeNs &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mtimeNs === right.mtimeNs &&
        left.size === right.size &&
        left.uid === right.uid
    );
}

function sameFileObject(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.uid === right.uid
    );
}

function sameDirectoryIdentity(
    status: BigIntStats,
    expected: DirectoryIdentity
): boolean {
    return status.dev === expected.dev && status.ino === expected.ino;
}

function validPrivateDirectory(status: BigIntStats, userId: number): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & 0o7777n) === 0o700n
    );
}

async function closeHandle(handle: FileHandle | undefined): Promise<boolean> {
    if (!handle) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

async function openPrivateDirectory(
    directory: string,
    expectedDevice?: bigint,
    expectedCanonicalPath = directory
): Promise<OpenedDirectory> {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw transitionFailure();
    }
    let handle: FileHandle | undefined;
    let result: OpenedDirectory | undefined;
    try {
        handle = await open(directory, directoryFlags);
        const [held, after, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        const expected = directoryIdentity(held);
        if (
            canonical !== expectedCanonicalPath ||
            !validPrivateDirectory(held, process.getuid()) ||
            !validPrivateDirectory(after, process.getuid()) ||
            !sameDirectoryIdentity(after, expected) ||
            (expectedDevice !== undefined && held.dev !== expectedDevice)
        ) {
            throw transitionFailure();
        }
        result = Object.freeze({
            handle,
            identity: expected,
            lookupPath: directory,
            path: expectedCanonicalPath,
        });
    } catch {
        await closeHandle(handle);
        throw transitionFailure();
    }
    return result;
}

async function revalidateDirectory(directory: OpenedDirectory): Promise<void> {
    if (typeof process.getuid !== "function") throw transitionFailure();
    const [held, current, canonical] = await Promise.all([
        directory.handle.stat({ bigint: true }),
        lstat(directory.lookupPath, { bigint: true }),
        realpath(`/proc/self/fd/${directory.handle.fd}`),
    ]);
    if (
        canonical !== directory.path ||
        !validPrivateDirectory(held, process.getuid()) ||
        !validPrivateDirectory(current, process.getuid()) ||
        !sameDirectoryIdentity(held, directory.identity) ||
        !sameDirectoryIdentity(current, directory.identity)
    ) {
        throw transitionFailure();
    }
}

async function clearOwnedCandidateFiles(candidate: OpenedDirectory): Promise<void> {
    if (typeof process.getuid !== "function") throw transitionFailure();
    const descriptorRoot = `/proc/self/fd/${candidate.handle.fd}`;
    const entries = await readdir(descriptorRoot);
    if (
        entries.length > allowedCandidateFiles.size ||
        entries.some((entry) => !allowedCandidateFiles.has(entry))
    ) {
        throw transitionFailure();
    }
    for (const entry of entries) {
        const anchoredEntry = path.join(descriptorRoot, entry);
        const status = await lstat(anchoredEntry, { bigint: true });
        if (
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.nlink !== 1n ||
            status.uid !== BigInt(process.getuid()) ||
            status.dev !== candidate.identity.dev ||
            (status.mode & 0o7777n) !== 0o600n
        ) {
            throw transitionFailure();
        }
        await unlink(anchoredEntry);
    }
    await candidate.handle.sync();
    const remainingEntries = await readdir(descriptorRoot);
    if (remainingEntries.length > 0) throw transitionFailure();
    await revalidateDirectory(candidate);
}

async function requireMissing(candidate: string): Promise<void> {
    try {
        await lstat(candidate);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw transitionFailure();
    }
    throw transitionFailure();
}

async function requireSidecarsAbsent(databaseFile: string): Promise<void> {
    for (const suffix of ["-journal", "-shm", "-wal"] as const) {
        await requireMissing(`${databaseFile}${suffix}`);
    }
}

async function hashFile(handle: FileHandle, expectedBytes: number): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = Buffer.alloc(Math.min(copyBufferBytes, expectedBytes));
    let offset = 0;
    while (offset < expectedBytes) {
        const length = Math.min(buffer.byteLength, expectedBytes - offset);
        const read = await handle.read(buffer, 0, length, offset);
        if (read.bytesRead <= 0) throw transitionFailure();
        hasher.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
    }
    return hasher.digest("hex");
}

async function readAndValidateSnapshotManifest(
    snapshotDirectory: string,
    expected: DatabaseSnapshotManifest
): Promise<void> {
    const manifestFile = path.join(snapshotDirectory, snapshotManifestFileName);
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        if (typeof process.getuid !== "function") throw transitionFailure();
        handle = await open(manifestFile, sourceFlags);
        const held = await handle.stat({ bigint: true });
        const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
        if (
            canonical !== manifestFile ||
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== BigInt(process.getuid()) ||
            (held.mode & 0o7777n) !== 0o400n ||
            held.size <= 0n ||
            held.size > BigInt(maximumManifestBytes)
        ) {
            throw transitionFailure();
        }
        const bytes = Buffer.alloc(Number(held.size) + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const read = await handle.read(
                bytes,
                offset,
                bytes.byteLength - offset,
                offset
            );
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
        }
        const [heldAfter, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(manifestFile, { bigint: true }),
        ]);
        if (
            offset !== Number(held.size) ||
            heldAfter.dev !== held.dev ||
            heldAfter.ino !== held.ino ||
            heldAfter.size !== held.size ||
            heldAfter.ctimeNs !== held.ctimeNs ||
            heldAfter.mtimeNs !== held.mtimeNs ||
            pathAfter.dev !== held.dev ||
            pathAfter.ino !== held.ino ||
            pathAfter.size !== held.size ||
            pathAfter.ctimeNs !== held.ctimeNs ||
            pathAfter.mtimeNs !== held.mtimeNs
        ) {
            throw transitionFailure();
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, offset)
        );
        const value: unknown = JSON.parse(text);
        const parsed = parseDatabaseSnapshotManifest(value);
        if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
            throw transitionFailure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw transitionFailure();
}

async function copyVerifiedSnapshot(
    snapshot: Extract<PublishedDatabaseSnapshotResult, { state: "present" }>,
    destination: string,
    expectedDevice: bigint
): Promise<void> {
    if (typeof process.getuid !== "function") throw transitionFailure();
    const snapshotDirectoryStatus = await lstat(snapshot.snapshotDirectory, {
        bigint: true,
    });
    const entries = await readdir(snapshot.snapshotDirectory);
    if (
        !snapshotDirectoryStatus.isDirectory() ||
        snapshotDirectoryStatus.isSymbolicLink() ||
        snapshotDirectoryStatus.uid !== BigInt(process.getuid()) ||
        snapshotDirectoryStatus.dev !== expectedDevice ||
        (snapshotDirectoryStatus.mode & 0o7777n) !== 0o500n ||
        entries.length !== 2 ||
        entries.toSorted().join("\0") !==
            [databaseFileName, snapshotManifestFileName].toSorted().join("\0")
    ) {
        throw transitionFailure();
    }
    await readAndValidateSnapshotManifest(snapshot.snapshotDirectory, snapshot.manifest);

    let source: FileHandle | undefined;
    let target: FileHandle | undefined;
    let failed = false;
    try {
        source = await open(snapshot.snapshotFile, sourceFlags);
        const sourceHeld = await source.stat({ bigint: true });
        const canonicalSource = await realpath(`/proc/self/fd/${source.fd}`);
        if (
            canonicalSource !== snapshot.snapshotFile ||
            !sourceHeld.isFile() ||
            sourceHeld.isSymbolicLink() ||
            sourceHeld.nlink !== 1n ||
            sourceHeld.uid !== BigInt(process.getuid()) ||
            sourceHeld.dev !== expectedDevice ||
            sourceHeld.size !== BigInt(snapshot.manifest.database.bytes) ||
            (sourceHeld.mode & 0o7777n) !== 0o400n
        ) {
            throw transitionFailure();
        }
        target = await open(destination, destinationFlags, privateFileMode);
        const bytes = Number(sourceHeld.size);
        const buffer = Buffer.alloc(Math.min(copyBufferBytes, bytes));
        const sourceHasher = new Bun.CryptoHasher("sha256");
        let offset = 0;
        while (offset < bytes) {
            const length = Math.min(buffer.byteLength, bytes - offset);
            const read = await source.read(buffer, 0, length, offset);
            if (read.bytesRead <= 0) throw transitionFailure();
            sourceHasher.update(buffer.subarray(0, read.bytesRead));
            let written = 0;
            while (written < read.bytesRead) {
                const write = await target.write(
                    buffer,
                    written,
                    read.bytesRead - written,
                    offset + written
                );
                if (write.bytesWritten <= 0) throw transitionFailure();
                written += write.bytesWritten;
            }
            offset += read.bytesRead;
        }
        await target.sync();
        const [sourceAfter, sourcePathAfter, targetAfter] = await Promise.all([
            source.stat({ bigint: true }),
            lstat(snapshot.snapshotFile, { bigint: true }),
            target.stat({ bigint: true }),
        ]);
        if (
            sourceAfter.dev !== sourceHeld.dev ||
            sourceAfter.ino !== sourceHeld.ino ||
            sourceAfter.size !== sourceHeld.size ||
            sourcePathAfter.dev !== sourceHeld.dev ||
            sourcePathAfter.ino !== sourceHeld.ino ||
            sourcePathAfter.size !== sourceHeld.size ||
            targetAfter.size !== sourceHeld.size ||
            targetAfter.nlink !== 1n ||
            targetAfter.uid !== BigInt(process.getuid()) ||
            (targetAfter.mode & 0o7777n) !== 0o600n
        ) {
            throw transitionFailure();
        }
        const sourceHash = sourceHasher.digest("hex");
        const targetHash = await hashFile(target, bytes);
        if (
            sourceHash !== snapshot.manifest.database.sha256 ||
            targetHash !== sourceHash
        ) {
            throw transitionFailure();
        }
    } catch {
        failed = true;
    }
    const [sourceClosed, targetClosed] = await Promise.all([
        closeHandle(source),
        closeHandle(target),
    ]);
    if (failed || !sourceClosed || !targetClosed) throw transitionFailure();
}

async function removeOwnedWorkspace(
    stateDirectory: string,
    transitionId: string
): Promise<void> {
    const expectedName = `.database-transition-${transitionId}`;
    const workspaceRoot = path.join(stateDirectory, expectedName);
    if (
        path.basename(workspaceRoot) !== expectedName ||
        !v.is(lowercaseUuidV7Schema(), transitionId)
    ) {
        throw transitionFailure();
    }
    if (typeof process.getuid !== "function") throw transitionFailure();
    const state = await openPrivateDirectory(stateDirectory);
    const anchoredRoot = path.join(`/proc/self/fd/${state.handle.fd}`, expectedName);
    let root: OpenedDirectory | undefined;
    let candidate: OpenedDirectory | undefined;
    let failed = false;
    let rootMissing = false;
    try {
        try {
            await lstat(anchoredRoot, { bigint: true });
        } catch (error) {
            if (errorCode(error) === "ENOENT") {
                rootMissing = true;
            } else {
                throw transitionFailure();
            }
        }
        if (!rootMissing) {
            root = await openPrivateDirectory(
                anchoredRoot,
                state.identity.dev,
                workspaceRoot
            );
            const rootEntries = await readdir(`/proc/self/fd/${root.handle.fd}`);
            if (
                rootEntries.length > 1 ||
                (rootEntries.length === 1 && rootEntries[0] !== "candidate")
            ) {
                throw transitionFailure();
            }
            if (rootEntries.length === 1) {
                const candidatePath = path.join(workspaceRoot, "candidate");
                const anchoredCandidate = path.join(
                    `/proc/self/fd/${root.handle.fd}`,
                    "candidate"
                );
                candidate = await openPrivateDirectory(
                    anchoredCandidate,
                    state.identity.dev,
                    candidatePath
                );
                await clearOwnedCandidateFiles(candidate);
                if (!(await closeHandle(candidate.handle))) {
                    throw transitionFailure();
                }
                candidate = undefined;
                await rmdir(anchoredCandidate);
                await root.handle.sync();
            }
            if (!(await closeHandle(root.handle))) throw transitionFailure();
            root = undefined;
            await rmdir(anchoredRoot);
            await state.handle.sync();
        }
    } catch {
        failed = true;
    } finally {
        const [candidateClosed, rootClosed, stateClosed] = await Promise.all([
            closeHandle(candidate?.handle),
            closeHandle(root?.handle),
            closeHandle(state.handle),
        ]);
        if (!candidateClosed || !rootClosed || !stateClosed) failed = true;
    }
    if (failed) throw transitionFailure();
}

/**
 * Creates one private candidate workspace and copies a verified pre-activation snapshot.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param transitionId Canonical transition identifier.
 * @param previous Verified absent marker or immutable pre-activation snapshot.
 * @returns Branded private candidate workspace.
 */
export async function prepareDatabaseTransitionWorkspace(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    transitionId: string,
    previous: PublishedDatabaseSnapshotResult
): Promise<DatabaseTransitionWorkspace> {
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        !v.is(lowercaseUuidV7Schema(), transitionId) ||
        (previous.state === "absent" && previous.transitionId !== transitionId) ||
        (previous.state === "present" && previous.manifest.transitionId !== transitionId)
    ) {
        throw transitionFailure();
    }
    const state = await openPrivateDirectory(paths.stateDirectory);
    let root: OpenedDirectory | undefined;
    let candidate: OpenedDirectory | undefined;
    let result: DatabaseTransitionWorkspace | undefined;
    let failed = false;
    try {
        const rootName = `.database-transition-${transitionId}`;
        const stateDescriptor = `/proc/self/fd/${state.handle.fd}`;
        const rootDescriptor = path.join(stateDescriptor, rootName);
        await requireMissing(rootDescriptor);
        await mkdir(rootDescriptor, { mode: privateDirectoryMode });
        const rootPath = path.join(paths.stateDirectory, rootName);
        root = await openPrivateDirectory(rootPath, state.identity.dev);
        await mkdir(path.join(`/proc/self/fd/${root.handle.fd}`, "candidate"), {
            mode: privateDirectoryMode,
        });
        const candidateDirectory = path.join(rootPath, "candidate");
        candidate = await openPrivateDirectory(candidateDirectory, state.identity.dev);
        const candidateDatabase = path.join(candidateDirectory, databaseFileName);
        if (previous.state === "present") {
            await copyVerifiedSnapshot(previous, candidateDatabase, state.identity.dev);
        }
        await revalidateDirectory(candidate);
        await revalidateDirectory(root);
        await revalidateDirectory(state);
        result = Object.freeze({
            [workspaceBrand]: true as const,
            candidateDatabase,
            candidateDirectory,
            previous,
            root: rootPath,
            transitionId,
        });
    } catch {
        failed = true;
    }
    const [candidateClosed, rootClosed, stateClosed] = await Promise.all([
        closeHandle(candidate?.handle),
        closeHandle(root?.handle),
        closeHandle(state.handle),
    ]);
    if (failed || !candidateClosed || !rootClosed || !stateClosed || !result) {
        try {
            await removeOwnedWorkspace(paths.stateDirectory, transitionId);
        } catch {
            // Preserve the fixed failure and leave bounded private evidence.
        }
        throw transitionFailure();
    }
    return result;
}

/**
 * Revalidates the candidate file after the isolated maintenance process exits.
 * @param workspace Branded candidate workspace.
 * @returns Branded candidate plus its stable file identity.
 */
export async function verifyDatabaseTransitionCandidate(
    workspace: DatabaseTransitionWorkspace
): Promise<VerifiedDatabaseCandidate> {
    try {
        if (workspace[workspaceBrand] !== true) throw transitionFailure();
        const directory = await openPrivateDirectory(workspace.candidateDirectory);
        let verified: VerifiedDatabaseCandidate | undefined;
        let failed = false;
        try {
            const entries = await readdir(workspace.candidateDirectory);
            if (entries.length !== 1 || entries[0] !== databaseFileName) {
                throw transitionFailure();
            }
            await requireSidecarsAbsent(workspace.candidateDatabase);
            const before = fileIdentity(
                await lstat(workspace.candidateDatabase, { bigint: true })
            );
            await revalidateDirectory(directory);
            const after = fileIdentity(
                await lstat(workspace.candidateDatabase, { bigint: true })
            );
            if (!sameFileIdentity(before, after)) throw transitionFailure();
            verified = Object.freeze({
                [candidateBrand]: true as const,
                fileIdentity: after,
                workspace,
            });
        } catch {
            failed = true;
        }
        const closed = await closeHandle(directory.handle);
        if (failed || !closed || !verified) throw transitionFailure();
        return verified;
    } catch {
        throw transitionFailure();
    }
}

function sourceIdentityMatches(
    status: BigIntStats,
    expected: Extract<
        PublishedDatabaseSnapshotResult,
        { state: "present" }
    >["sourceDatabase"]
): boolean {
    return (
        status.ctimeNs.toString() === expected.ctimeNs &&
        status.dev.toString() === expected.device &&
        status.ino.toString() === expected.inode &&
        status.mtimeNs.toString() === expected.mtimeNs &&
        status.size.toString() === expected.size
    );
}

/**
 * Atomically replaces the live database entry with one verified candidate on the same device.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param candidate Candidate verified after maintenance completion.
 * @returns Promoted live file identity and matching pre-activation state.
 */
export async function promoteDatabaseTransitionCandidate(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    candidate: VerifiedDatabaseCandidate
): Promise<PromotedDatabaseState> {
    const { workspace } = candidate;
    if (
        candidate[candidateBrand] !== true ||
        workspace[workspaceBrand] !== true ||
        lease.stateDirectory !== paths.stateDirectory ||
        workspace.root !==
            path.join(
                paths.stateDirectory,
                `.database-transition-${workspace.transitionId}`
            )
    ) {
        throw transitionFailure();
    }
    const state = await openPrivateDirectory(paths.stateDirectory);
    const candidateDirectory = await openPrivateDirectory(
        workspace.candidateDirectory,
        state.identity.dev
    );
    let result: PromotedDatabaseState | undefined;
    let failed = false;
    try {
        const candidateBefore = fileIdentity(
            await lstat(workspace.candidateDatabase, { bigint: true })
        );
        if (!sameFileIdentity(candidate.fileIdentity, candidateBefore)) {
            throw transitionFailure();
        }
        const liveDatabase = path.join(paths.stateDirectory, databaseFileName);
        await requireSidecarsAbsent(liveDatabase);
        if (workspace.previous.state === "absent") {
            await requireMissing(liveDatabase);
        } else {
            const liveStatus = await lstat(liveDatabase, { bigint: true });
            fileIdentity(liveStatus);
            if (!sourceIdentityMatches(liveStatus, workspace.previous.sourceDatabase)) {
                throw transitionFailure();
            }
        }
        await revalidateDirectory(candidateDirectory);
        await revalidateDirectory(state);
        await rename(
            path.join(`/proc/self/fd/${candidateDirectory.handle.fd}`, databaseFileName),
            path.join(`/proc/self/fd/${state.handle.fd}`, databaseFileName)
        );
        await state.handle.sync();
        const liveIdentity = fileIdentity(await lstat(liveDatabase, { bigint: true }));
        if (!sameFileObject(candidateBefore, liveIdentity)) {
            throw transitionFailure();
        }
        result = Object.freeze({
            [promotedBrand]: true as const,
            fileIdentity: liveIdentity,
            previous: workspace.previous,
            transitionId: workspace.transitionId,
        });
    } catch {
        failed = true;
    }
    const [candidateClosed, stateClosed] = await Promise.all([
        closeHandle(candidateDirectory.handle),
        closeHandle(state.handle),
    ]);
    if (failed || !candidateClosed || !stateClosed || !result) {
        throw transitionFailure();
    }
    return result;
}

/**
 * Copies the immutable pre-activation snapshot back into the emptied workspace.
 * The previous release must validate this copy before it can be atomically restored.
 * @param promoted Branded result from candidate promotion.
 * @param workspace Original transition workspace whose candidate file was promoted.
 * @returns Completion after the restore candidate is durable and private.
 */
export async function prepareDatabaseRollbackCandidate(
    promoted: PromotedDatabaseState,
    workspace: DatabaseTransitionWorkspace
): Promise<void> {
    if (
        promoted[promotedBrand] !== true ||
        workspace[workspaceBrand] !== true ||
        promoted.transitionId !== workspace.transitionId ||
        promoted.previous !== workspace.previous ||
        workspace.previous.state !== "present"
    ) {
        throw transitionFailure();
    }
    const candidate = await openPrivateDirectory(workspace.candidateDirectory);
    let failed = false;
    try {
        await clearOwnedCandidateFiles(candidate);
        await copyVerifiedSnapshot(
            workspace.previous,
            workspace.candidateDatabase,
            candidate.identity.dev
        );
        await revalidateDirectory(candidate);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(candidate.handle);
    if (failed || !closed) throw transitionFailure();
}

function samePromotedLiveObject(status: BigIntStats, promoted: FileIdentity): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.dev === promoted.dev &&
        status.ino === promoted.ino &&
        status.uid === promoted.uid &&
        (status.mode & 0o7777n) === 0o600n
    );
}

async function discardLiveSidecars(
    state: OpenedDirectory,
    liveDatabase: string
): Promise<void> {
    if (typeof process.getuid !== "function") throw transitionFailure();
    for (const suffix of ["-journal", "-shm", "-wal"] as const) {
        const sidecarName = `${databaseFileName}${suffix}`;
        const sidecar = `${liveDatabase}${suffix}`;
        try {
            const status = await lstat(sidecar, { bigint: true });
            if (
                !status.isFile() ||
                status.isSymbolicLink() ||
                status.nlink !== 1n ||
                status.uid !== BigInt(process.getuid()) ||
                status.dev !== state.identity.dev ||
                (status.mode & 0o7777n) !== 0o600n
            ) {
                throw transitionFailure();
            }
            await unlink(path.join(`/proc/self/fd/${state.handle.fd}`, sidecarName));
        } catch (error) {
            if (errorCode(error) !== "ENOENT") throw transitionFailure();
        }
    }
}

/**
 * Restores the exact pre-activation database state after candidate failure.
 * Callers must stop candidate processes before discarding their private WAL sidecars.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param promoted Branded candidate promotion result.
 * @param rollbackCandidate Previous-release-validated restore copy when state was present.
 * @returns Completion after the previous database state is durable at the live entry.
 */
export async function restorePromotedDatabaseState(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    promoted: PromotedDatabaseState,
    rollbackCandidate?: VerifiedDatabaseCandidate
): Promise<void> {
    if (
        promoted[promotedBrand] !== true ||
        lease.stateDirectory !== paths.stateDirectory ||
        (promoted.previous.state === "absent" && rollbackCandidate !== undefined) ||
        (promoted.previous.state === "present" &&
            (rollbackCandidate?.[candidateBrand] !== true ||
                rollbackCandidate.workspace.transitionId !== promoted.transitionId))
    ) {
        throw transitionFailure();
    }
    const state = await openPrivateDirectory(paths.stateDirectory);
    let candidateDirectory: OpenedDirectory | undefined;
    let failed = false;
    try {
        const liveDatabase = path.join(paths.stateDirectory, databaseFileName);
        const liveStatus = await lstat(liveDatabase, { bigint: true });
        if (!samePromotedLiveObject(liveStatus, promoted.fileIdentity)) {
            throw transitionFailure();
        }
        if (rollbackCandidate) {
            candidateDirectory = await openPrivateDirectory(
                rollbackCandidate.workspace.candidateDirectory,
                state.identity.dev
            );
            const restoreIdentity = fileIdentity(
                await lstat(rollbackCandidate.workspace.candidateDatabase, {
                    bigint: true,
                })
            );
            if (!sameFileIdentity(restoreIdentity, rollbackCandidate.fileIdentity)) {
                throw transitionFailure();
            }
        }
        await revalidateDirectory(state);
        await discardLiveSidecars(state, liveDatabase);
        if (rollbackCandidate && candidateDirectory) {
            await revalidateDirectory(candidateDirectory);
            await rename(
                path.join(
                    `/proc/self/fd/${candidateDirectory.handle.fd}`,
                    databaseFileName
                ),
                path.join(`/proc/self/fd/${state.handle.fd}`, databaseFileName)
            );
            const restored = fileIdentity(await lstat(liveDatabase, { bigint: true }));
            if (!sameFileObject(rollbackCandidate.fileIdentity, restored)) {
                throw transitionFailure();
            }
        } else {
            await unlink(path.join(`/proc/self/fd/${state.handle.fd}`, databaseFileName));
            await requireMissing(liveDatabase);
        }
        await state.handle.sync();
    } catch {
        failed = true;
    }
    const [candidateClosed, stateClosed] = await Promise.all([
        closeHandle(candidateDirectory?.handle),
        closeHandle(state.handle),
    ]);
    if (failed || !candidateClosed || !stateClosed) throw transitionFailure();
}

/**
 * Removes one private transition workspace after commit or rollback completes.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param workspace Branded workspace owned by this transition.
 * @returns Completion after the bounded workspace is absent.
 */
export async function discardDatabaseTransitionWorkspace(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    workspace: DatabaseTransitionWorkspace
): Promise<void> {
    if (
        workspace[workspaceBrand] !== true ||
        lease.stateDirectory !== paths.stateDirectory ||
        workspace.root !==
            path.join(
                paths.stateDirectory,
                `.database-transition-${workspace.transitionId}`
            )
    ) {
        throw transitionFailure();
    }
    await removeOwnedWorkspace(paths.stateDirectory, workspace.transitionId);
}

/**
 * Removes the exact deterministic workspace named by a durable recovery journal.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param transitionId Canonical journal transition identifier.
 * @returns Completion after the workspace is absent.
 */
export async function discardOrphanDatabaseTransitionWorkspace(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    transitionId: string
): Promise<void> {
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        !v.is(lowercaseUuidV7Schema(), transitionId)
    ) {
        throw transitionFailure();
    }
    await removeOwnedWorkspace(paths.stateDirectory, transitionId);
}

function previousFromJournal(
    paths: PreparedProductionDeliveryPaths,
    journal: ProductionActivationTransition
): PublishedDatabaseSnapshotResult {
    if (journal.previousDatabase.state === "unrecorded") {
        throw transitionFailure();
    }
    if (journal.previousDatabase.state === "absent") {
        return Object.freeze({
            state: "absent" as const,
            transitionId: journal.transitionId,
        });
    }
    const snapshotDirectory = path.join(
        paths.stateDirectory,
        "backups",
        journal.transitionId
    );
    return Object.freeze({
        manifest: journal.previousDatabase.manifest,
        snapshotDirectory,
        snapshotFile: path.join(snapshotDirectory, databaseFileName),
        sourceDatabase: journal.previousDatabase.sourceDatabase,
        state: "present" as const,
    });
}

async function pathPresence(candidate: string): Promise<boolean> {
    try {
        await lstat(candidate);
        return true;
    } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw transitionFailure();
    }
}

/**
 * Inspects a crash-interrupted journal and reconstructs only filesystem-proven state.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param journal Durable snapshot-paired activation journal.
 * @returns Whether promotion occurred, with branded recovery tokens when it did.
 */
export async function inspectDatabaseTransitionRecovery(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    journal: ProductionActivationTransition
): Promise<DatabaseTransitionRecovery> {
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        !v.is(lowercaseUuidV7Schema(), journal.transitionId)
    ) {
        throw transitionFailure();
    }
    const previous = previousFromJournal(paths, journal);
    const root = path.join(
        paths.stateDirectory,
        `.database-transition-${journal.transitionId}`
    );
    const candidateDirectory = path.join(root, "candidate");
    const candidateDatabase = path.join(candidateDirectory, databaseFileName);
    const liveDatabase = path.join(paths.stateDirectory, databaseFileName);
    const [rootPresent, livePresent] = await Promise.all([
        pathPresence(root),
        pathPresence(liveDatabase),
    ]);
    const liveStatus = livePresent
        ? await lstat(liveDatabase, { bigint: true })
        : undefined;
    const previousStillLive =
        previous.state === "absent"
            ? !livePresent
            : liveStatus !== undefined &&
              sourceIdentityMatches(liveStatus, previous.sourceDatabase);
    if (previousStillLive) {
        return Object.freeze({
            state: "not-promoted" as const,
            transitionId: journal.transitionId,
        });
    }
    if (!rootPresent || !liveStatus) {
        throw transitionFailure();
    }
    const promotedIdentity = fileIdentity(liveStatus);
    const workspace = Object.freeze({
        [workspaceBrand]: true as const,
        candidateDatabase,
        candidateDirectory,
        previous,
        root,
        transitionId: journal.transitionId,
    });
    return Object.freeze({
        promoted: Object.freeze({
            [promotedBrand]: true as const,
            fileIdentity: promotedIdentity,
            previous,
            transitionId: journal.transitionId,
        }),
        state: "promoted" as const,
        workspace,
    });
}
