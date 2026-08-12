import { Database } from "bun:sqlite";
import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rmdir,
    statfs,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { Effect, Schema } from "effect";
import * as v from "valibot";

import {
    sqliteBackupInventoryMaximum,
    sqliteMaintenanceBackupMaximum,
    type SqliteMaintenanceJobResult,
} from "../../../contracts/database.ts";
import {
    currentDatabaseSnapshotMigrations,
    parseDatabaseSnapshotManifest,
    serializeDatabaseSnapshotManifest,
    type DatabaseSnapshotManifest,
} from "../../../shared/databaseSnapshotManifest.ts";
import {
    fullCommitShaSchema,
    lowercaseUuidV7Schema,
} from "../../../shared/validation.ts";
import { validateVerifiedMigrations } from "../migrations/applyVerifiedMigrations.ts";
import {
    loadVerifiedMigrations,
    type VerifiedMigration,
} from "../migrations/loadVerifiedMigrations.ts";
import {
    assertDatabasePathStillValid,
    dashboardDatabaseFileName,
    prepareDatabasePath,
    type PreparedDatabasePath,
} from "./databasePath.ts";
import {
    checkpointDatabaseTruncate,
    configureDatabaseConnection,
} from "./databasePolicy.ts";

const TaggedErrorClass = Schema.TaggedError;
const snapshotFailureMessage = "Database snapshot creation failed";
const snapshotDatabaseFileName = dashboardDatabaseFileName;
const snapshotManifestFileName = "snapshot-manifest.json";
const maximumSnapshotBytes = 64 * 1024 * 1024 * 1024;
const maximumSnapshotManifestBytes = 64 * 1024;
const snapshotCopyBufferBytes = 1024 * 1024;
const freeSpaceReserveBytes = 64 * 1024 * 1024;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const immutableDirectoryMode = 0o500;
const immutableFileMode = 0o400;
const sqliteMaintenanceDirectoryName = "sqlite-maintenance";
const sqliteMaintenanceEntryMaximum = sqliteMaintenanceBackupMaximum + 4;
const sqliteBackupRootEntryMaximum = 128;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const snapshotFileFlags = constants.O_RDWR | constants.O_NOFOLLOW;
const absolutePathSchema = v.pipe(
    v.string(),
    v.maxLength(4096),
    v.check(
        (value) =>
            path.isAbsolute(value) &&
            path.resolve(value) === value &&
            !value.includes("\0"),
        snapshotFailureMessage
    )
);
const snapshotOptionsSchema = v.variant("expectedState", [
    v.strictObject({
        expectedState: v.literal("absent"),
        stateDirectory: absolutePathSchema,
        transitionId: lowercaseUuidV7Schema(snapshotFailureMessage),
    }),
    v.strictObject({
        expectedState: v.literal("present"),
        migrationsDirectory: absolutePathSchema,
        releaseId: fullCommitShaSchema(snapshotFailureMessage),
        stateDirectory: absolutePathSchema,
        transitionId: lowercaseUuidV7Schema(snapshotFailureMessage),
    }),
]);
const sqliteMaintenanceOptionsSchema = v.strictObject({
    migrationsDirectory: absolutePathSchema,
    releaseId: fullCommitShaSchema(snapshotFailureMessage),
    stateDirectory: absolutePathSchema,
    transitionId: lowercaseUuidV7Schema(snapshotFailureMessage),
});

const quickCheckRowsSchema = v.array(v.strictObject({ quick_check: v.string() }));
const passiveCheckpointRowSchema = v.strictObject({
    busy: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    checkpointed: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    log: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type DatabaseSnapshotOptions = Readonly<
    v.InferOutput<typeof snapshotOptionsSchema>
>;

/** Exact fixed inputs for one isolated online SQLite maintenance process. */
export type SqliteMaintenanceSnapshotOptions = Readonly<
    v.InferOutput<typeof sqliteMaintenanceOptionsSchema>
>;
/** Sanitized path-free completion returned by the isolated maintenance process. */
export type SqliteMaintenanceSnapshotResult = SqliteMaintenanceJobResult;

/** Path-free immutable snapshot metadata admitted to the read model. */
export interface SqliteMaintenanceSnapshotInventory {
    readonly backups: readonly {
        readonly bytes: number;
        readonly createdAtMs: number;
        readonly kind: "cutover" | "scheduled";
        readonly restoreVerifiedAtMs?: number;
        readonly verificationLevel: "manifest-verified" | "restore-copy-verified";
    }[];
    readonly totalBytes: number;
}

export type DatabaseSnapshotResult =
    | Readonly<{ state: "absent"; transitionId: string }>
    | Readonly<{
          manifest: DatabaseSnapshotManifest;
          snapshotDirectory: string;
          snapshotFile: string;
          sourceDatabase: DatabaseSnapshotSourceIdentity;
          state: "present";
      }>;

/** Stable live-file identity observed after checkpoint and before snapshot publication. */
export interface DatabaseSnapshotSourceIdentity {
    readonly ctimeNs: string;
    readonly device: string;
    readonly inode: string;
    readonly mtimeNs: string;
    readonly size: string;
}

/** Deterministic mutation boundaries exposed only to adversarial tests. */
export interface DatabaseSnapshotTestHooks {
    readonly afterSnapshotCreated?: (snapshotFile: string) => Promise<void> | void;
    readonly afterSnapshotFileOpen?: (snapshotFile: string) => Promise<void> | void;
    readonly afterSnapshotFrozen?: (snapshotDirectory: string) => Promise<void> | void;
}

/** Deterministic mutation boundary for adversarial maintenance-restore tests. */
export interface SqliteMaintenanceSnapshotTestHooks {
    readonly afterRetiredDirectorySynced?: (ownedName: string) => Promise<void> | void;
    readonly afterRetiredFileRemoved?: (
        ownedName: string,
        fileName: string
    ) => Promise<void> | void;
    readonly afterRestoreCopyCreated?: (restoreCopyFile: string) => Promise<void> | void;
    readonly beforeOwnedSnapshotRetired?: (ownedName: string) => Promise<void> | void;
}

/** Sanitized failure from the delivery-owned snapshot boundary. */
export class DatabaseSnapshotError extends TaggedErrorClass<DatabaseSnapshotError>(
    "mira-dashboard/server/database/runtime/DatabaseSnapshotError"
)("DatabaseSnapshotError", { message: Schema.String }) {}

interface DirectoryIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
}

interface OpenedDirectory {
    readonly handle: FileHandle;
    readonly identity: DirectoryIdentity;
    readonly path: string;
}

interface SnapshotFileIdentity {
    readonly bytes: number;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly sha256: string;
}

function sourceDatabaseIdentity(status: BigIntStats): DatabaseSnapshotSourceIdentity {
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1n) {
        throw snapshotFailure();
    }
    return Object.freeze({
        ctimeNs: status.ctimeNs.toString(),
        device: status.dev.toString(),
        inode: status.ino.toString(),
        mtimeNs: status.mtimeNs.toString(),
        size: status.size.toString(),
    });
}

function sameSourceDatabaseIdentity(
    left: DatabaseSnapshotSourceIdentity,
    right: DatabaseSnapshotSourceIdentity
): boolean {
    return (
        left.ctimeNs === right.ctimeNs &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mtimeNs === right.mtimeNs &&
        left.size === right.size
    );
}

