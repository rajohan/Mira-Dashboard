import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
    type FileHandle,
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
    readdir,
    rename,
    rm,
} from "node:fs/promises";
import path from "node:path";

import { prepareProtectedProductionStatePath } from "../delivery/productionStateFilesystem.ts";
import { prepareDevelopmentFileRoots } from "./developmentFileRoots.ts";
import { readDevelopmentMigrationIdentity } from "./developmentMigrationIdentity.ts";
import { readDevelopmentPrivateFile } from "./developmentPrivateFile.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";
import {
    acquireDevelopmentStateLease,
    type DevelopmentStateLease,
} from "./developmentStateLease.ts";

const databaseMarkerFileName = ".mira-dashboard-development-database.json";
const databaseDirectoryOpenFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const databaseFileNames = Object.freeze([
    "mira-dashboard.db",
    "mira-dashboard.db-journal",
    "mira-dashboard.db-shm",
    "mira-dashboard.db-wal",
] as const);
const markerFileName = ".mira-dashboard-development-state.json";
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

interface DevelopmentStateMarker {
    readonly formatVersion: 1;
    readonly owner: string;
}

interface DevelopmentDatabaseMarker extends DevelopmentStateMarker {
    readonly migrationFingerprint: string;
}

export interface PreparedDevelopmentState {
    readonly database: "created-empty" | "reused" | "schema-reset";
    readonly keyring: string;
    readonly stateDirectory: string;
}

export interface PreparedDevelopmentStateSession {
    readonly migrationFingerprint: string;
    refresh(): Promise<PreparedDevelopmentState>;
    readonly state: PreparedDevelopmentState;
    release(): Promise<void>;
}

function pathsOverlap(left: string, right: string): boolean {
    const relative = path.relative(left, right);
    return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
    );
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await lstat(filePath);
        return true;
    } catch (error) {
        return (
            typeof error === "object" &&
            error !== null &&
            Object.getOwnPropertyDescriptor(error, "code")?.value !== "ENOENT"
        );
    }
}

async function assertPrivateRealDirectory(directoryPath: string): Promise<void> {
    const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
    const [canonical, status] = await Promise.all([
        realpath(directoryPath),
        lstat(directoryPath),
    ]);
    if (
        userId === undefined ||
        canonical !== directoryPath ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== userId
    ) {
        throw new Error("Development state path is invalid");
    }
    await chmod(directoryPath, privateDirectoryMode);
}

function expectedMarker(config: DevelopmentStackConfig): DevelopmentStateMarker {
    return { formatVersion: 1, owner: config.stateOwner };
}

async function writePrivateFile(filePath: string, contents: string): Promise<void> {
    const file = await open(filePath, "wx", privateFileMode);
    try {
        await file.writeFile(contents, "utf8");
        await file.sync();
    } finally {
        await file.close();
    }
}

