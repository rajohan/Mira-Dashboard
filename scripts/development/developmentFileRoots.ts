import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";

const createFileOpenFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const directoryOpenFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const existingFileOpenFlags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const privateDirectoryMode = 0o700;
const privateDirectoryModeBigInt = 0o700n;
const privateFileMode = 0o600;
const privateFileModeBigInt = 0o600n;
const permissionBits = 0o7777n;
const reviewedOpenClawFiles = Object.freeze([
    Object.freeze({ contents: "{}\n", segments: Object.freeze(["openclaw.json"]) }),
    Object.freeze({
        contents: "",
        segments: Object.freeze(["hooks", "transforms", "agentmail.ts"]),
    }),
] as const);

interface EntryIdentity {
    readonly device: bigint;
    readonly inode: bigint;
}

interface HeldDirectory {
    readonly canonicalPath: string;
    readonly childName?: string;
    readonly descriptorPath: string;
    readonly handle: FileHandle;
    readonly identity: EntryIdentity;
    readonly parent?: HeldDirectory;
}

interface HeldReviewedFile {
    readonly canonicalPath: string;
    readonly childName: string;
    readonly created: boolean;
    readonly handle: FileHandle;
    readonly identity: EntryIdentity;
    readonly parent: HeldDirectory;
}

/** Deterministic mutation points exposed only to adversarial tests. */
export type DevelopmentFileRootPreparationStage =
    | "before-child-mutation"
    | "directory-opened"
    | "file-opened";

/**
 * Test-only hooks; production state preparation leaves these absent.
 * @internal
 */
export interface DevelopmentFileRootPreparationTestHooks {
    readonly afterStage?: (
        stage: DevelopmentFileRootPreparationStage,
        segments: readonly string[],
        created?: boolean
    ) => Promise<void> | void;
}

function invalidDevelopmentFileRoot(cause?: unknown): Error {
    return new Error(
        "Development file root is invalid",
        cause === undefined ? undefined : { cause }
    );
}

function errorCode(error: unknown): unknown {
    if (typeof error !== "object" || error === null) return undefined;
    try {
        return Object.getOwnPropertyDescriptor(error, "code")?.value;
    } catch {
        return undefined;
    }
}

function identityOf(status: BigIntStats): EntryIdentity {
    return Object.freeze({ device: status.dev, inode: status.ino });
}

function hasIdentity(status: BigIntStats, identity: EntryIdentity): boolean {
    return status.dev === identity.device && status.ino === identity.inode;
}

function descriptorPath(handle: FileHandle): string {
    return `/proc/self/fd/${handle.fd}`;
}

function runtimeUserId(): bigint {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw invalidDevelopmentFileRoot();
    }
    return BigInt(process.getuid());
}

function validOwnedDirectory(
    status: BigIntStats,
    userId: bigint,
    stateDevice: bigint
): boolean {
    return status.isDirectory() && status.uid === userId && status.dev === stateDevice;
}

function validPrivateDirectory(
    status: BigIntStats,
    userId: bigint,
    stateDevice: bigint
): boolean {
    return (
        validOwnedDirectory(status, userId, stateDevice) &&
        (status.mode & permissionBits) === privateDirectoryModeBigInt
    );
}

function validReviewedFile(
    status: BigIntStats,
    userId: bigint,
    stateDevice: bigint,
    requirePrivateMode: boolean
): boolean {
    return (
        status.isFile() &&
        status.nlink === 1n &&
        status.uid === userId &&
        status.dev === stateDevice &&
        (requirePrivateMode
            ? (status.mode & permissionBits) === privateFileModeBigInt
            : (status.mode & 0o002n) === 0n)
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

async function closeHandles(handles: readonly FileHandle[]): Promise<boolean> {
    let closed = true;
    for (const handle of handles.toReversed()) {
        if (!(await closeHandle(handle))) closed = false;
    }
    return closed;
}

async function openStateRoot(
    stateRoot: string,
    userId: bigint,
    resources: FileHandle[]
): Promise<HeldDirectory> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(stateRoot, directoryOpenFlags);
        const heldDescriptorPath = descriptorPath(handle);
        const [canonicalPath, entry, held] = await Promise.all([
            realpath(heldDescriptorPath),
            lstat(stateRoot, { bigint: true }),
            handle.stat({ bigint: true }),
        ]);
        const identity = identityOf(held);
        if (
            canonicalPath !== stateRoot ||
            !validPrivateDirectory(held, userId, held.dev) ||
            !validPrivateDirectory(entry, userId, held.dev) ||
            !hasIdentity(entry, identity)
        ) {
            throw invalidDevelopmentFileRoot();
        }
        resources.push(handle);
        return Object.freeze({
            canonicalPath,
            descriptorPath: heldDescriptorPath,
            handle,
            identity,
        });
    } catch (error) {
        if (handle && !resources.includes(handle)) await closeHandle(handle);
        throw invalidDevelopmentFileRoot(error);
    }
}

