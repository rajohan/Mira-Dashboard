import { Database } from "bun:sqlite";
import { constants, type BigIntStats } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rm,
    statfs,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { Effect, Schema } from "effect";
import * as v from "valibot";

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

export type DatabaseSnapshotOptions = Readonly<
    v.InferOutput<typeof snapshotOptionsSchema>
>;

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

async function removeOwnedSnapshot(
    backupsDirectory: string,
    ownedName: string
): Promise<void> {
    if (
        ownedName !== path.basename(ownedName) ||
        (!ownedName.startsWith(".stage-") && !v.is(lowercaseUuidV7Schema(), ownedName))
    ) {
        throw snapshotFailure();
    }
    const ownedPath = path.join(backupsDirectory, ownedName);
    try {
        const status = await lstat(ownedPath, { bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid())
        ) {
            throw snapshotFailure();
        }
        await chmod(ownedPath, privateDirectoryMode);
        const entries = await readdir(ownedPath, { withFileTypes: true });
        for (const entry of entries) {
            if (
                !entry.isFile() ||
                (entry.name !== snapshotDatabaseFileName &&
                    entry.name !== snapshotManifestFileName)
            ) {
                throw snapshotFailure();
            }
            await chmod(path.join(ownedPath, entry.name), privateFileMode);
        }
        await rm(ownedPath, { recursive: true });
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw snapshotFailure();
    }
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
    const [stageClosed, backupsClosed, stateClosed] = await Promise.all([
        closeHandle(stage?.handle),
        closeHandle(backups?.handle),
        closeHandle(state.handle),
    ]);
    if (ownedName) {
        try {
            await removeOwnedSnapshot(backupsPath, ownedName);
        } catch {
            closeFailed = true;
        }
    }
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
