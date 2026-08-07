import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { PreparedProductionStatePaths } from "./productionStateFilesystem.ts";

const deliveryFilesystemFailureMessage =
    "Production delivery path violates the protected project-local filesystem policy";
const privateDirectoryMode = 0o700;
const privateDirectoryModeBigInt = 0o700n;
const directoryOpenFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;

/** Project-local release/runtime directories prepared below production. */
export interface PreparedProductionDeliveryPaths {
    readonly productionDirectory: string;
    readonly releasesDirectory: string;
    readonly runtimesDirectory: string;
    readonly stateDirectory: string;
}

interface DirectoryIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
}

function deliveryFilesystemFailure(): Error {
    return new Error(deliveryFilesystemFailureMessage);
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

function validPrivateDirectory(status: BigIntStats, userId: number): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & 0o7777n) === privateDirectoryModeBigInt
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
    expectedDevice?: bigint
): Promise<{ readonly handle: FileHandle; readonly identity: DirectoryIdentity }> {
    if (typeof process.getuid !== "function") throw deliveryFilesystemFailure();
    let handle: FileHandle | undefined;
    let result:
        | { readonly handle: FileHandle; readonly identity: DirectoryIdentity }
        | undefined;
    let failed = false;
    try {
        handle = await open(directory, directoryOpenFlags);
        const [held, after, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        const observedIdentity = identity(held);
        if (
            canonical !== directory ||
            !validPrivateDirectory(held, process.getuid()) ||
            !validPrivateDirectory(after, process.getuid()) ||
            !sameIdentity(after, observedIdentity) ||
            (expectedDevice !== undefined && held.dev !== expectedDevice)
        ) {
            throw deliveryFilesystemFailure();
        }
        result = Object.freeze({ handle, identity: observedIdentity });
    } catch {
        failed = true;
    }
    if (failed || !result) {
        await closeHandle(handle);
        throw deliveryFilesystemFailure();
    }
    return result;
}

async function preparePrivateChild(
    parentPath: string,
    parent: { readonly handle: FileHandle; readonly identity: DirectoryIdentity },
    childName: string
): Promise<string> {
    if (typeof process.getuid !== "function") throw deliveryFilesystemFailure();
    const childPath = path.join(parentPath, childName);
    const anchoredChild = path.join(`/proc/self/fd/${parent.handle.fd}`, childName);
    try {
        await mkdir(anchoredChild, { mode: privateDirectoryMode });
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw deliveryFilesystemFailure();
    }

    let child: Awaited<ReturnType<typeof openPrivateDirectory>> | undefined;
    let failed = false;
    try {
        await chmodThroughHandle(anchoredChild);
        child = await openPrivateDirectory(childPath, parent.identity.dev);
        const parentAfter = await parent.handle.stat({ bigint: true });
        if (!sameIdentity(parentAfter, parent.identity)) {
            throw deliveryFilesystemFailure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(child?.handle);
    if (failed || !closed || !child) throw deliveryFilesystemFailure();
    return childPath;
}

async function chmodThroughHandle(directory: string): Promise<void> {
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(directory, directoryOpenFlags);
        const before = await handle.stat({ bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !before.isDirectory() ||
            before.uid !== BigInt(process.getuid()) ||
            (before.mode & privateDirectoryModeBigInt) !== privateDirectoryModeBigInt
        ) {
            throw deliveryFilesystemFailure();
        }
        await handle.chmod(privateDirectoryMode);
        const after = await handle.stat({ bigint: true });
        if (
            !sameIdentity(after, identity(before)) ||
            !validPrivateDirectory(after, process.getuid())
        ) {
            throw deliveryFilesystemFailure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw deliveryFilesystemFailure();
}

/**
 * Creates or narrows the project-local release/runtime directories under prepared production.
 * @param statePaths Result of the protected state preparation boundary.
 * @returns Revalidated exact production delivery paths.
 */
export async function prepareProductionDeliveryDirectories(
    statePaths: PreparedProductionStatePaths
): Promise<PreparedProductionDeliveryPaths> {
    const expectedProduction = path.join(statePaths.projectRoot, "production");
    const expectedState = path.join(expectedProduction, "state");
    if (
        statePaths.productionDirectory !== expectedProduction ||
        statePaths.stateDirectory !== expectedState
    ) {
        throw deliveryFilesystemFailure();
    }

    const production = await openPrivateDirectory(expectedProduction);
    let prepared: PreparedProductionDeliveryPaths | undefined;
    let failed = false;
    try {
        const releasesDirectory = await preparePrivateChild(
            expectedProduction,
            production,
            "releases"
        );
        const runtimesDirectory = await preparePrivateChild(
            expectedProduction,
            production,
            "runtimes"
        );
        prepared = Object.freeze({
            productionDirectory: expectedProduction,
            releasesDirectory,
            runtimesDirectory,
            stateDirectory: expectedState,
        });
    } catch {
        failed = true;
    }
    const closed = await closeHandle(production.handle);
    if (failed || !closed || !prepared) throw deliveryFilesystemFailure();
    return prepared;
}