async function preparePrivateChildDirectory(
    parent: HeldDirectory,
    childName: string,
    segments: readonly string[],
    userId: bigint,
    stateDevice: bigint,
    resources: FileHandle[],
    testHooks?: DevelopmentFileRootPreparationTestHooks
): Promise<HeldDirectory> {
    const anchoredPath = path.join(parent.descriptorPath, childName);
    const canonicalPath = path.join(parent.canonicalPath, childName);
    let created = false;
    await revalidateVisibleDirectory(parent, userId, stateDevice);
    await testHooks?.afterStage?.(
        "before-child-mutation",
        Object.freeze(segments.slice(0, -1))
    );
    try {
        await mkdir(anchoredPath, { mode: privateDirectoryMode });
        created = true;
        await parent.handle.sync();
    } catch (error) {
        if (errorCode(error) !== "EEXIST") {
            throw invalidDevelopmentFileRoot(error);
        }
    }

    let handle: FileHandle | undefined;
    try {
        handle = await open(anchoredPath, directoryOpenFlags);
        const heldDescriptorPath = descriptorPath(handle);
        const [resolvedPath, entry, held] = await Promise.all([
            realpath(heldDescriptorPath),
            // The pathname result is accepted only when it still identifies the
            // O_NOFOLLOW-held descriptor opened above.
            lstat(anchoredPath, { bigint: true }),
            handle.stat({ bigint: true }),
        ]);
        const identity = identityOf(held);
        if (
            resolvedPath !== canonicalPath ||
            !validOwnedDirectory(held, userId, stateDevice) ||
            !validOwnedDirectory(entry, userId, stateDevice) ||
            !hasIdentity(entry, identity)
        ) {
            throw invalidDevelopmentFileRoot();
        }
        resources.push(handle);
        const directory = Object.freeze({
            canonicalPath,
            childName,
            descriptorPath: heldDescriptorPath,
            handle,
            identity,
            parent,
        });
        await testHooks?.afterStage?.(
            "directory-opened",
            Object.freeze([...segments]),
            created
        );
        await handle.chmod(privateDirectoryMode);
        await handle.sync();
        const [after, entryAfter, parentAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(anchoredPath, { bigint: true }),
            parent.handle.stat({ bigint: true }),
        ]);
        if (
            !hasIdentity(after, identity) ||
            !validPrivateDirectory(after, userId, stateDevice) ||
            !hasIdentity(entryAfter, identity) ||
            !validPrivateDirectory(entryAfter, userId, stateDevice) ||
            !hasIdentity(parentAfter, parent.identity) ||
            !validPrivateDirectory(parentAfter, userId, stateDevice)
        ) {
            throw invalidDevelopmentFileRoot();
        }
        return directory;
    } catch (error) {
        if (handle && !resources.includes(handle)) await closeHandle(handle);
        throw invalidDevelopmentFileRoot(error);
    }
}

