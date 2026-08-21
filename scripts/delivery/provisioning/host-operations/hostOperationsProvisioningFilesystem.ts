import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    realpath,
    rename,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
    hostOperationsProvisioningArtifacts,
    hostOperationsProvisioningCreatedDirectories,
    type HostOperationsProvisioningArtifactPolicy,
} from "./policy.ts";

const installationFailureMessage = "Host operations provisioning installation failed";
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const temporaryFileFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const temporaryFileMode = 0o600;
const maximumArtifactBytes = 64 * 1024;

/** Manifest-bound bytes for one exact root provisioning target. */
export type VerifiedHostOperationsProvisioningFile =
    HostOperationsProvisioningArtifactPolicy & {
        readonly bytes: Uint8Array;
        readonly sha256: string;
    };

/** Deterministic race boundaries used only by adversarial filesystem tests. */
export interface HostOperationsProvisioningFilesystemTestHooks {
    readonly beforeRename?: (destinationPath: string) => Promise<void> | void;
}

interface OpenedDirectory {
    readonly device: bigint;
    readonly groupId: number;
    readonly handle: FileHandle;
    readonly inode: bigint;
    readonly path: string;
    readonly userId: number;
}

interface PendingDirectoryCreation {
    readonly expectedPath: string;
    readonly mode: number;
    readonly parent: OpenedDirectory;
}

interface ExistingFileSnapshot {
    readonly changeTimeNs: bigint;
    readonly device: bigint;
    readonly groupId: bigint;
    readonly inode: bigint;
    readonly mode: bigint;
    readonly modifiedTimeNs: bigint;
    readonly size: bigint;
    readonly userId: bigint;
}

interface StagedArtifact {
    readonly destination: string;
    readonly directory: OpenedDirectory;
    readonly existing: ExistingFileSnapshot | undefined;
    readonly file: VerifiedHostOperationsProvisioningFile;
    readonly temporary: string;
    renamed: boolean;
}

