import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { DatabaseRuntimePathError } from "./databaseErrors.ts";

export const dashboardDatabaseFileName = "mira-dashboard.db";
const dashboardDatabaseSidecarSuffixes = Object.freeze([
    "-journal",
    "-shm",
    "-wal",
] as const);

export interface PreparedDatabasePath {
    readonly directoryIdentity: DatabasePathIdentity;
    readonly existed: boolean;
    readonly filePath: string;
    readonly identity: DatabasePathIdentity;
}

export interface DatabasePathIdentity {
    readonly device: bigint;
    readonly inode: bigint;
}

/** Path-free size and permission metadata for the retained SQLite files. */
export interface DatabasePathDiagnostics {
    readonly databaseBytes: number;
    readonly permissions: {
        readonly dataDirectory: string;
        readonly database: string;
        readonly secure: true;
        readonly shm?: string;
        readonly wal?: string;
    };
    readonly shmBytes: number;
    readonly walBytes: number;
}

function invalidStateDirectory(): DatabaseRuntimePathError {
    return new DatabaseRuntimePathError({
        message: "Database state directory violates the private runtime policy",
        reason: "state-directory-invalid",
    });
}

function invalidDatabaseFile(): DatabaseRuntimePathError {
    return new DatabaseRuntimePathError({
        message: "Database file violates the private runtime policy",
        reason: "database-file-invalid",
    });
}

function currentUserId(): number {
    if (typeof process.getuid !== "function") throw invalidStateDirectory();
    return process.getuid();
}

function isMissingPathFailure(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        return descriptor !== undefined && "value" in descriptor
            ? descriptor.value === "ENOENT"
            : false;
    } catch {
        return false;
    }
}

function matchesPrivateDirectoryPolicy(stat: BigIntStats, userId: number): boolean {
    return (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === BigInt(userId) &&
        (stat.mode & 0o777n) === 0o700n
    );
}

function matchesPrivateDatabaseFilePolicy(stat: BigIntStats, userId: number): boolean {
    return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1n &&
        stat.uid === BigInt(userId) &&
        (stat.mode & 0o777n) === 0o600n
    );
}

function matchesProtectedAncestorPolicy(
    stat: BigIntStats,
    childOwnerId: bigint,
    userId: number
): boolean {
    const ownerId = stat.uid;
    const trustedOwner = ownerId === 0n || ownerId === BigInt(userId);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner) return false;

    const writableByAnotherPrincipal = (stat.mode & 0o022n) !== 0n;
    if (!writableByAnotherPrincipal) return true;

    const sticky = (stat.mode & 0o1000n) !== 0n;
    const protectedChildOwner = childOwnerId === 0n || childOwnerId === BigInt(userId);
    return sticky && protectedChildOwner;
}

function identityOf(stat: BigIntStats): DatabasePathIdentity {
    return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function boundedFileSize(stat: BigIntStats): number {
    if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidDatabaseFile();
    }
    return Number(stat.size);
}

function fileMode(stat: BigIntStats): string {
    return (stat.mode & 0o777n).toString(8).padStart(4, "0");
}

function sameIdentity(
    actual: DatabasePathIdentity,
    expected: DatabasePathIdentity
): boolean {
    return actual.device === expected.device && actual.inode === expected.inode;
}

async function assertProtectedStateDirectoryAncestors(
    stateDirectory: string,
    stateDirectoryStat: BigIntStats,
    userId: number
): Promise<void> {
    let childPath = stateDirectory;
    let childOwnerId = stateDirectoryStat.uid;

    while (true) {
        const parentPath = path.dirname(childPath);
        if (parentPath === childPath) return;

        const parentStat = await lstat(parentPath, { bigint: true });
        if (!matchesProtectedAncestorPolicy(parentStat, childOwnerId, userId)) {
            throw invalidStateDirectory();
        }
        childPath = parentPath;
        childOwnerId = parentStat.uid;
    }
}

async function assertCanonicalPrivateStateDirectory(stateDirectory: string): Promise<{
    directory: string;
    identity: DatabasePathIdentity;
    userId: number;
}> {
    if (
        !path.isAbsolute(stateDirectory) ||
        stateDirectory.includes("\0") ||
        path.resolve(stateDirectory) !== stateDirectory
    ) {
        throw invalidStateDirectory();
    }

    try {
        const [canonicalDirectory, stat] = await Promise.all([
            realpath(stateDirectory),
            lstat(stateDirectory, { bigint: true }),
        ]);
        const userId = currentUserId();
        if (
            canonicalDirectory !== stateDirectory ||
            !matchesPrivateDirectoryPolicy(stat, userId)
        ) {
            throw invalidStateDirectory();
        }
        await assertProtectedStateDirectoryAncestors(canonicalDirectory, stat, userId);
        return {
            directory: canonicalDirectory,
            identity: identityOf(stat),
            userId,
        };
    } catch (error) {
        if (error instanceof DatabaseRuntimePathError) throw error;
        throw invalidStateDirectory();
    }
}

async function privateDatabaseFileStat(
    filePath: string,
    userId: number
): Promise<BigIntStats | undefined> {
    try {
        const stat = await lstat(filePath, { bigint: true });
        if (!matchesPrivateDatabaseFilePolicy(stat, userId)) {
            throw invalidDatabaseFile();
        }
        return stat;
    } catch (error) {
        if (error instanceof DatabaseRuntimePathError) throw error;
        if (isMissingPathFailure(error)) return undefined;
        throw invalidDatabaseFile();
    }
}