function snapshotFailure(): Error {
    return new Error(snapshotFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function identity(status: BigIntStats): DirectoryIdentity {
    return Object.freeze({ dev: status.dev, ino: status.ino });
}

function sameIdentity(status: BigIntStats, expected: DirectoryIdentity): boolean {
    return status.dev === expected.dev && status.ino === expected.ino;
}

function validDirectory(
    status: BigIntStats,
    expectedMode: bigint,
    userId: number
): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & 0o7777n) === expectedMode
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

async function openStableDirectory(
    directory: string,
    expectedMode: bigint,
    expectedDevice?: bigint
): Promise<OpenedDirectory> {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw snapshotFailure();
    }
    let handle: FileHandle | undefined;
    let opened: OpenedDirectory | undefined;
    try {
        handle = await open(directory, directoryFlags);
        const [held, after, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        const heldIdentity = identity(held);
        if (
            canonical !== directory ||
            !validDirectory(held, expectedMode, process.getuid()) ||
            !validDirectory(after, expectedMode, process.getuid()) ||
            !sameIdentity(after, heldIdentity) ||
            (expectedDevice !== undefined && held.dev !== expectedDevice)
        ) {
            throw snapshotFailure();
        }
        opened = Object.freeze({ handle, identity: heldIdentity, path: directory });
    } catch {
        await closeHandle(handle);
        throw snapshotFailure();
    }
    return opened;
}

async function revalidateDirectory(
    directory: OpenedDirectory,
    expectedMode: bigint
): Promise<void> {
    if (typeof process.getuid !== "function") throw snapshotFailure();
    const [held, current, canonical] = await Promise.all([
        directory.handle.stat({ bigint: true }),
        lstat(directory.path, { bigint: true }),
        realpath(`/proc/self/fd/${directory.handle.fd}`),
    ]);
    if (
        canonical !== directory.path ||
        !validDirectory(held, expectedMode, process.getuid()) ||
        !validDirectory(current, expectedMode, process.getuid()) ||
        !sameIdentity(held, directory.identity) ||
        !sameIdentity(current, directory.identity)
    ) {
        throw snapshotFailure();
    }
}

async function requireMissing(candidate: string): Promise<void> {
    try {
        await lstat(candidate);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw snapshotFailure();
    }
    throw snapshotFailure();
}

async function requireSidecarsAbsent(databaseFile: string): Promise<void> {
    for (const suffix of ["-journal", "-shm", "-wal"] as const) {
        await requireMissing(`${databaseFile}${suffix}`);
    }
}

async function requireSnapshotCapacity(
    sourceFile: string,
    backupsDirectory: string
): Promise<void> {
    const [source, filesystem] = await Promise.all([
        lstat(sourceFile, { bigint: true }),
        statfs(backupsDirectory, { bigint: true }),
    ]);
    const maximum = BigInt(maximumSnapshotBytes);
    const reserve = BigInt(freeSpaceReserveBytes);
    const available = filesystem.bavail * filesystem.bsize;
    if (
        !source.isFile() ||
        source.isSymbolicLink() ||
        source.size <= 0n ||
        source.size > maximum ||
        available < source.size + reserve
    ) {
        throw snapshotFailure();
    }
}

function configureSnapshotValidationConnection(database: Database): void {
    database.run("PRAGMA busy_timeout = 0");
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA ignore_check_constraints = OFF");
    database.run("PRAGMA trusted_schema = OFF");
}

function checkpointSourceDatabase(database: Database): void {
    Effect.runSync(checkpointDatabaseTruncate(database));
}

function vacuumInto(database: Database, destination: string): void {
    const statement = database.prepare<never, [string]>("VACUUM INTO ?");
    try {
        statement.run(destination);
    } finally {
        statement.finalize();
    }
}

function verifySnapshotDatabase(
    snapshotFile: string,
    migrations: readonly VerifiedMigration[]
): void {
    const database = new Database(snapshotFile, { readonly: true, strict: true });
    try {
        if (database.filename !== snapshotFile) throw snapshotFailure();
        configureSnapshotValidationConnection(database);
        validateVerifiedMigrations(database, migrations);
    } finally {
        database.close(true);
    }
}

async function hashAndFreezeSnapshotFile(
    snapshotFile: string,
    expectedDevice: bigint,
    afterOpen?: (snapshotFile: string) => Promise<void> | void
): Promise<SnapshotFileIdentity> {
    if (typeof process.getuid !== "function") throw snapshotFailure();
    let handle: FileHandle | undefined;
    let result: SnapshotFileIdentity | undefined;
    try {
        handle = await open(snapshotFile, snapshotFileFlags);
        const held = await handle.stat({ bigint: true });
        const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
        if (
            canonical !== snapshotFile ||
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== BigInt(process.getuid()) ||
            held.dev !== expectedDevice ||
            held.size <= 0n ||
            held.size > BigInt(maximumSnapshotBytes)
        ) {
            throw snapshotFailure();
        }
        await afterOpen?.(snapshotFile);
        await handle.sync();
        const hasher = new Bun.CryptoHasher("sha256");
        const buffer = Buffer.alloc(Math.min(snapshotCopyBufferBytes, Number(held.size)));
        let offset = 0;
        while (offset < Number(held.size)) {
            const length = Math.min(buffer.byteLength, Number(held.size) - offset);
            const read = await handle.read(buffer, 0, length, offset);
            if (read.bytesRead <= 0) throw snapshotFailure();
            hasher.update(buffer.subarray(0, read.bytesRead));
            offset += read.bytesRead;
        }
        await handle.chmod(immutableFileMode);
        await handle.sync();
        const [after, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(snapshotFile, { bigint: true }),
        ]);
        if (
            after.dev !== held.dev ||
            after.ino !== held.ino ||
            after.size !== held.size ||
            after.nlink !== 1n ||
            (after.mode & 0o7777n) !== 0o400n ||
            !pathAfter.isFile() ||
            pathAfter.isSymbolicLink() ||
            pathAfter.dev !== held.dev ||
            pathAfter.ino !== held.ino ||
            pathAfter.size !== held.size ||
            pathAfter.nlink !== 1n ||
            pathAfter.uid !== BigInt(process.getuid()) ||
            (pathAfter.mode & 0o7777n) !== 0o400n
        ) {
            throw snapshotFailure();
        }
        result = Object.freeze({
            bytes: Number(held.size),
            dev: held.dev,
            ino: held.ino,
            sha256: hasher.digest("hex"),
        });
    } catch {
        throw snapshotFailure();
    } finally {
        const closed = await closeHandle(handle);
        if (!closed) result = undefined;
    }
    if (!result) throw snapshotFailure();
    return result;
}