function installationFailure(): Error {
    return new Error(installationFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sameDirectoryIdentity(status: BigIntStats, directory: OpenedDirectory): boolean {
    return status.dev === directory.device && status.ino === directory.inode;
}

function validOwnedDirectory(
    status: BigIntStats,
    userId: number,
    groupId: number
): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        status.gid === BigInt(groupId) &&
        (status.mode & 0o022n) === 0n
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

async function openOwnedDirectory(
    openPath: string,
    expectedPath: string,
    userId: number,
    groupId: number
): Promise<OpenedDirectory> {
    let handle: FileHandle | undefined;
    let directory: OpenedDirectory | undefined;
    try {
        handle = await open(openPath, directoryFlags);
        const [held, atPath, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(expectedPath, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== expectedPath ||
            !validOwnedDirectory(held, userId, groupId) ||
            !validOwnedDirectory(atPath, userId, groupId) ||
            atPath.dev !== held.dev ||
            atPath.ino !== held.ino
        ) {
            throw installationFailure();
        }
        directory = Object.freeze({
            device: held.dev,
            groupId,
            handle,
            inode: held.ino,
            path: expectedPath,
            userId,
        });
    } catch {
        await closeHandle(handle);
        throw installationFailure();
    }
    return directory;
}

async function validateOpenedDirectory(directory: OpenedDirectory): Promise<void> {
    const [held, atPath, canonical] = await Promise.all([
        directory.handle.stat({ bigint: true }),
        lstat(directory.path, { bigint: true }),
        realpath(`/proc/self/fd/${directory.handle.fd}`),
    ]);
    if (
        canonical !== directory.path ||
        !sameDirectoryIdentity(held, directory) ||
        !sameDirectoryIdentity(atPath, directory) ||
        !validOwnedDirectory(held, directory.userId, directory.groupId) ||
        !validOwnedDirectory(atPath, directory.userId, directory.groupId)
    ) {
        throw installationFailure();
    }
}

async function openExistingOwnedDirectory(
    parent: OpenedDirectory,
    expectedPath: string,
    userId: number,
    groupId: number
): Promise<OpenedDirectory | undefined> {
    const segment = path.basename(expectedPath);
    const anchoredPath = path.join(`/proc/self/fd/${parent.handle.fd}`, segment);
    try {
        await lstat(anchoredPath, { bigint: true });
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw installationFailure();
    }
    return openOwnedDirectory(anchoredPath, expectedPath, userId, groupId);
}

async function openOrCreateOwnedDirectory(
    parent: OpenedDirectory,
    expectedPath: string,
    userId: number,
    groupId: number,
    creationMode: number
): Promise<OpenedDirectory> {
    const segment = path.basename(expectedPath);
    const anchoredPath = path.join(`/proc/self/fd/${parent.handle.fd}`, segment);
    const existing = await openExistingOwnedDirectory(
        parent,
        expectedPath,
        userId,
        groupId
    );
    if (existing !== undefined) return existing;

    let created = false;
    try {
        await mkdir(anchoredPath, { mode: creationMode });
        created = true;
        await parent.handle.sync();
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw installationFailure();
    }
    const directory = await openOwnedDirectory(
        anchoredPath,
        expectedPath,
        userId,
        groupId
    );
    if (!created) return directory;
    try {
        const before = await directory.handle.stat({ bigint: true });
        await directory.handle.chmod(creationMode);
        await directory.handle.sync();
        const after = await directory.handle.stat({ bigint: true });
        if (
            !sameDirectoryIdentity(before, directory) ||
            !sameDirectoryIdentity(after, directory) ||
            (after.mode & 0o7777n) !== BigInt(creationMode)
        ) {
            throw installationFailure();
        }
        await validateOpenedDirectory(directory);
        return directory;
    } catch {
        await closeHandle(directory.handle);
        throw installationFailure();
    }
}

function destinationBelowRoot(destinationRoot: string, destinationPath: string): string {
    const relative = path.relative(path.parse(destinationPath).root, destinationPath);
    if (
        !path.isAbsolute(destinationPath) ||
        path.resolve(destinationPath) !== destinationPath ||
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw installationFailure();
    }
    return path.join(destinationRoot, relative);
}

function validateFiles(files: readonly VerifiedHostOperationsProvisioningFile[]): void {
    if (
        files.length !== hostOperationsProvisioningArtifacts.length ||
        files.some((file, index) => {
            const expected = hostOperationsProvisioningArtifacts[index];
            return (
                expected === undefined ||
                file.artifactPath !== expected.artifactPath ||
                file.destinationPath !== expected.destinationPath ||
                file.mode !== expected.mode ||
                file.bytes.byteLength < 1 ||
                file.bytes.byteLength > maximumArtifactBytes ||
                !/^[a-f\d]{64}$/u.test(file.sha256) ||
                sha256(file.bytes) !== file.sha256
            );
        })
    ) {
        throw installationFailure();
    }
}

function snapshotExistingFile(
    status: BigIntStats,
    directory: OpenedDirectory,
    expectedMode: number
): ExistingFileSnapshot {
    if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(directory.userId) ||
        status.gid !== BigInt(directory.groupId) ||
        status.dev !== directory.device ||
        (status.mode & 0o7777n) !== BigInt(expectedMode)
    ) {
        throw installationFailure();
    }
    return Object.freeze({
        changeTimeNs: status.ctimeNs,
        device: status.dev,
        groupId: status.gid,
        inode: status.ino,
        mode: status.mode,
        modifiedTimeNs: status.mtimeNs,
        size: status.size,
        userId: status.uid,
    });
}

async function existingFileSnapshot(
    anchoredPath: string,
    directory: OpenedDirectory,
    expectedMode: number
): Promise<ExistingFileSnapshot | undefined> {
    try {
        return snapshotExistingFile(
            await lstat(anchoredPath, { bigint: true }),
            directory,
            expectedMode
        );
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw installationFailure();
    }
}

function sameExistingFile(
    left: ExistingFileSnapshot | undefined,
    right: ExistingFileSnapshot | undefined
): boolean {
    if (!left || !right) return left === right;
    return (
        left.changeTimeNs === right.changeTimeNs &&
        left.device === right.device &&
        left.groupId === right.groupId &&
        left.inode === right.inode &&
        left.mode === right.mode &&
        left.modifiedTimeNs === right.modifiedTimeNs &&
        left.size === right.size &&
        left.userId === right.userId
    );
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const written = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset
        );
        if (written.bytesWritten < 1) throw installationFailure();
        offset += written.bytesWritten;
    }
}