async function assertPrivateDatabaseSidecars(
    filePath: string,
    userId: number
): Promise<void> {
    for (const suffix of dashboardDatabaseSidecarSuffixes) {
        await privateDatabaseFileStat(`${filePath}${suffix}`, userId);
    }
}

async function createPrivateDatabaseFile(filePath: string): Promise<boolean> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let created: boolean | undefined;
    let failed = false;
    try {
        file = await open(
            filePath,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            0o600
        );
        created = true;
    } catch (error) {
        if (isMissingPathFailure(error)) {
            failed = true;
        }
        if (
            typeof error === "object" &&
            error !== null &&
            Object.getOwnPropertyDescriptor(error, "code")?.value === "EEXIST"
        ) {
            created = false;
        } else {
            failed = true;
        }
    }
    if (file) {
        try {
            await file.close();
        } catch {
            failed = true;
        }
    }
    if (failed || created === undefined) throw invalidDatabaseFile();
    return created;
}

/**
 * Resolves one fixed database filename beneath a canonical, private state directory.
 * New files are created with no-follow/exclusive semantics before SQLite opens them.
 * @param stateDirectory Canonical private directory owned by the current process user.
 * @param createIfMissing Whether an absent fixed database file may be created.
 * @returns Validated file identity, or undefined for absent validate-only state.
 */
export async function prepareDatabasePath(
    stateDirectory: string,
    createIfMissing: boolean
): Promise<PreparedDatabasePath | undefined> {
    const {
        directory,
        identity: directoryIdentity,
        userId,
    } = await assertCanonicalPrivateStateDirectory(stateDirectory);
    const filePath = path.join(directory, dashboardDatabaseFileName);
    await assertPrivateDatabaseSidecars(filePath, userId);
    let stat = await privateDatabaseFileStat(filePath, userId);
    let existed = stat !== undefined;

    if (!stat && !createIfMissing) return undefined;
    if (!stat) {
        const created = await createPrivateDatabaseFile(filePath);
        existed = !created;
        stat = await privateDatabaseFileStat(filePath, userId);
    }
    if (!stat) throw invalidDatabaseFile();

    return Object.freeze({
        directoryIdentity,
        existed,
        filePath,
        identity: identityOf(stat),
    });
}

/** Revalidates the requested file identity after the native SQLite path open. */
export async function assertDatabasePathStillValid(
    prepared: PreparedDatabasePath
): Promise<void> {
    try {
        const stateDirectory = await assertCanonicalPrivateStateDirectory(
            path.dirname(prepared.filePath)
        );
        if (
            path.join(stateDirectory.directory, dashboardDatabaseFileName) !==
                prepared.filePath ||
            !sameIdentity(stateDirectory.identity, prepared.directoryIdentity)
        ) {
            throw invalidStateDirectory();
        }
        const userId = stateDirectory.userId;
        const stat = await privateDatabaseFileStat(prepared.filePath, userId);
        if (!stat || !sameIdentity(identityOf(stat), prepared.identity)) {
            throw invalidDatabaseFile();
        }
        await assertPrivateDatabaseSidecars(prepared.filePath, userId);
    } catch (error) {
        if (error instanceof DatabaseRuntimePathError) throw error;
        throw invalidDatabaseFile();
    }
}

/**
 * Revalidates the fixed runtime files and returns only path-free diagnostics.
 * Missing WAL/SHM sidecars are represented as zero bytes and an absent mode.
 * @param prepared Acquisition-time path identities owned by the runtime scope.
 * @returns Bounded file sizes and exact permission modes without path disclosure.
 */
export async function readDatabasePathDiagnostics(
    prepared: PreparedDatabasePath
): Promise<DatabasePathDiagnostics> {
    try {
        const stateDirectory = await assertCanonicalPrivateStateDirectory(
            path.dirname(prepared.filePath)
        );
        if (
            path.join(stateDirectory.directory, dashboardDatabaseFileName) !==
                prepared.filePath ||
            !sameIdentity(stateDirectory.identity, prepared.directoryIdentity)
        ) {
            throw invalidStateDirectory();
        }
        const database = await privateDatabaseFileStat(
            prepared.filePath,
            stateDirectory.userId
        );
        if (!database || !sameIdentity(identityOf(database), prepared.identity)) {
            throw invalidDatabaseFile();
        }
        const [shm, wal] = await Promise.all([
            privateDatabaseFileStat(`${prepared.filePath}-shm`, stateDirectory.userId),
            privateDatabaseFileStat(`${prepared.filePath}-wal`, stateDirectory.userId),
        ]);
        // The rollback journal is not presented, but it remains part of the
        // path-safety revalidation for the retained SQLite connection.
        await privateDatabaseFileStat(
            `${prepared.filePath}-journal`,
            stateDirectory.userId
        );

        return Object.freeze({
            databaseBytes: boundedFileSize(database),
            permissions: Object.freeze({
                dataDirectory: fileMode(
                    await lstat(stateDirectory.directory, { bigint: true })
                ),
                database: fileMode(database),
                secure: true as const,
                ...(shm === undefined ? {} : { shm: fileMode(shm) }),
                ...(wal === undefined ? {} : { wal: fileMode(wal) }),
            }),
            shmBytes: shm === undefined ? 0 : boundedFileSize(shm),
            walBytes: wal === undefined ? 0 : boundedFileSize(wal),
        });
    } catch (error) {
        if (error instanceof DatabaseRuntimePathError) throw error;
        throw invalidDatabaseFile();
    }
}