async function writeSnapshotManifest(
    manifestFile: string,
    manifest: DatabaseSnapshotManifest
): Promise<void> {
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(
            manifestFile,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            privateFileMode
        );
        const bytes = new TextEncoder().encode(
            serializeDatabaseSnapshotManifest(manifest)
        );
        if (bytes.byteLength > maximumSnapshotManifestBytes) throw snapshotFailure();
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(immutableFileMode);
        await handle.sync();
        const status = await handle.stat({ bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !status.isFile() ||
            status.nlink !== 1n ||
            status.uid !== BigInt(process.getuid()) ||
            status.size !== BigInt(bytes.byteLength) ||
            (status.mode & 0o7777n) !== 0o400n
        ) {
            throw snapshotFailure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw snapshotFailure();
}

async function verifyFrozenSnapshot(
    snapshotDirectory: string,
    expected: DatabaseSnapshotManifest,
    expectedFile: SnapshotFileIdentity
): Promise<void> {
    if (typeof process.getuid !== "function") throw snapshotFailure();
    const snapshotFile = path.join(snapshotDirectory, snapshotDatabaseFileName);
    const manifestFile = path.join(snapshotDirectory, snapshotManifestFileName);
    const [directory, entries] = await Promise.all([
        lstat(snapshotDirectory, { bigint: true }),
        readdir(snapshotDirectory),
    ]);
    if (
        !validDirectory(directory, 0o500n, process.getuid()) ||
        directory.dev !== expectedFile.dev ||
        entries.length !== 2 ||
        entries.toSorted().join("\0") !==
            [snapshotDatabaseFileName, snapshotManifestFileName].toSorted().join("\0")
    ) {
        throw snapshotFailure();
    }
    const rawManifest = await readImmutableSnapshotManifest(
        manifestFile,
        expectedFile.dev
    );
    const parsed = parseDatabaseSnapshotManifest(JSON.parse(rawManifest) as unknown);
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw snapshotFailure();

    const observed = await hashImmutableSnapshot(snapshotFile, expectedFile);
    if (
        observed.bytes !== expectedFile.bytes ||
        observed.sha256 !== expectedFile.sha256
    ) {
        throw snapshotFailure();
    }
}

async function readImmutableSnapshotManifest(
    manifestFile: string,
    expectedDevice: bigint
): Promise<string> {
    let handle: FileHandle | undefined;
    let result: string | undefined;
    try {
        if (typeof process.getuid !== "function") throw snapshotFailure();
        handle = await open(
            manifestFile,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const held = await handle.stat({ bigint: true });
        const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
        if (
            canonical !== manifestFile ||
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== BigInt(process.getuid()) ||
            held.dev !== expectedDevice ||
            held.size <= 0n ||
            held.size > BigInt(maximumSnapshotManifestBytes) ||
            (held.mode & 0o7777n) !== 0o400n
        ) {
            throw snapshotFailure();
        }
        const contents = Buffer.alloc(Number(held.size) + 1);
        let offset = 0;
        while (offset < contents.byteLength) {
            const read = await handle.read(
                contents,
                offset,
                contents.byteLength - offset,
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
            throw snapshotFailure();
        }
        result = new TextDecoder("utf-8", { fatal: true }).decode(
            contents.subarray(0, offset)
        );
    } catch {
        throw snapshotFailure();
    } finally {
        const closed = await closeHandle(handle);
        if (!closed) result = undefined;
    }
    if (result === undefined) throw snapshotFailure();
    return result;
}

async function hashImmutableSnapshot(
    snapshotFile: string,
    expected: SnapshotFileIdentity
): Promise<Pick<SnapshotFileIdentity, "bytes" | "sha256">> {
    let handle: FileHandle | undefined;
    let result: Pick<SnapshotFileIdentity, "bytes" | "sha256"> | undefined;
    try {
        handle = await open(
            snapshotFile,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const status = await handle.stat({ bigint: true });
        const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
        if (
            typeof process.getuid !== "function" ||
            canonical !== snapshotFile ||
            !status.isFile() ||
            status.nlink !== 1n ||
            status.uid !== BigInt(process.getuid()) ||
            status.dev !== expected.dev ||
            status.ino !== expected.ino ||
            status.size !== BigInt(expected.bytes) ||
            (status.mode & 0o7777n) !== 0o400n
        ) {
            throw snapshotFailure();
        }
        const hasher = new Bun.CryptoHasher("sha256");
        const buffer = Buffer.alloc(
            Math.min(snapshotCopyBufferBytes, Number(status.size))
        );
        let offset = 0;
        while (offset < Number(status.size)) {
            const length = Math.min(buffer.byteLength, Number(status.size) - offset);
            const read = await handle.read(buffer, 0, length, offset);
            if (read.bytesRead <= 0) throw snapshotFailure();
            hasher.update(buffer.subarray(0, read.bytesRead));
            offset += read.bytesRead;
        }
        const [heldAfter, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(snapshotFile, { bigint: true }),
        ]);
        if (
            heldAfter.dev !== status.dev ||
            heldAfter.ino !== status.ino ||
            heldAfter.size !== status.size ||
            heldAfter.ctimeNs !== status.ctimeNs ||
            heldAfter.mtimeNs !== status.mtimeNs ||
            pathAfter.dev !== status.dev ||
            pathAfter.ino !== status.ino ||
            pathAfter.size !== status.size ||
            pathAfter.ctimeNs !== status.ctimeNs ||
            pathAfter.mtimeNs !== status.mtimeNs
        ) {
            throw snapshotFailure();
        }
        result = Object.freeze({
            bytes: Number(status.size),
            sha256: hasher.digest("hex"),
        });
    } catch {
        throw snapshotFailure();
    } finally {
        const closed = await closeHandle(handle);
        if (!closed) result = undefined;
    }
    if (!result) throw snapshotFailure();
    return result;
}

type OwnedSnapshotKind = "final" | "retired" | "stage" | "verify";

interface OwnedSnapshotIdentity {
    readonly device: bigint;
    readonly id: string;
    readonly inode: bigint;
    readonly kind: OwnedSnapshotKind;
    readonly name: string;
}

function isUuidV7(value: string): boolean {
    return v.safeParse(lowercaseUuidV7Schema(), value, { abortEarly: true }).success;
}

function parseOwnedSnapshotName(name: string):
    | {
          readonly id: string;
          readonly kind: OwnedSnapshotKind;
      }
    | undefined {
    if (isUuidV7(name)) return { id: name, kind: "final" };
    for (const [prefix, kind] of [
        [".stage-", "stage"],
        [".verify-", "verify"],
        [".retire-final-", "retired"],
        [".retire-stage-", "retired"],
        [".retire-verify-", "retired"],
        [".retire-", "retired"],
    ] as const) {
        if (!name.startsWith(prefix)) continue;
        const id = name.slice(prefix.length);
        if (isUuidV7(id)) return { id, kind };
    }
    return undefined;
}

function retiredSnapshotName(snapshot: OwnedSnapshotIdentity): string {
    if (snapshot.kind === "retired") return snapshot.name;
    return `.retire-${snapshot.kind}-${snapshot.id}`;
}

async function inspectOwnedSnapshot(
    parent: OpenedDirectory,
    name: string
): Promise<OwnedSnapshotIdentity> {
    const parsed = parseOwnedSnapshotName(name);
    if (parsed === undefined) throw snapshotFailure();
    const anchored = path.join(`/proc/self/fd/${parent.handle.fd}`, name);
    const status = await lstat(anchored, { bigint: true });
    const allowedModes = parsed.kind === "final" ? [0o500n] : [0o500n, 0o700n];
    if (
        typeof process.getuid !== "function" ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.nlink !== 2n ||
        status.uid !== BigInt(process.getuid()) ||
        status.dev !== parent.identity.dev ||
        !allowedModes.includes(status.mode & 0o7777n)
    ) {
        throw snapshotFailure();
    }
    return Object.freeze({
        device: status.dev,
        id: parsed.id,
        inode: status.ino,
        kind: parsed.kind,
        name,
    });
}

async function openOwnedSnapshot(
    parent: OpenedDirectory,
    snapshot: OwnedSnapshotIdentity
): Promise<FileHandle> {
    const anchored = path.join(`/proc/self/fd/${parent.handle.fd}`, snapshot.name);
    let handle: FileHandle | undefined;
    try {
        handle = await open(anchored, directoryFlags);
        const [held, named] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(anchored, { bigint: true }),
        ]);
        const allowedModes = snapshot.kind === "final" ? [0o500n] : [0o500n, 0o700n];
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
            throw snapshotFailure();
        }
        return handle;
    } catch {
        await closeHandle(handle);
        throw snapshotFailure();
    }
}

async function retireOwnedSnapshot(
    parent: OpenedDirectory,
    snapshot: OwnedSnapshotIdentity,
    hooks: SqliteMaintenanceSnapshotTestHooks
): Promise<OwnedSnapshotIdentity> {
    if (snapshot.kind === "retired") return snapshot;
    const retiredName = retiredSnapshotName(snapshot);
    const descriptor = `/proc/self/fd/${parent.handle.fd}`;
    const source = path.join(descriptor, snapshot.name);
    const target = path.join(descriptor, retiredName);
    const child = await openOwnedSnapshot(parent, snapshot);
    let failed = false;
    try {
        await hooks.beforeOwnedSnapshotRetired?.(snapshot.name);
        const named = await lstat(source, { bigint: true });
        if (named.dev !== snapshot.device || named.ino !== snapshot.inode) {
            throw snapshotFailure();
        }
        await rename(source, target);
        const retired = await lstat(target, { bigint: true });
        if (retired.dev !== snapshot.device || retired.ino !== snapshot.inode) {
            throw snapshotFailure();
        }
        await parent.handle.sync();
        await hooks.afterRetiredDirectorySynced?.(snapshot.name);
    } catch {
        failed = true;
    }
    if (!(await closeHandle(child)) || failed) throw snapshotFailure();
    return Object.freeze({
        ...snapshot,
        kind: "retired" as const,
        name: retiredName,
    });
}

async function reapRetiredSnapshot(
    parent: OpenedDirectory,
    snapshot: OwnedSnapshotIdentity,
    hooks: SqliteMaintenanceSnapshotTestHooks
): Promise<void> {
    if (snapshot.kind !== "retired") throw snapshotFailure();
    if (typeof process.getuid !== "function") throw snapshotFailure();
    const expectedUid = BigInt(process.getuid());
    const child = await openOwnedSnapshot(parent, snapshot);
    const descriptor = `/proc/self/fd/${child.fd}`;
    let failed = false;
    try {
        const entries = await readdir(descriptor, { withFileTypes: true });
        if (
            entries.length > 2 ||
            entries.some(
                (entry) =>
                    !entry.isFile() ||
                    ![snapshotDatabaseFileName, snapshotManifestFileName].includes(
                        entry.name
                    )
            )
        ) {
            throw snapshotFailure();
        }
        await child.chmod(privateDirectoryMode);
        for (const fileName of [
            snapshotDatabaseFileName,
            snapshotManifestFileName,
        ] as const) {
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
                    held.dev !== parent.identity.dev ||
                    ![0o400n, 0o600n].includes(held.mode & 0o7777n) ||
                    !named.isFile() ||
                    named.isSymbolicLink() ||
                    named.dev !== held.dev ||
                    named.ino !== held.ino ||
                    named.nlink !== 1n ||
                    named.uid !== held.uid ||
                    ![0o400n, 0o600n].includes(named.mode & 0o7777n)
                ) {
                    throw snapshotFailure();
                }
                await file.chmod(privateFileMode);
                await unlink(anchored);
                await hooks.afterRetiredFileRemoved?.(snapshot.name, fileName);
            } catch {
                fileFailed = true;
            }
            if (!(await closeHandle(file)) || fileFailed) throw snapshotFailure();
        }
        const remainingEntries = await readdir(descriptor);
        if (remainingEntries.length > 0) throw snapshotFailure();
        const named = await lstat(
            path.join(`/proc/self/fd/${parent.handle.fd}`, snapshot.name),
            { bigint: true }
        );
        if (named.dev !== snapshot.device || named.ino !== snapshot.inode) {
            throw snapshotFailure();
        }
    } catch {
        failed = true;
    }
    if (!(await closeHandle(child)) || failed) throw snapshotFailure();
    const parentEntry = path.join(`/proc/self/fd/${parent.handle.fd}`, snapshot.name);
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
        throw snapshotFailure();
    }
    await rmdir(parentEntry);
    await parent.handle.sync();
}