async function readExactFile(
    anchoredPath: string,
    expected: VerifiedHostOperationsProvisioningFile,
    directory: OpenedDirectory
): Promise<void> {
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(anchoredPath, fileReadFlags);
        const held = await handle.stat({ bigint: true });
        if (
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== BigInt(directory.userId) ||
            held.gid !== BigInt(directory.groupId) ||
            held.dev !== directory.device ||
            held.size !== BigInt(expected.bytes.byteLength) ||
            (held.mode & 0o7777n) !== BigInt(expected.mode)
        ) {
            throw installationFailure();
        }
        const contents = Buffer.alloc(expected.bytes.byteLength + 1);
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
        const [heldAfter, atPath] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(anchoredPath, { bigint: true }),
        ]);
        if (
            offset !== expected.bytes.byteLength ||
            heldAfter.dev !== held.dev ||
            heldAfter.ino !== held.ino ||
            heldAfter.ctimeNs !== held.ctimeNs ||
            heldAfter.mtimeNs !== held.mtimeNs ||
            heldAfter.size !== held.size ||
            atPath.dev !== held.dev ||
            atPath.ino !== held.ino ||
            sha256(contents.subarray(0, offset)) !== expected.sha256
        ) {
            throw installationFailure();
        }
    } catch {
        failed = true;
    }
    if (!(await closeHandle(handle))) failed = true;
    if (failed) throw installationFailure();
}

async function stageArtifact(
    directory: OpenedDirectory,
    destination: string,
    file: VerifiedHostOperationsProvisioningFile
): Promise<StagedArtifact> {
    const descriptorRoot = `/proc/self/fd/${directory.handle.fd}`;
    const anchoredDestination = path.join(descriptorRoot, path.basename(destination));
    const temporary = path.join(
        descriptorRoot,
        `.mira-host-operations.${Bun.randomUUIDv7()}.tmp`
    );
    const existing = await existingFileSnapshot(
        anchoredDestination,
        directory,
        file.mode
    );
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(temporary, temporaryFileFlags, temporaryFileMode);
        await handle.chmod(file.mode);
        await writeAll(handle, file.bytes);
        await handle.sync();
        const status = await handle.stat({ bigint: true });
        if (
            !status.isFile() ||
            status.nlink !== 1n ||
            status.uid !== BigInt(directory.userId) ||
            status.gid !== BigInt(directory.groupId) ||
            status.dev !== directory.device ||
            status.size !== BigInt(file.bytes.byteLength) ||
            (status.mode & 0o7777n) !== BigInt(file.mode)
        ) {
            throw installationFailure();
        }
    } catch {
        failed = true;
    }
    if (!(await closeHandle(handle))) failed = true;
    if (failed) {
        try {
            await unlink(temporary);
        } catch {
            // The operation is already failing; no temporary path is ever reused.
        }
        throw installationFailure();
    }
    try {
        await readExactFile(temporary, file, directory);
    } catch {
        try {
            await unlink(temporary);
        } catch {
            // The operation is already failing; no temporary path is ever reused.
        }
        throw installationFailure();
    }
    return {
        destination: anchoredDestination,
        directory,
        existing,
        file,
        renamed: false,
        temporary,
    };
}

async function openDestinationDirectories(
    destinationRoot: string,
    files: readonly VerifiedHostOperationsProvisioningFile[],
    userId: number,
    groupId: number
): Promise<{
    readonly directories: readonly OpenedDirectory[];
    readonly targetDirectories: ReadonlyMap<string, OpenedDirectory>;
}> {
    const directories: OpenedDirectory[] = [];
    const byPath = new Map<string, OpenedDirectory>();
    const pendingCreations = new Map<string, PendingDirectoryCreation>();
    const root = await openOwnedDirectory(
        destinationRoot,
        destinationRoot,
        userId,
        groupId
    );
    directories.push(root);
    byPath.set(destinationRoot, root);
    const creatableDirectories = new Map(
        hostOperationsProvisioningCreatedDirectories.map((directory) => [
            destinationBelowRoot(destinationRoot, directory.destinationPath),
            directory.mode,
        ])
    );
    try {
        for (const file of files) {
            const targetDirectory = path.dirname(
                destinationBelowRoot(destinationRoot, file.destinationPath)
            );
            const relative = path.relative(destinationRoot, targetDirectory);
            if (
                relative === ".." ||
                relative.startsWith(`..${path.sep}`) ||
                path.isAbsolute(relative)
            ) {
                throw installationFailure();
            }
            let current = root;
            let currentPath = destinationRoot;
            const segments = relative.split(path.sep).filter(Boolean);
            for (const [index, segment] of segments.entries()) {
                currentPath = path.join(currentPath, segment);
                const existing = byPath.get(currentPath);
                if (existing) {
                    current = existing;
                    continue;
                }
                const pending = pendingCreations.get(currentPath);
                if (pending !== undefined) {
                    if (index !== segments.length - 1) throw installationFailure();
                    continue;
                }
                const opened = await openExistingOwnedDirectory(
                    current,
                    currentPath,
                    userId,
                    groupId
                );
                if (opened !== undefined) {
                    current = opened;
                    directories.push(current);
                    byPath.set(currentPath, current);
                    continue;
                }
                const mode = creatableDirectories.get(currentPath);
                if (mode === undefined || index !== segments.length - 1) {
                    throw installationFailure();
                }
                pendingCreations.set(
                    currentPath,
                    Object.freeze({ expectedPath: currentPath, mode, parent: current })
                );
            }
        }
        for (const directory of directories) {
            await validateOpenedDirectory(directory);
        }
        for (const file of files) {
            const destination = destinationBelowRoot(
                destinationRoot,
                file.destinationPath
            );
            const targetDirectory = path.dirname(destination);
            const directory = byPath.get(targetDirectory);
            if (directory === undefined) {
                if (!pendingCreations.has(targetDirectory)) {
                    throw installationFailure();
                }
                continue;
            }
            await existingFileSnapshot(
                path.join(
                    `/proc/self/fd/${directory.handle.fd}`,
                    path.basename(destination)
                ),
                directory,
                file.mode
            );
        }
        for (const creation of pendingCreations.values()) {
            await validateOpenedDirectory(creation.parent);
            const created = await openOrCreateOwnedDirectory(
                creation.parent,
                creation.expectedPath,
                userId,
                groupId,
                creation.mode
            );
            directories.push(created);
            byPath.set(creation.expectedPath, created);
        }
        return Object.freeze({
            directories: Object.freeze(directories),
            targetDirectories: byPath,
        });
    } catch {
        for (const directory of directories.toReversed()) {
            await closeHandle(directory.handle);
        }
        throw installationFailure();
    }
}