async function replacePrivateFile(filePath: string, contents: string): Promise<void> {
    const stagingPath = `${filePath}.partial-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
        await writePrivateFile(stagingPath, contents);
        await rename(stagingPath, filePath);
    } catch (error) {
        await rm(stagingPath, { force: true });
        throw error;
    }
}

async function readMarker(config: DevelopmentStackConfig): Promise<void> {
    let parsed: unknown;
    try {
        const status = await lstat(path.join(config.stateRoot, markerFileName));
        if (
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.uid !== process.getuid?.() ||
            (status.mode & 0o777) !== privateFileMode
        ) {
            throw new Error("invalid marker");
        }
        parsed = JSON.parse(
            await readFile(path.join(config.stateRoot, markerFileName), "utf8")
        ) as unknown;
    } catch {
        throw new Error("Development state marker is invalid");
    }
    const marker = parsed as Partial<DevelopmentStateMarker>;
    if (marker.formatVersion !== 1 || marker.owner !== config.stateOwner) {
        throw new Error("Development state belongs to another owner");
    }
}

async function claimState(config: DevelopmentStackConfig): Promise<void> {
    if (
        pathsOverlap(config.repositoryRoot, config.stateRoot) ||
        pathsOverlap(config.stateRoot, config.repositoryRoot)
    ) {
        throw new Error("Development state must remain outside tracked source");
    }
    const alreadyPresent = await pathExists(config.stateRoot);
    if (!alreadyPresent) {
        await mkdir(config.stateRoot, { mode: privateDirectoryMode, recursive: true });
    }
    await assertPrivateRealDirectory(config.stateRoot);
    const markerPath = path.join(config.stateRoot, markerFileName);
    if (await pathExists(markerPath)) {
        await readMarker(config);
        return;
    }
    const stateEntries = await readdir(config.stateRoot);
    if (stateEntries.length > 0) {
        throw new Error("Refusing to claim non-empty development state");
    }
    await writePrivateFile(
        markerPath,
        `${JSON.stringify(expectedMarker(config), undefined, 2)}\n`
    );
}

function expectedDatabaseMarker(
    config: DevelopmentStackConfig,
    migrationFingerprint: string
): DevelopmentDatabaseMarker {
    return {
        formatVersion: 1,
        migrationFingerprint,
        owner: config.stateOwner,
    };
}

async function readDatabaseMarker(
    config: DevelopmentStackConfig
): Promise<DevelopmentDatabaseMarker> {
    const markerPath = path.join(config.stateRoot, databaseMarkerFileName);
    let parsed: unknown;
    try {
        parsed = JSON.parse(
            await readDevelopmentPrivateFile(markerPath, {
                exactMode: privateFileMode,
                maximumBytes: 4096,
            })
        ) as unknown;
    } catch {
        throw new Error("Development database marker is invalid");
    }
    const marker = parsed as Partial<DevelopmentDatabaseMarker>;
    if (
        marker.formatVersion !== 1 ||
        marker.owner !== config.stateOwner ||
        typeof marker.migrationFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(marker.migrationFingerprint)
    ) {
        throw new Error("Development database marker is invalid");
    }
    return marker as DevelopmentDatabaseMarker;
}

function expectedDatabaseDirectory(config: DevelopmentStackConfig): string {
    const expectedDirectory = path.join(config.stateRoot, "production", "state");
    const expectedDatabasePath = path.join(expectedDirectory, databaseFileNames[0]);
    if (config.databasePath !== expectedDatabasePath) {
        throw new Error("Development database path is invalid");
    }
    return expectedDirectory;
}

interface OpenDevelopmentDatabaseDirectory {
    readonly descriptorPath: string;
    readonly handle: FileHandle;
}

async function openDevelopmentDatabaseDirectory(
    config: DevelopmentStackConfig
): Promise<OpenDevelopmentDatabaseDirectory> {
    const expectedDirectory = expectedDatabaseDirectory(config);
    let handle: FileHandle | undefined;
    try {
        handle = await open(expectedDirectory, databaseDirectoryOpenFlags);
        const descriptorPath = `/proc/self/fd/${handle.fd}`;
        const [canonicalPath, entryStatus, heldStatus] = await Promise.all([
            realpath(descriptorPath),
            lstat(expectedDirectory, { bigint: true }),
            handle.stat({ bigint: true }),
        ]);
        if (
            canonicalPath !== expectedDirectory ||
            !entryStatus.isDirectory() ||
            entryStatus.isSymbolicLink() ||
            entryStatus.dev !== heldStatus.dev ||
            entryStatus.ino !== heldStatus.ino ||
            heldStatus.uid !== BigInt(process.getuid?.() ?? -1)
        ) {
            throw new Error("invalid database directory");
        }
        return { descriptorPath, handle };
    } catch (error) {
        if (handle !== undefined) {
            await handle.close().catch(() => {});
        }
        throw new Error("Development database path is invalid", { cause: error });
    }
}

async function removeDevelopmentDatabaseFiles(
    config: DevelopmentStackConfig
): Promise<boolean> {
    const directory = await openDevelopmentDatabaseDirectory(config);
    let removed = false;
    try {
        for (const fileName of databaseFileNames) {
            const databasePath = path.join(directory.descriptorPath, fileName);
            let status;
            try {
                status = await lstat(databasePath);
            } catch (error) {
                if (
                    typeof error === "object" &&
                    error !== null &&
                    Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT"
                ) {
                    continue;
                }
                throw error;
            }
            if (
                !status.isFile() ||
                status.isSymbolicLink() ||
                status.uid !== process.getuid?.()
            ) {
                throw new Error("Development database path is invalid");
            }
            await rm(databasePath);
            removed = true;
        }
    } finally {
        await directory.handle.close();
    }
    return removed;
}

async function writeDatabaseMarker(
    config: DevelopmentStackConfig,
    migrationFingerprint: string
): Promise<void> {
    const markerPath = path.join(config.stateRoot, databaseMarkerFileName);
    if (await pathExists(markerPath)) await readDatabaseMarker(config);
    await replacePrivateFile(
        markerPath,
        `${JSON.stringify(expectedDatabaseMarker(config, migrationFingerprint), undefined, 2)}\n`
    );
}

async function reconcileDevelopmentDatabase(
    config: DevelopmentStackConfig,
    migrationFingerprint: string
): Promise<boolean> {
    const markerPath = path.join(config.stateRoot, databaseMarkerFileName);
    const marker = (await pathExists(markerPath))
        ? await readDatabaseMarker(config)
        : undefined;
    const expected = expectedDatabaseMarker(config, migrationFingerprint);
    const needsReset =
        marker === undefined ||
        marker.migrationFingerprint !== expected.migrationFingerprint;
    const removed = needsReset ? await removeDevelopmentDatabaseFiles(config) : false;
    if (marker === undefined || needsReset) {
        await writeDatabaseMarker(config, migrationFingerprint);
    }
    return removed;
}

function serializedKeyring(): string {
    return JSON.stringify({
        activeKeyId: "development",
        formatVersion: 1,
        keys: [
            {
                id: "development",
                keyBase64: randomBytes(32).toString("base64"),
            },
        ],
    });
}

function validSerializedKeyring(value: string): boolean {
    try {
        const parsed = JSON.parse(value) as {
            activeKeyId?: unknown;
            formatVersion?: unknown;
            keys?: unknown;
        };
        if (
            parsed.activeKeyId !== "development" ||
            parsed.formatVersion !== 1 ||
            !Array.isArray(parsed.keys) ||
            parsed.keys.length !== 1
        ) {
            return false;
        }
        const key = parsed.keys[0] as { id?: unknown; keyBase64?: unknown };
        if (key.id !== "development" || typeof key.keyBase64 !== "string") {
            return false;
        }
        const bytes = Buffer.from(key.keyBase64, "base64");
        return bytes.byteLength === 32 && bytes.toString("base64") === key.keyBase64;
    } catch {
        return false;
    }
}

async function developmentKeyring(config: DevelopmentStackConfig): Promise<string> {
    if (!(await pathExists(config.keyringPath))) {
        await writePrivateFile(config.keyringPath, `${serializedKeyring()}\n`);
    }
    let keyringContents: string;
    try {
        keyringContents = await readDevelopmentPrivateFile(config.keyringPath, {
            chmodMode: privateFileMode,
            maximumBytes: 4096,
        });
    } catch (error) {
        throw new Error("Development TOTP keyring is invalid", { cause: error });
    }
    const keyring = keyringContents.trim();
    if (!validSerializedKeyring(keyring)) {
        throw new Error("Development TOTP keyring is invalid");
    }
    return keyring;
}

async function prepareClaimedDevelopmentState(
    config: DevelopmentStackConfig,
    migrationFingerprint: string
): Promise<PreparedDevelopmentState> {
    const prepared = await prepareProtectedProductionStatePath(config.stateRoot);
    if (prepared.stateDirectory !== expectedDatabaseDirectory(config)) {
        throw new Error("Development database path is invalid");
    }
    const didResetDatabase = await reconcileDevelopmentDatabase(
        config,
        migrationFingerprint
    );
    let database: PreparedDevelopmentState["database"];
    if (didResetDatabase) {
        database = "schema-reset";
    } else {
        database = (await pathExists(config.databasePath)) ? "reused" : "created-empty";
    }
    await prepareDevelopmentFileRoots(config);
    const keyring = await developmentKeyring(config);
    return Object.freeze({
        database,
        keyring,
        stateDirectory: prepared.stateDirectory,
    });
}

async function releaseAfterFailure(
    lease: DevelopmentStateLease,
    operationError: unknown
): Promise<never> {
    try {
        await lease.release();
    } catch (releaseError) {
        throw new Error(
            `Development state operation failed and its lease could not be released: ${
                operationError instanceof Error
                    ? operationError.message
                    : "unknown operation failure"
            }`,
            { cause: releaseError }
        );
    }
    throw operationError;
}

/**
 * Prepares isolated state and holds its process lease for a complete runtime session.
 * @param config Validated development stack configuration.
 * @returns Prepared state and an idempotent release function.
 */
export async function prepareDevelopmentRuntimeState(
    config: DevelopmentStackConfig
): Promise<PreparedDevelopmentStateSession> {
    await claimState(config);
    const lease = await acquireDevelopmentStateLease(config);
    let migrationFingerprint: string;
    let state: PreparedDevelopmentState;
    try {
        migrationFingerprint = await readDevelopmentMigrationIdentity(
            config.repositoryRoot
        );
        state = await prepareClaimedDevelopmentState(config, migrationFingerprint);
    } catch (error) {
        return releaseAfterFailure(lease, error);
    }
    return Object.freeze({
        get migrationFingerprint(): string {
            return migrationFingerprint;
        },
        async refresh(): Promise<PreparedDevelopmentState> {
            const nextMigrationFingerprint = await readDevelopmentMigrationIdentity(
                config.repositoryRoot
            );
            const nextState = await prepareClaimedDevelopmentState(
                config,
                nextMigrationFingerprint
            );
            migrationFingerprint = nextMigrationFingerprint;
            state = nextState;
            return nextState;
        },
        async release(): Promise<void> {
            await lease.release();
        },
        get state(): PreparedDevelopmentState {
            return state;
        },
    });
}

/**
 * Opens an already prepared owner-marked state session without importing host state.
 * Managed PR code can reuse only its mounted isolated state and cannot create a new authority.
 * @param config Validated managed-preview stack configuration.
 * @returns Open isolated runtime state session.
 */
export async function openPreparedDevelopmentRuntimeState(
    config: DevelopmentStackConfig
): Promise<PreparedDevelopmentStateSession> {
    await assertPrivateRealDirectory(config.stateRoot);
    await readMarker(config);
    return prepareDevelopmentRuntimeState(config);
}

/**
 * Creates or reuses marked owner-only state without touching production state.
 * @param config Validated development stack configuration.
 * @returns Prepared isolated state plus its database transition.
 */
export async function prepareDevelopmentState(
    config: DevelopmentStackConfig
): Promise<PreparedDevelopmentState> {
    const session = await prepareDevelopmentRuntimeState(config);
    try {
        return session.state;
    } finally {
        await session.release();
    }
}

/**
 * Removes only SQLite state after validating the exact development owner marker.
 * @param config Validated development stack configuration.
 * @returns Whether an existing SQLite file or sidecar was removed.
 */
export async function resetDevelopmentDatabase(
    config: DevelopmentStackConfig
): Promise<boolean> {
    await assertPrivateRealDirectory(config.stateRoot);
    await readMarker(config);
    const lease = await acquireDevelopmentStateLease(config);
    try {
        const prepared = await prepareProtectedProductionStatePath(config.stateRoot);
        if (prepared.stateDirectory !== expectedDatabaseDirectory(config)) {
            throw new Error("Development database path is invalid");
        }
        const removed = await removeDevelopmentDatabaseFiles(config);
        await writeDatabaseMarker(
            config,
            await readDevelopmentMigrationIdentity(config.repositoryRoot)
        );
        return removed;
    } finally {
        await lease.release();
    }
}

/**
 * Removes only a state root carrying this workflow's exact ownership marker.
 * @param config Validated development stack configuration.
 * @returns Completion after the owner-marked state root is removed.
 */
export async function resetDevelopmentState(
    config: DevelopmentStackConfig
): Promise<void> {
    await assertPrivateRealDirectory(config.stateRoot);
    await readMarker(config);
    const lease = await acquireDevelopmentStateLease(config);
    const tombstonePath = `${config.stateRoot}.removed-${process.pid}-${randomBytes(16).toString("hex")}`;
    let detached = false;
    try {
        await rename(config.stateRoot, tombstonePath);
        detached = true;
        lease.consumeAfterStateRootRemoval();
        await rm(tombstonePath, { recursive: true });
    } finally {
        if (!detached) await lease.release();
    }
}