async function removeOwnedSnapshot(
    parent: OpenedDirectory,
    ownedName: string,
    hooks: SqliteMaintenanceSnapshotTestHooks = {}
): Promise<void> {
    const snapshot = await inspectOwnedSnapshot(parent, ownedName);
    const retired = await retireOwnedSnapshot(parent, snapshot, hooks);
    await reapRetiredSnapshot(parent, retired, hooks);
}

async function snapshotPresentDatabase(
    options: Extract<DatabaseSnapshotOptions, { expectedState: "present" }>,
    prepared: PreparedDatabasePath,
    hooks: DatabaseSnapshotTestHooks
): Promise<DatabaseSnapshotResult> {
    const state = await openStableDirectory(options.stateDirectory, 0o700n);
    const backupsPath = path.join(options.stateDirectory, "backups");
    let backups: OpenedDirectory | undefined;
    let stage: OpenedDirectory | undefined;
    let database: Database | undefined;
    let ownedName: string | undefined;
    let result: DatabaseSnapshotResult | undefined;
    let expectedSourceIdentity: DatabaseSnapshotSourceIdentity | undefined;
    let failure = false;
    try {
        backups = await openStableDirectory(backupsPath, 0o700n, state.identity.dev);
        await requireSnapshotCapacity(prepared.filePath, backupsPath);
        const migrations = await loadVerifiedMigrations({
            directory: options.migrationsDirectory,
        });
        const finalName = options.transitionId;
        const stageName = `.stage-${options.transitionId}`;
        const backupsDescriptor = `/proc/self/fd/${backups.handle.fd}`;
        await requireMissing(path.join(backupsDescriptor, finalName));
        await requireMissing(path.join(backupsDescriptor, stageName));
        await mkdir(path.join(backupsDescriptor, stageName), {
            mode: privateDirectoryMode,
        });
        ownedName = stageName;
        const stagePath = path.join(backupsPath, stageName);
        stage = await openStableDirectory(stagePath, 0o700n, backups.identity.dev);
        const snapshotFile = path.join(stagePath, snapshotDatabaseFileName);

        database = new Database(prepared.filePath, {
            create: false,
            readwrite: true,
            strict: true,
        });
        if (database.filename !== prepared.filePath) throw snapshotFailure();
        configureDatabaseConnection(database);
        validateVerifiedMigrations(database, migrations);
        checkpointSourceDatabase(database);
        await assertDatabasePathStillValid(prepared);
        vacuumInto(database, snapshotFile);
        await hooks.afterSnapshotCreated?.(snapshotFile);
        await assertDatabasePathStillValid(prepared);
        expectedSourceIdentity = sourceDatabaseIdentity(
            await lstat(prepared.filePath, { bigint: true })
        );
        verifySnapshotDatabase(snapshotFile, migrations);
        const fileIdentity = await hashAndFreezeSnapshotFile(
            snapshotFile,
            backups.identity.dev,
            hooks.afterSnapshotFileOpen
        );
        const manifest = parseDatabaseSnapshotManifest({
            database: {
                bytes: fileIdentity.bytes,
                sha256: fileIdentity.sha256,
            },
            formatVersion: 1,
            migrations: currentDatabaseSnapshotMigrations(),
            releaseId: options.releaseId,
            transitionId: options.transitionId,
        });
        await writeSnapshotManifest(
            path.join(stagePath, snapshotManifestFileName),
            manifest
        );
        await stage.handle.sync();
        await stage.handle.chmod(immutableDirectoryMode);
        await stage.handle.sync();
        await hooks.afterSnapshotFrozen?.(stagePath);
        await revalidateDirectory(stage, 0o500n);
        await revalidateDirectory(backups, 0o700n);
        await rename(
            path.join(backupsDescriptor, stageName),
            path.join(backupsDescriptor, finalName)
        );
        ownedName = finalName;
        await backups.handle.sync();
        const finalDirectory = path.join(backupsPath, finalName);
        await verifyFrozenSnapshot(finalDirectory, manifest, fileIdentity);
        await revalidateDirectory(state, 0o700n);
        await revalidateDirectory(backups, 0o700n);
        ownedName = undefined;
        result = Object.freeze({
            manifest,
            snapshotDirectory: finalDirectory,
            snapshotFile: path.join(finalDirectory, snapshotDatabaseFileName),
            sourceDatabase: expectedSourceIdentity,
            state: "present" as const,
        });
    } catch {
        failure = true;
    }

    let closeFailed = false;
    if (database) {
        try {
            database.close(true);
        } catch {
            closeFailed = true;
        }
    }
    if (!closeFailed) {
        try {
            await requireSidecarsAbsent(prepared.filePath);
            const observedSourceIdentity = sourceDatabaseIdentity(
                await lstat(prepared.filePath, { bigint: true })
            );
            if (
                !expectedSourceIdentity ||
                !sameSourceDatabaseIdentity(
                    expectedSourceIdentity,
                    observedSourceIdentity
                )
            ) {
                throw snapshotFailure();
            }
        } catch {
            closeFailed = true;
        }
    }
    const stageClosed = await closeHandle(stage?.handle);
    if (ownedName && backups && stageClosed) {
        try {
            await removeOwnedSnapshot(backups, ownedName);
        } catch {
            closeFailed = true;
        }
    }
    const [backupsClosed, stateClosed] = await Promise.all([
        closeHandle(backups?.handle),
        closeHandle(state.handle),
    ]);
    if (
        failure ||
        closeFailed ||
        !stageClosed ||
        !backupsClosed ||
        !stateClosed ||
        !result
    ) {
        throw snapshotFailure();
    }
    return result;
}