/**
 * Installs all seven manifest-bound files through held destination descriptors.
 * Source verification and a non-mutating preflight of every existing destination
 * directory and target file complete before the one reviewed support directory may
 * be created. Every file is replaced atomically; no service or policy daemon is activated.
 * @param destinationRoot `/` in production or one explicit test-only filesystem root.
 * @param files Exact ordered source bytes and manifest hashes.
 * @param testHooks Deterministic mutation boundaries for adversarial tests.
 */
export async function installHostOperationsProvisioningFiles(
    destinationRoot: string,
    files: readonly VerifiedHostOperationsProvisioningFile[],
    testHooks: HostOperationsProvisioningFilesystemTestHooks = {}
): Promise<void> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        typeof process.getgid !== "function" ||
        !path.isAbsolute(destinationRoot) ||
        destinationRoot.includes("\0") ||
        destinationRoot.length > 4096 ||
        path.resolve(destinationRoot) !== destinationRoot
    ) {
        throw installationFailure();
    }
    validateFiles(files);
    const opened = await openDestinationDirectories(
        destinationRoot,
        files,
        process.getuid(),
        process.getgid()
    );
    const staged: StagedArtifact[] = [];
    let failed = false;
    try {
        for (const file of files) {
            const destination = destinationBelowRoot(
                destinationRoot,
                file.destinationPath
            );
            const directory = opened.targetDirectories.get(path.dirname(destination));
            if (!directory) throw installationFailure();
            staged.push(await stageArtifact(directory, destination, file));
        }

        for (const directory of opened.directories) {
            await validateOpenedDirectory(directory);
        }
        for (const artifact of staged) {
            const current = await existingFileSnapshot(
                artifact.destination,
                artifact.directory,
                artifact.file.mode
            );
            if (!sameExistingFile(artifact.existing, current)) {
                throw installationFailure();
            }
            await readExactFile(artifact.temporary, artifact.file, artifact.directory);
        }

        for (const artifact of staged) {
            await testHooks.beforeRename?.(artifact.file.destinationPath);
            await validateOpenedDirectory(artifact.directory);
            const current = await existingFileSnapshot(
                artifact.destination,
                artifact.directory,
                artifact.file.mode
            );
            if (!sameExistingFile(artifact.existing, current)) {
                throw installationFailure();
            }
            await rename(artifact.temporary, artifact.destination);
            artifact.renamed = true;
            await artifact.directory.handle.sync();
            await readExactFile(artifact.destination, artifact.file, artifact.directory);
        }

        for (const directory of opened.directories) {
            await validateOpenedDirectory(directory);
        }
    } catch {
        failed = true;
    }
    for (const artifact of staged) {
        if (artifact.renamed) continue;
        try {
            await unlink(artifact.temporary);
        } catch (error) {
            if (errorCode(error) !== "ENOENT") failed = true;
        }
    }
    for (const directory of opened.directories.toReversed()) {
        if (!(await closeHandle(directory.handle))) failed = true;
    }
    if (failed) throw installationFailure();
}
