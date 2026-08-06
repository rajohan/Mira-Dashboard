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

import { productionSystemdUnits } from "./productionSystemdUnitPolicy.ts";

const unitFilesystemFailureMessage = "Production systemd unit installation failed";
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const temporaryFileFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const sourceFileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const privateFileMode = 0o600;
const maximumUnitBytes = 64 * 1024;

/** Manifest-verified bytes for one fixed Dashboard user unit. */
export interface ProductionSystemdUnitFile {
    readonly bytes: Uint8Array;
    readonly fileName: (typeof productionSystemdUnits)[number]["fileName"];
    readonly sha256: string;
}

/** Deterministic external-filesystem boundaries used only by adversarial tests. */
export interface ProductionSystemdUnitFilesystemTestHooks {
    readonly beforeRename?: (fileName: string) => Promise<void> | void;
}

interface OpenedDirectory {
    readonly device: bigint;
    readonly handle: FileHandle;
    readonly inode: bigint;
    readonly path: string;
    readonly userId: number;
}

interface ExistingFileSnapshot {
    readonly device: bigint;
    readonly inode: bigint;
    readonly mode: bigint;
    readonly size: bigint;
    readonly userId: bigint;
}

function unitFilesystemFailure(): Error {
    return new Error(unitFilesystemFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function sameDirectoryIdentity(status: BigIntStats, directory: OpenedDirectory): boolean {
    return status.dev === directory.device && status.ino === directory.inode;
}

function validOwnedDirectory(
    status: BigIntStats,
    userId: number,
    expectedDevice?: bigint
): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & 0o022n) === 0n &&
        (expectedDevice === undefined || status.dev === expectedDevice)
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
    expectedDevice?: bigint
): Promise<OpenedDirectory> {
    let handle: FileHandle | undefined;
    let opened: OpenedDirectory | undefined;
    let failed = false;
    try {
        const before = await lstat(openPath, { bigint: true });
        handle = await open(openPath, directoryFlags);
        const [held, after, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(openPath, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== expectedPath ||
            !validOwnedDirectory(before, userId, expectedDevice) ||
            !validOwnedDirectory(held, userId, expectedDevice) ||
            !validOwnedDirectory(after, userId, expectedDevice) ||
            before.dev !== held.dev ||
            before.ino !== held.ino ||
            after.dev !== held.dev ||
            after.ino !== held.ino
        ) {
            throw unitFilesystemFailure();
        }
        opened = Object.freeze({
            device: held.dev,
            handle,
            inode: held.ino,
            path: expectedPath,
            userId,
        });
    } catch {
        failed = true;
    }
    if (failed || !opened) {
        await closeHandle(handle);
        throw unitFilesystemFailure();
    }
    return opened;
}

async function prepareOwnedChild(
    parent: OpenedDirectory,
    childName: string
): Promise<OpenedDirectory> {
    const anchoredPath = path.join(`/proc/self/fd/${parent.handle.fd}`, childName);
    const expectedPath = path.join(parent.path, childName);
    try {
        await mkdir(anchoredPath, { mode: 0o700 });
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw unitFilesystemFailure();
    }
    const child = await openOwnedDirectory(
        anchoredPath,
        expectedPath,
        parent.userId,
        parent.device
    );
    const parentAfter = await parent.handle.stat({ bigint: true });
    if (!sameDirectoryIdentity(parentAfter, parent)) {
        await closeHandle(child.handle);
        throw unitFilesystemFailure();
    }
    return child;
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function validateUnits(units: readonly ProductionSystemdUnitFile[]): void {
    if (
        units.length !== productionSystemdUnits.length ||
        units.some((unit, index) => {
            const expected = productionSystemdUnits[index];
            return (
                unit.fileName !== expected?.fileName ||
                unit.bytes.byteLength <= 0 ||
                unit.bytes.byteLength > maximumUnitBytes ||
                !/^[a-f\d]{64}$/u.test(unit.sha256) ||
                sha256(unit.bytes) !== unit.sha256
            );
        })
    ) {
        throw unitFilesystemFailure();
    }
}

function snapshotExistingFile(
    status: BigIntStats,
    directory: OpenedDirectory
): ExistingFileSnapshot {
    if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(directory.userId) ||
        status.dev !== directory.device ||
        (status.mode & 0o022n) !== 0n
    ) {
        throw unitFilesystemFailure();
    }
    return Object.freeze({
        device: status.dev,
        inode: status.ino,
        mode: status.mode,
        size: status.size,
        userId: status.uid,
    });
}

async function existingFileSnapshot(
    anchoredPath: string,
    directory: OpenedDirectory
): Promise<ExistingFileSnapshot | undefined> {
    try {
        return snapshotExistingFile(
            await lstat(anchoredPath, { bigint: true }),
            directory
        );
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw unitFilesystemFailure();
    }
}

function sameExistingFile(
    left: ExistingFileSnapshot | undefined,
    right: ExistingFileSnapshot | undefined
): boolean {
    if (!left || !right) return left === right;
    return (
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.userId === right.userId
    );
}

async function readExactHeldFile(
    anchoredPath: string,
    expected: ProductionSystemdUnitFile,
    directory: OpenedDirectory
): Promise<void> {
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        const before = await lstat(anchoredPath, { bigint: true });
        handle = await open(anchoredPath, sourceFileFlags);
        const held = await handle.stat({ bigint: true });
        if (
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== BigInt(directory.userId) ||
            held.dev !== directory.device ||
            held.size !== BigInt(expected.bytes.byteLength) ||
            (held.mode & 0o7777n) !== BigInt(privateFileMode) ||
            before.dev !== held.dev ||
            before.ino !== held.ino
        ) {
            throw unitFilesystemFailure();
        }
        const contents = Buffer.alloc(expected.bytes.byteLength + 1);
        let offset = 0;
        while (offset < contents.byteLength) {
            const result = await handle.read(
                contents,
                offset,
                contents.byteLength - offset,
                offset
            );
            if (result.bytesRead === 0) break;
            offset += result.bytesRead;
        }
        const [heldAfter, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(anchoredPath, { bigint: true }),
        ]);
        if (
            offset !== expected.bytes.byteLength ||
            heldAfter.dev !== held.dev ||
            heldAfter.ino !== held.ino ||
            heldAfter.size !== held.size ||
            pathAfter.dev !== held.dev ||
            pathAfter.ino !== held.ino ||
            sha256(contents.subarray(0, offset)) !== expected.sha256
        ) {
            throw unitFilesystemFailure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw unitFilesystemFailure();
}

async function installUnitFile(
    directory: OpenedDirectory,
    unit: ProductionSystemdUnitFile,
    testHooks: ProductionSystemdUnitFilesystemTestHooks
): Promise<void> {
    const descriptorRoot = `/proc/self/fd/${directory.handle.fd}`;
    const destination = path.join(descriptorRoot, unit.fileName);
    const temporaryName = `.${unit.fileName}.${Bun.randomUUIDv7()}.tmp`;
    const temporary = path.join(descriptorRoot, temporaryName);
    const existing = await existingFileSnapshot(destination, directory);
    let temporaryHandle: FileHandle | undefined;
    let renamed = false;
    let failed = false;
    try {
        temporaryHandle = await open(temporary, temporaryFileFlags, privateFileMode);
        await temporaryHandle.writeFile(unit.bytes);
        await temporaryHandle.sync();
        const temporaryStatus = await temporaryHandle.stat({ bigint: true });
        if (
            !temporaryStatus.isFile() ||
            temporaryStatus.nlink !== 1n ||
            temporaryStatus.uid !== BigInt(directory.userId) ||
            temporaryStatus.dev !== directory.device ||
            temporaryStatus.size !== BigInt(unit.bytes.byteLength) ||
            (temporaryStatus.mode & 0o7777n) !== BigInt(privateFileMode)
        ) {
            throw unitFilesystemFailure();
        }
        if (!(await closeHandle(temporaryHandle))) throw unitFilesystemFailure();
        temporaryHandle = undefined;
        await testHooks.beforeRename?.(unit.fileName);
        const current = await existingFileSnapshot(destination, directory);
        if (!sameExistingFile(existing, current)) throw unitFilesystemFailure();
        await rename(temporary, destination);
        renamed = true;
        await directory.handle.sync();
        await readExactHeldFile(destination, unit, directory);
    } catch {
        failed = true;
    }
    if (!(await closeHandle(temporaryHandle))) failed = true;
    if (!renamed) {
        try {
            await unlink(temporary);
        } catch (error) {
            if (errorCode(error) !== "ENOENT") failed = true;
        }
    }
    if (failed) throw unitFilesystemFailure();
}

/**
 * Atomically installs the two manifest-verified user units below one protected home.
 * @param homeDirectory Canonical current-user home selected by the caller.
 * @param userUnitDirectory Exact `<home>/.config/systemd/user` destination.
 * @param units Exact ordered Dashboard unit bytes and hashes.
 * @param testHooks Deterministic adversarial mutation boundary.
 */
export async function installProductionSystemdUnitFiles(
    homeDirectory: string,
    userUnitDirectory: string,
    units: readonly ProductionSystemdUnitFile[],
    testHooks: ProductionSystemdUnitFilesystemTestHooks = {}
): Promise<void> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        !path.isAbsolute(homeDirectory) ||
        path.resolve(homeDirectory) !== homeDirectory ||
        path.parse(homeDirectory).root === homeDirectory ||
        userUnitDirectory !== path.join(homeDirectory, ".config/systemd/user")
    ) {
        throw unitFilesystemFailure();
    }
    validateUnits(units);
    const userId = process.getuid();
    const opened: OpenedDirectory[] = [];
    let failed = false;
    try {
        const home = await openOwnedDirectory(homeDirectory, homeDirectory, userId);
        opened.push(home);
        let current = home;
        for (const childName of [".config", "systemd", "user"]) {
            current = await prepareOwnedChild(current, childName);
            opened.push(current);
        }
        if (current.path !== userUnitDirectory) throw unitFilesystemFailure();
        for (const unit of units) {
            await installUnitFile(current, unit, testHooks);
        }
        const [heldAfter, pathAfter] = await Promise.all([
            current.handle.stat({ bigint: true }),
            lstat(userUnitDirectory, { bigint: true }),
        ]);
        if (
            !sameDirectoryIdentity(heldAfter, current) ||
            !sameDirectoryIdentity(pathAfter, current) ||
            !validOwnedDirectory(pathAfter, userId, current.device)
        ) {
            throw unitFilesystemFailure();
        }
    } catch {
        failed = true;
    }
    for (const directory of opened.toReversed()) {
        if (!(await closeHandle(directory.handle))) failed = true;
    }
    if (failed) throw unitFilesystemFailure();
}