function uuidV7Timestamp(id: string): number {
    const value = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    if (!Number.isSafeInteger(value) || value < 0) throw snapshotFailure();
    return value;
}

async function openOrCreateMaintenanceDirectory(
    backups: OpenedDirectory
): Promise<OpenedDirectory> {
    const descriptorPath = `/proc/self/fd/${backups.handle.fd}`;
    const candidate = path.join(descriptorPath, sqliteMaintenanceDirectoryName);
    try {
        await mkdir(candidate, { mode: privateDirectoryMode });
        await backups.handle.sync();
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw snapshotFailure();
    }
    return openStableDirectory(
        path.join(backups.path, sqliteMaintenanceDirectoryName),
        0o700n,
        backups.identity.dev
    );
}

interface InternalMaintenanceSnapshotRecord {
    readonly bytes: number;
    readonly createdAtMs: number;
    readonly kind: "cutover" | "scheduled";
    readonly name: string;
    readonly restoreVerifiedAtMs?: number;
    readonly verificationLevel: "manifest-verified" | "restore-copy-verified";
}

async function readMaintenanceSnapshotRecord(
    parent: OpenedDirectory,
    name: string,
    kind: InternalMaintenanceSnapshotRecord["kind"]
): Promise<InternalMaintenanceSnapshotRecord> {
    if (typeof process.getuid !== "function" || !v.is(lowercaseUuidV7Schema(), name)) {
        throw snapshotFailure();
    }
    const directoryPath = path.join(parent.path, name);
    const databaseFile = path.join(directoryPath, snapshotDatabaseFileName);
    const manifestFile = path.join(directoryPath, snapshotManifestFileName);
    const [directory, entries, databaseFileStatus] = await Promise.all([
        lstat(directoryPath, { bigint: true }),
        readdir(directoryPath),
        lstat(databaseFile, { bigint: true }),
    ]);
    if (
        !validDirectory(directory, 0o500n, process.getuid()) ||
        directory.dev !== parent.identity.dev ||
        entries.length !== 2 ||
        entries.toSorted().join("\0") !==
            [snapshotDatabaseFileName, snapshotManifestFileName].toSorted().join("\0") ||
        !databaseFileStatus.isFile() ||
        databaseFileStatus.isSymbolicLink() ||
        databaseFileStatus.nlink !== 1n ||
        databaseFileStatus.uid !== BigInt(process.getuid()) ||
        databaseFileStatus.dev !== parent.identity.dev ||
        databaseFileStatus.size <= 0n ||
        databaseFileStatus.size > BigInt(maximumSnapshotBytes) ||
        (databaseFileStatus.mode & 0o7777n) !== 0o400n
    ) {
        throw snapshotFailure();
    }
    const rawManifest = await readImmutableSnapshotManifest(
        manifestFile,
        parent.identity.dev
    );
    let manifest: DatabaseSnapshotManifest;
    try {
        manifest = parseDatabaseSnapshotManifest(JSON.parse(rawManifest) as unknown);
    } catch {
        throw snapshotFailure();
    }
    const createdAtMs = uuidV7Timestamp(name);
    if (
        createdAtMs > Date.now() ||
        manifest.transitionId !== name ||
        manifest.database.bytes !== Number(databaseFileStatus.size) ||
        (kind === "scheduled" && manifest.restoreVerifiedAtMs === undefined) ||
        (kind === "cutover" && manifest.restoreVerifiedAtMs !== undefined) ||
        (manifest.restoreVerifiedAtMs !== undefined &&
            (manifest.restoreVerifiedAtMs < createdAtMs ||
                manifest.restoreVerifiedAtMs > Date.now()))
    ) {
        throw snapshotFailure();
    }
    return Object.freeze({
        bytes: manifest.database.bytes,
        createdAtMs,
        kind,
        name,
        ...(manifest.restoreVerifiedAtMs === undefined
            ? {}
            : { restoreVerifiedAtMs: manifest.restoreVerifiedAtMs }),
        verificationLevel:
            manifest.restoreVerifiedAtMs === undefined
                ? ("manifest-verified" as const)
                : ("restore-copy-verified" as const),
    });
}