async function prepareReviewedFile(
    parent: HeldDirectory,
    childName: string,
    contents: string,
    segments: readonly string[],
    userId: bigint,
    stateDevice: bigint,
    resources: FileHandle[],
    testHooks?: DevelopmentFileRootPreparationTestHooks
): Promise<HeldReviewedFile> {
    const anchoredPath = path.join(parent.descriptorPath, childName);
    const canonicalPath = path.join(parent.canonicalPath, childName);
    let created = false;
    let handle: FileHandle | undefined;
    try {
        await revalidateVisibleDirectory(parent, userId, stateDevice);
        await testHooks?.afterStage?.(
            "before-child-mutation",
            Object.freeze(segments.slice(0, -1))
        );
        try {
            handle = await open(anchoredPath, createFileOpenFlags, privateFileMode);
            created = true;
        } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
            // EEXIST only selects reuse. The held parent and O_NOFOLLOW confine
            // this open; its inode is matched to the anchored entry before return.
            handle = await open(anchoredPath, existingFileOpenFlags);
        }
        const heldDescriptorPath = descriptorPath(handle);
        const [resolvedPath, entry, held] = await Promise.all([
            realpath(heldDescriptorPath),
            lstat(anchoredPath, { bigint: true }),
            handle.stat({ bigint: true }),
        ]);
        const identity = identityOf(held);
        if (
            resolvedPath !== canonicalPath ||
            !validReviewedFile(held, userId, stateDevice, false) ||
            !validReviewedFile(entry, userId, stateDevice, false) ||
            !hasIdentity(entry, identity)
        ) {
            throw invalidDevelopmentFileRoot();
        }
        resources.push(handle);
        const reviewedFile = Object.freeze({
            canonicalPath,
            childName,
            created,
            handle,
            identity,
            parent,
        });
        await testHooks?.afterStage?.(
            "file-opened",
            Object.freeze([...segments]),
            created
        );
        if (created) {
            await handle.chmod(privateFileMode);
            await handle.writeFile(contents, "utf8");
            await handle.sync();
            await parent.handle.sync();
        }
        const [after, entryAfter, parentAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(anchoredPath, { bigint: true }),
            parent.handle.stat({ bigint: true }),
        ]);
        if (
            !hasIdentity(after, identity) ||
            !validReviewedFile(after, userId, stateDevice, created) ||
            (created && after.size !== BigInt(Buffer.byteLength(contents, "utf8"))) ||
            !hasIdentity(entryAfter, identity) ||
            !validReviewedFile(entryAfter, userId, stateDevice, created) ||
            !hasIdentity(parentAfter, parent.identity) ||
            !validPrivateDirectory(parentAfter, userId, stateDevice)
        ) {
            throw invalidDevelopmentFileRoot();
        }
        return reviewedFile;
    } catch (error) {
        if (handle && !resources.includes(handle)) await closeHandle(handle);
        throw invalidDevelopmentFileRoot(error);
    }
}

async function revalidateVisibleDirectory(
    directory: HeldDirectory,
    userId: bigint,
    stateDevice: bigint
): Promise<void> {
    let visible: FileHandle | undefined;
    let operationFailure: unknown;
    try {
        const held = await directory.handle.stat({ bigint: true });
        if (
            !hasIdentity(held, directory.identity) ||
            !validPrivateDirectory(held, userId, stateDevice)
        ) {
            throw invalidDevelopmentFileRoot();
        }
        if (directory.parent && directory.childName) {
            const anchoredEntry = await lstat(
                path.join(directory.parent.descriptorPath, directory.childName),
                { bigint: true }
            );
            if (
                !hasIdentity(anchoredEntry, directory.identity) ||
                !validPrivateDirectory(anchoredEntry, userId, stateDevice)
            ) {
                throw invalidDevelopmentFileRoot();
            }
        }
        visible = await open(directory.canonicalPath, directoryOpenFlags);
        const [canonicalPath, entry, visibleStatus] = await Promise.all([
            realpath(descriptorPath(visible)),
            lstat(directory.canonicalPath, { bigint: true }),
            visible.stat({ bigint: true }),
        ]);
        if (
            canonicalPath !== directory.canonicalPath ||
            !hasIdentity(entry, directory.identity) ||
            !hasIdentity(visibleStatus, directory.identity) ||
            !validPrivateDirectory(entry, userId, stateDevice) ||
            !validPrivateDirectory(visibleStatus, userId, stateDevice)
        ) {
            throw invalidDevelopmentFileRoot();
        }
    } catch (error) {
        operationFailure = error;
    }
    const closed = await closeHandle(visible);
    if (operationFailure !== undefined || !closed) {
        throw invalidDevelopmentFileRoot(operationFailure);
    }
}