async function listMaintenanceSnapshotRecords(
    maintenance: OpenedDirectory
): Promise<readonly InternalMaintenanceSnapshotRecord[]> {
    const entries = await readdir(maintenance.path, { withFileTypes: true });
    if (entries.length > sqliteMaintenanceEntryMaximum) throw snapshotFailure();
    const records: InternalMaintenanceSnapshotRecord[] = [];
    for (const entry of entries) {
        const parsed = parseOwnedSnapshotName(entry.name);
        if (
            entry.isDirectory() &&
            parsed !== undefined &&
            parsed.kind !== "final" &&
            uuidV7Timestamp(parsed.id) <= Date.now()
        ) {
            continue;
        }
        if (!entry.isDirectory() || parsed === undefined || parsed.kind !== "final") {
            throw snapshotFailure();
        }
        records.push(
            await readMaintenanceSnapshotRecord(maintenance, entry.name, "scheduled")
        );
    }
    records.sort((left, right) => right.name.localeCompare(left.name));
    return Object.freeze(records);
}

async function reconcileStaleMaintenanceTransients(
    maintenance: OpenedDirectory,
    hooks: SqliteMaintenanceSnapshotTestHooks
): Promise<void> {
    const entries = await readdir(maintenance.path, { withFileTypes: true });
    if (entries.length > sqliteMaintenanceEntryMaximum) throw snapshotFailure();
    const stale: string[] = [];
    for (const entry of entries) {
        const parsed = parseOwnedSnapshotName(entry.name);
        if (parsed === undefined || uuidV7Timestamp(parsed.id) > Date.now()) {
            throw snapshotFailure();
        }
        if (entry.isDirectory() && parsed.kind !== "final") {
            stale.push(entry.name);
            continue;
        }
        if (!entry.isDirectory() || parsed.kind !== "final") {
            throw snapshotFailure();
        }
    }
    if (stale.length > 4) throw snapshotFailure();
    for (const ownedName of stale) {
        await removeOwnedSnapshot(maintenance, ownedName, hooks);
    }
    if (stale.length > 0) await maintenance.handle.sync();
    await revalidateDirectory(maintenance, 0o700n);
}

async function listCutoverSnapshotRecords(
    backups: OpenedDirectory
): Promise<readonly InternalMaintenanceSnapshotRecord[]> {
    const entries = await readdir(backups.path, { withFileTypes: true });
    if (entries.length > sqliteBackupRootEntryMaximum) throw snapshotFailure();
    const records: InternalMaintenanceSnapshotRecord[] = [];
    for (const entry of entries) {
        if (entry.name === sqliteMaintenanceDirectoryName && entry.isDirectory()) {
            continue;
        }
        const parsed = parseOwnedSnapshotName(entry.name);
        if (
            entry.isDirectory() &&
            parsed !== undefined &&
            parsed.kind !== "final" &&
            uuidV7Timestamp(parsed.id) <= Date.now()
        ) {
            continue;
        }
        if (!entry.isDirectory() || !v.is(lowercaseUuidV7Schema(), entry.name)) {
            throw snapshotFailure();
        }
        records.push(await readMaintenanceSnapshotRecord(backups, entry.name, "cutover"));
    }
    return Object.freeze(records);
}

function projectMaintenanceInventory(
    records: readonly InternalMaintenanceSnapshotRecord[]
): SqliteMaintenanceSnapshotInventory {
    let totalBytes = 0;
    const backups = records
        .toSorted((left, right) => right.name.localeCompare(left.name))
        .map((record) => {
            const { bytes, createdAtMs, kind, restoreVerifiedAtMs, verificationLevel } =
                record;
            totalBytes += bytes;
            if (!Number.isSafeInteger(totalBytes)) throw snapshotFailure();
            return Object.freeze({
                bytes,
                createdAtMs,
                kind,
                ...(restoreVerifiedAtMs === undefined ? {} : { restoreVerifiedAtMs }),
                verificationLevel,
            });
        });
    if (backups.length > sqliteBackupInventoryMaximum) throw snapshotFailure();
    return Object.freeze({ backups: Object.freeze(backups), totalBytes });
}

/**
 * Reads fixed immutable scheduled and activation/cutover namespaces into path-free metadata.
 * At most 32 manifests (64 KiB each) are admitted; database bytes are never read.
 * @param untrustedStateDirectory Candidate canonical Dashboard state directory.
 * @returns Bounded verified inventory without paths.
 */
export async function readVerifiedSqliteMaintenanceInventory(
    untrustedStateDirectory: string
): Promise<SqliteMaintenanceSnapshotInventory> {
    const parsed = v.safeParse(absolutePathSchema, untrustedStateDirectory, {
        abortEarly: true,
    });
    if (!parsed.success) throw snapshotFailure();
    const state = await openStableDirectory(parsed.output, 0o700n);
    let backups: OpenedDirectory | undefined;
    let maintenance: OpenedDirectory | undefined;
    let result: SqliteMaintenanceSnapshotInventory | undefined;
    let failure = false;
    try {
        backups = await openStableDirectory(
            path.join(parsed.output, "backups"),
            0o700n,
            state.identity.dev
        );
        const maintenancePath = path.join(backups.path, sqliteMaintenanceDirectoryName);
        const maintenanceExists = await lstat(maintenancePath)
            .then(() => true)
            .catch((error: unknown) => {
                if (errorCode(error) === "ENOENT") return false;
                throw snapshotFailure();
            });
        if (maintenanceExists) {
            maintenance = await openStableDirectory(
                maintenancePath,
                0o700n,
                backups.identity.dev
            );
            result = projectMaintenanceInventory([
                ...(await listMaintenanceSnapshotRecords(maintenance)),
                ...(await listCutoverSnapshotRecords(backups)),
            ]);
        } else {
            result = projectMaintenanceInventory(
                await listCutoverSnapshotRecords(backups)
            );
        }
    } catch {
        failure = true;
    } finally {
        const [maintenanceClosed, backupsClosed, stateClosed] = await Promise.all([
            closeHandle(maintenance?.handle),
            closeHandle(backups?.handle),
            closeHandle(state.handle),
        ]);
        if (!maintenanceClosed || !backupsClosed || !stateClosed) failure = true;
    }
    if (failure || result === undefined) throw snapshotFailure();
    return result;
}

function verifyQuickCheck(database: Database): void {
    const parsed = v.safeParse(
        quickCheckRowsSchema,
        database.query("PRAGMA quick_check").all(),
        { abortEarly: true }
    );
    if (
        !parsed.success ||
        parsed.output.length !== 1 ||
        parsed.output[0]?.quick_check !== "ok"
    ) {
        throw snapshotFailure();
    }
}

async function copySnapshotIntoRestoreVerification(
    sourceDirectory: OpenedDirectory,
    verificationDirectory: OpenedDirectory,
    expectedSource: SnapshotFileIdentity
): Promise<BigIntStats> {
    if (typeof process.getuid !== "function") throw snapshotFailure();
    const sourceFile = `/proc/self/fd/${sourceDirectory.handle.fd}/${snapshotDatabaseFileName}`;
    const destinationFile = `/proc/self/fd/${verificationDirectory.handle.fd}/${snapshotDatabaseFileName}`;
    let source: FileHandle | undefined;
    let destination: FileHandle | undefined;
    let copied: BigIntStats | undefined;
    let failure = false;
    try {
        source = await open(
            sourceFile,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        destination = await open(
            destinationFile,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            privateFileMode
        );
        const held = await source.stat({ bigint: true });
        if (
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.dev !== expectedSource.dev ||
            held.ino !== expectedSource.ino ||
            held.nlink !== 1n ||
            held.uid !== BigInt(process.getuid()) ||
            held.size !== BigInt(expectedSource.bytes) ||
            (held.mode & 0o7777n) !== 0o400n
        ) {
            throw snapshotFailure();
        }
        const buffer = Buffer.alloc(
            Math.min(snapshotCopyBufferBytes, expectedSource.bytes)
        );
        let offset = 0;
        while (offset < expectedSource.bytes) {
            const length = Math.min(buffer.byteLength, expectedSource.bytes - offset);
            const read = await source.read(buffer, 0, length, offset);
            if (read.bytesRead <= 0) throw snapshotFailure();
            let written = 0;
            while (written < read.bytesRead) {
                const write = await destination.write(
                    buffer,
                    written,
                    read.bytesRead - written,
                    offset + written
                );
                if (write.bytesWritten <= 0) throw snapshotFailure();
                written += write.bytesWritten;
            }
            offset += read.bytesRead;
        }
        await destination.sync();
        const [sourceAfter, destinationAfter] = await Promise.all([
            source.stat({ bigint: true }),
            destination.stat({ bigint: true }),
        ]);
        if (
            sourceAfter.dev !== held.dev ||
            sourceAfter.ino !== held.ino ||
            sourceAfter.size !== held.size ||
            sourceAfter.ctimeNs !== held.ctimeNs ||
            sourceAfter.mtimeNs !== held.mtimeNs ||
            !destinationAfter.isFile() ||
            destinationAfter.isSymbolicLink() ||
            destinationAfter.dev !== verificationDirectory.identity.dev ||
            destinationAfter.nlink !== 1n ||
            destinationAfter.uid !== BigInt(process.getuid()) ||
            destinationAfter.size !== held.size ||
            (destinationAfter.mode & 0o7777n) !== 0o600n
        ) {
            throw snapshotFailure();
        }
        copied = destinationAfter;
    } catch {
        failure = true;
    }
    const [sourceClosed, destinationClosed] = await Promise.all([
        closeHandle(source),
        closeHandle(destination),
    ]);
    if (failure || !sourceClosed || !destinationClosed || copied === undefined) {
        throw snapshotFailure();
    }
    return copied;
}

async function verifySnapshotRestoreCopy(
    maintenance: OpenedDirectory,
    sourceDirectory: OpenedDirectory,
    transitionId: string,
    expectedSource: SnapshotFileIdentity,
    migrations: readonly VerifiedMigration[],
    hooks: SqliteMaintenanceSnapshotTestHooks
): Promise<number> {
    const verificationName = `.verify-${transitionId}`;
    const maintenanceDescriptor = `/proc/self/fd/${maintenance.handle.fd}`;
    await requireMissing(path.join(maintenanceDescriptor, verificationName));
    await mkdir(path.join(maintenanceDescriptor, verificationName), {
        mode: privateDirectoryMode,
    });
    await maintenance.handle.sync();

    let verification: OpenedDirectory | undefined;
    let verifiedAtMs: number | undefined;
    let failure = false;
    try {
        const verificationPath = path.join(maintenance.path, verificationName);
        verification = await openStableDirectory(
            verificationPath,
            0o700n,
            maintenance.identity.dev
        );
        const copied = await copySnapshotIntoRestoreVerification(
            sourceDirectory,
            verification,
            expectedSource
        );
        const restoreCopyFile = path.join(verificationPath, snapshotDatabaseFileName);
        await hooks.afterRestoreCopyCreated?.(restoreCopyFile);
        const before = await lstat(restoreCopyFile, { bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.dev !== copied.dev ||
            before.ino !== copied.ino ||
            before.nlink !== 1n ||
            before.uid !== BigInt(process.getuid()) ||
            before.size !== copied.size ||
            before.ctimeNs !== copied.ctimeNs ||
            before.mtimeNs !== copied.mtimeNs ||
            (before.mode & 0o7777n) !== 0o600n
        ) {
            throw snapshotFailure();
        }
        const restored = new Database(restoreCopyFile, {
            readonly: true,
            strict: true,
        });
        try {
            if (restored.filename !== restoreCopyFile) throw snapshotFailure();
            configureSnapshotValidationConnection(restored);
            verifyQuickCheck(restored);
            validateVerifiedMigrations(restored, migrations);
        } finally {
            restored.close(true);
        }
        await requireSidecarsAbsent(restoreCopyFile);
        const after = await lstat(restoreCopyFile, { bigint: true });
        if (
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.ctimeNs !== before.ctimeNs ||
            after.mtimeNs !== before.mtimeNs ||
            after.nlink !== 1n ||
            (after.mode & 0o7777n) !== 0o600n
        ) {
            throw snapshotFailure();
        }
        verifiedAtMs = Date.now();
    } catch {
        failure = true;
    }
    const verificationClosed = await closeHandle(verification?.handle);
    let removed = true;
    try {
        await removeOwnedSnapshot(maintenance, verificationName, hooks);
        await maintenance.handle.sync();
    } catch {
        removed = false;
    }
    if (failure || !verificationClosed || !removed || verifiedAtMs === undefined) {
        throw snapshotFailure();
    }
    return verifiedAtMs;
}

function runPassiveCheckpoint(database: Database): {
    readonly busyFrames: number;
    readonly checkpointedFrames: number;
    readonly logFrames: number;
} {
    database.run("PRAGMA optimize");
    const parsed = v.safeParse(
        v.nullable(passiveCheckpointRowSchema),
        database.query("PRAGMA wal_checkpoint(PASSIVE)").get(),
        { abortEarly: true }
    );
    if (!parsed.success || parsed.output === null) throw snapshotFailure();
    return Object.freeze({
        busyFrames: parsed.output.busy,
        checkpointedFrames: parsed.output.checkpointed,
        logFrames: parsed.output.log,
    });
}

async function createOnlineMaintenanceSnapshot(
    untrustedOptions: SqliteMaintenanceSnapshotOptions,
    hooks: SqliteMaintenanceSnapshotTestHooks
): Promise<SqliteMaintenanceJobResult> {
    const parsed = v.safeParse(sqliteMaintenanceOptionsSchema, untrustedOptions, {
        abortEarly: true,
    });
    if (!parsed.success) throw snapshotFailure();
    const options = Object.freeze(parsed.output);
    const prepared = await prepareDatabasePath(options.stateDirectory, false);
    if (!prepared) throw snapshotFailure();
    const state = await openStableDirectory(options.stateDirectory, 0o700n);
    let backups: OpenedDirectory | undefined;
    let maintenance: OpenedDirectory | undefined;
    let stage: OpenedDirectory | undefined;
    let database: Database | undefined;
    let ownedName: string | undefined;
    let result: SqliteMaintenanceJobResult | undefined;
    let failure = false;
    try {
        backups = await openStableDirectory(
            path.join(options.stateDirectory, "backups"),
            0o700n,
            state.identity.dev
        );
        maintenance = await openOrCreateMaintenanceDirectory(backups);
        await reconcileStaleMaintenanceTransients(maintenance, hooks);
        await requireSnapshotCapacity(prepared.filePath, maintenance.path);
        const migrations = await loadVerifiedMigrations({
            directory: options.migrationsDirectory,
        });
        const finalName = options.transitionId;
        const stageName = `.stage-${options.transitionId}`;
        const maintenanceDescriptor = `/proc/self/fd/${maintenance.handle.fd}`;
        await requireMissing(path.join(maintenanceDescriptor, finalName));
        await requireMissing(path.join(maintenanceDescriptor, stageName));
        await mkdir(path.join(maintenanceDescriptor, stageName), {
            mode: privateDirectoryMode,
        });
        ownedName = stageName;
        const stagePath = path.join(maintenance.path, stageName);
        stage = await openStableDirectory(stagePath, 0o700n, maintenance.identity.dev);
        const snapshotFile = path.join(stagePath, snapshotDatabaseFileName);

        database = new Database(prepared.filePath, {
            create: false,
            readwrite: true,
            strict: true,
        });
        if (database.filename !== prepared.filePath) throw snapshotFailure();
        configureDatabaseConnection(database);
        validateVerifiedMigrations(database, migrations);
        await assertDatabasePathStillValid(prepared);
        vacuumInto(database, snapshotFile);
        await assertDatabasePathStillValid(prepared);

        const snapshot = new Database(snapshotFile, { readonly: true, strict: true });
        try {
            if (snapshot.filename !== snapshotFile) throw snapshotFailure();
            configureSnapshotValidationConnection(snapshot);
            verifyQuickCheck(snapshot);
            validateVerifiedMigrations(snapshot, migrations);
        } finally {
            snapshot.close(true);
        }
        const fileIdentity = await hashAndFreezeSnapshotFile(
            snapshotFile,
            maintenance.identity.dev
        );
        const restoreVerifiedAtMs = await verifySnapshotRestoreCopy(
            maintenance,
            stage,
            options.transitionId,
            fileIdentity,
            migrations,
            hooks
        );
        const manifest = parseDatabaseSnapshotManifest({
            database: {
                bytes: fileIdentity.bytes,
                sha256: fileIdentity.sha256,
            },
            formatVersion: 1,
            migrations: currentDatabaseSnapshotMigrations(),
            releaseId: options.releaseId,
            restoreVerifiedAtMs,
            transitionId: options.transitionId,
        });
        await writeSnapshotManifest(
            path.join(stagePath, snapshotManifestFileName),
            manifest
        );
        await stage.handle.sync();
        await stage.handle.chmod(immutableDirectoryMode);
        await stage.handle.sync();
        await revalidateDirectory(stage, 0o500n);
        await revalidateDirectory(maintenance, 0o700n);
        await rename(
            path.join(maintenanceDescriptor, stageName),
            path.join(maintenanceDescriptor, finalName)
        );
        ownedName = finalName;
        await maintenance.handle.sync();
        await verifyFrozenSnapshot(
            path.join(maintenance.path, finalName),
            manifest,
            fileIdentity
        );
        // Publication and frozen-file verification are the commit point. Later
        // retention or result-projection failure must never roll back this new
        // recovery artifact after an older snapshot may already be retired.
        ownedName = undefined;

        const checkpoint = runPassiveCheckpoint(database);
        const records = await listMaintenanceSnapshotRecords(maintenance);
        for (const record of records.slice(sqliteMaintenanceBackupMaximum)) {
            await removeOwnedSnapshot(maintenance, record.name, hooks);
        }
        await maintenance.handle.sync();
        const retained = await listMaintenanceSnapshotRecords(maintenance);
        const inventory = projectMaintenanceInventory(retained);
        result = Object.freeze({
            backupBytes: fileIdentity.bytes,
            backupCreatedAtMs: uuidV7Timestamp(options.transitionId),
            checkpoint,
            completedAtMs: Date.now(),
            retainedBackupCount: inventory.backups.length,
            retainedBackupBytes: inventory.totalBytes,
            status: "completed" as const,
        });
    } catch {
        failure = true;
    }

    let closeFailed = false;
    if (database) {
        try {
            database.close(true);
        } catch {
            closeFailed = true;
        }
    }
    const stageClosed = await closeHandle(stage?.handle);
    if (ownedName && maintenance && stageClosed) {
        try {
            await removeOwnedSnapshot(maintenance, ownedName, hooks);
        } catch {
            closeFailed = true;
        }
    }
    const [maintenanceClosed, backupsClosed, stateClosed] = await Promise.all([
        closeHandle(maintenance?.handle),
        closeHandle(backups?.handle),
        closeHandle(state.handle),
    ]);
    if (
        failure ||
        closeFailed ||
        !stageClosed ||
        !maintenanceClosed ||
        !backupsClosed ||
        !stateClosed ||
        result === undefined
    ) {
        throw snapshotFailure();
    }
    return result;
}

/**
 * Creates one WAL-consistent online snapshot under the fixed maintenance namespace,
 * verifies it before atomic publication, retains fourteen, then runs fixed SQLite upkeep.
 * @param options Fixed release, migrations, state, and transition identity.
 * @param hooks Optional deterministic adversarial test boundaries.
 * @returns Effect yielding one sanitized maintenance result.
 */
export function createVerifiedSqliteMaintenanceSnapshot(
    options: SqliteMaintenanceSnapshotOptions,
    hooks: SqliteMaintenanceSnapshotTestHooks = {}
): Effect.Effect<SqliteMaintenanceJobResult, DatabaseSnapshotError> {
    return Effect.tryPromise({
        catch: () => new DatabaseSnapshotError({ message: snapshotFailureMessage }),
        try: () => createOnlineMaintenanceSnapshot(options, hooks),
    });
}

async function createSnapshot(
    untrustedOptions: DatabaseSnapshotOptions,
    hooks: DatabaseSnapshotTestHooks
): Promise<DatabaseSnapshotResult> {
    const parsed = v.safeParse(snapshotOptionsSchema, untrustedOptions, {
        abortEarly: true,
    });
    if (!parsed.success) throw snapshotFailure();
    const options = Object.freeze(parsed.output);
    const prepared = await prepareDatabasePath(options.stateDirectory, false);
    if (options.expectedState === "absent") {
        if (prepared !== undefined) throw snapshotFailure();
        await requireSidecarsAbsent(
            path.join(options.stateDirectory, dashboardDatabaseFileName)
        );
        return Object.freeze({
            state: "absent" as const,
            transitionId: options.transitionId,
        });
    }
    if (!prepared) throw snapshotFailure();
    return snapshotPresentDatabase(options, prepared, hooks);
}

/**
 * Creates and verifies one release/schema-bound WAL-safe production snapshot.
 * The caller must hold the wider deployment lease and keep all writers stopped.
 * @param options Exact expected live state and current immutable release inputs.
 * @param hooks Deterministic adversarial test boundaries.
 * @returns Typed Effect yielding an absent marker or immutable snapshot artifact.
 */
export function createVerifiedDatabaseSnapshot(
    options: DatabaseSnapshotOptions,
    hooks: DatabaseSnapshotTestHooks = {}
): Effect.Effect<DatabaseSnapshotResult, DatabaseSnapshotError> {
    return Effect.tryPromise({
        catch: () => new DatabaseSnapshotError({ message: snapshotFailureMessage }),
        try: () => createSnapshot(options, hooks),
    });
}