async function revalidateVisibleFile(
    reviewedFile: HeldReviewedFile,
    userId: bigint,
    stateDevice: bigint
): Promise<void> {
    let visible: FileHandle | undefined;
    let operationFailure: unknown;
    try {
        const held = await reviewedFile.handle.stat({ bigint: true });
        const anchoredEntry = await lstat(
            path.join(reviewedFile.parent.descriptorPath, reviewedFile.childName),
            { bigint: true }
        );
        if (
            !hasIdentity(held, reviewedFile.identity) ||
            !hasIdentity(anchoredEntry, reviewedFile.identity) ||
            !validReviewedFile(held, userId, stateDevice, reviewedFile.created) ||
            !validReviewedFile(anchoredEntry, userId, stateDevice, reviewedFile.created)
        ) {
            throw invalidDevelopmentFileRoot();
        }
        visible = await open(reviewedFile.canonicalPath, existingFileOpenFlags);
        const [canonicalPath, entry, visibleStatus] = await Promise.all([
            realpath(descriptorPath(visible)),
            lstat(reviewedFile.canonicalPath, { bigint: true }),
            visible.stat({ bigint: true }),
        ]);
        if (
            canonicalPath !== reviewedFile.canonicalPath ||
            !hasIdentity(entry, reviewedFile.identity) ||
            !hasIdentity(visibleStatus, reviewedFile.identity) ||
            !validReviewedFile(entry, userId, stateDevice, reviewedFile.created) ||
            !validReviewedFile(visibleStatus, userId, stateDevice, reviewedFile.created)
        ) {
            throw invalidDevelopmentFileRoot();
        }
    } catch (error) {
        operationFailure = error;
    }
    const closed = await closeHandle(visible);
    if (operationFailure !== undefined || !closed) {
        throw invalidDevelopmentFileRoot(operationFailure);
    }
}

function validateConfiguredRoots(config: DevelopmentStackConfig): void {
    if (
        config.openClawRoot !== path.join(config.stateRoot, "openclaw-home") ||
        config.workspaceRoot !== path.join(config.stateRoot, "workspace")
    ) {
        throw invalidDevelopmentFileRoot();
    }
}

/**
 * Prepares the private development Files roots through one held state-root descriptor.
 * Existing reviewed files are reused; absent targets are created and fsynced in place.
 * @param config Validated development stack configuration.
 * @param testHooks Deterministic adversarial hooks used only by focused tests.
 */
export async function prepareDevelopmentFileRoots(
    config: DevelopmentStackConfig,
    testHooks?: DevelopmentFileRootPreparationTestHooks
): Promise<void> {
    validateConfiguredRoots(config);
    const resources: FileHandle[] = [];
    const directories: HeldDirectory[] = [];
    const files: HeldReviewedFile[] = [];
    let failed = false;
    try {
        const userId = runtimeUserId();
        const stateRoot = await openStateRoot(config.stateRoot, userId, resources);
        directories.push(stateRoot);
        const stateDevice = stateRoot.identity.device;
        const openClawRoot = await preparePrivateChildDirectory(
            stateRoot,
            "openclaw-home",
            ["openclaw-home"],
            userId,
            stateDevice,
            resources,
            testHooks
        );
        const workspaceRoot = await preparePrivateChildDirectory(
            stateRoot,
            "workspace",
            ["workspace"],
            userId,
            stateDevice,
            resources,
            testHooks
        );
        directories.push(openClawRoot, workspaceRoot);
        const hooksRoot = await preparePrivateChildDirectory(
            openClawRoot,
            "hooks",
            ["openclaw-home", "hooks"],
            userId,
            stateDevice,
            resources,
            testHooks
        );
        directories.push(hooksRoot);
        const transformsRoot = await preparePrivateChildDirectory(
            hooksRoot,
            "transforms",
            ["openclaw-home", "hooks", "transforms"],
            userId,
            stateDevice,
            resources,
            testHooks
        );
        directories.push(transformsRoot);
        const openClawConfig = await prepareReviewedFile(
            openClawRoot,
            "openclaw.json",
            reviewedOpenClawFiles[0].contents,
            ["openclaw-home", ...reviewedOpenClawFiles[0].segments],
            userId,
            stateDevice,
            resources,
            testHooks
        );
        const agentmailTransform = await prepareReviewedFile(
            transformsRoot,
            "agentmail.ts",
            reviewedOpenClawFiles[1].contents,
            ["openclaw-home", ...reviewedOpenClawFiles[1].segments],
            userId,
            stateDevice,
            resources,
            testHooks
        );
        files.push(openClawConfig, agentmailTransform);
        for (const directory of directories) {
            await revalidateVisibleDirectory(directory, userId, stateDevice);
        }
        for (const reviewedFile of files) {
            await revalidateVisibleFile(reviewedFile, userId, stateDevice);
        }
        await revalidateVisibleDirectory(stateRoot, userId, stateDevice);
    } catch {
        failed = true;
    }
    const closed = await closeHandles(resources);
    if (failed || !closed) throw invalidDevelopmentFileRoot();
}
