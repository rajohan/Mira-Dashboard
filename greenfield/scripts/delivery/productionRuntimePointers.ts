import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    open,
    readlink,
    realpath,
    rename,
    symlink,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";

const runtimePointerFailureMessage = "Production runtime pointer update failed";
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

function pointerFailure(): Error {
    return new Error(runtimePointerFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function validPrivateDirectory(status: BigIntStats): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
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

async function openPrivateDirectory(directory: string): Promise<OpenedDirectory> {
    if (process.platform !== "linux") throw pointerFailure();
    let handle: FileHandle | undefined;
    try {
        const before = await lstat(directory, { bigint: true });
        handle = await open(directory, directoryFlags);
        const [held, after, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== directory ||
            !validPrivateDirectory(before) ||
            !validPrivateDirectory(held) ||
            !validPrivateDirectory(after) ||
            before.dev !== held.dev ||
            before.ino !== held.ino ||
            after.dev !== held.dev ||
            after.ino !== held.ino
        ) {
            throw pointerFailure();
        }
        return Object.freeze({
            device: held.dev,
            handle,
            inode: held.ino,
            path: directory,
        });
    } catch {
        await closeHandle(handle);
        throw pointerFailure();
    }
}

async function revalidateDirectory(directory: OpenedDirectory): Promise<void> {
    const [held, current, canonical] = await Promise.all([
        directory.handle.stat({ bigint: true }),
        lstat(directory.path, { bigint: true }),
        realpath(`/proc/self/fd/${directory.handle.fd}`),
    ]);
    if (
        canonical !== directory.path ||
        !validPrivateDirectory(held) ||
        !validPrivateDirectory(current) ||
        held.dev !== directory.device ||
        held.ino !== directory.inode ||
        current.dev !== directory.device ||
        current.ino !== directory.inode
    ) {
        throw pointerFailure();
    }
}

async function validateExistingPointer(
    descriptorRoot: string,
    pointerName: string
): Promise<void> {
    const pointerPath = path.join(descriptorRoot, pointerName);
    try {
        const status = await lstat(pointerPath, { bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid())
        ) {
            throw pointerFailure();
        }
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw pointerFailure();
    }
}

async function replaceRelativePointer(
    directory: OpenedDirectory,
    targetName: string
): Promise<void> {
    const descriptorRoot = `/proc/self/fd/${directory.handle.fd}`;
    const pointerName = "current";
    const pointerPath = path.join(descriptorRoot, pointerName);
    const stageName = `.current-${Bun.randomUUIDv7()}`;
    const stagePath = path.join(descriptorRoot, stageName);
    let stageOwned = false;
    try {
        if (
            targetName.length !== 40 ||
            targetName !== targetName.toLowerCase() ||
            /[^0-9a-f]/u.test(targetName)
        ) {
            throw pointerFailure();
        }
        await validateExistingPointer(descriptorRoot, pointerName);
        await symlink(targetName, stagePath, "dir");
        stageOwned = true;
        const stageStatus = await lstat(stagePath, { bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !stageStatus.isSymbolicLink() ||
            stageStatus.uid !== BigInt(process.getuid()) ||
            (await readlink(stagePath)) !== targetName
        ) {
            throw pointerFailure();
        }
        await rename(stagePath, pointerPath);
        stageOwned = false;
        await directory.handle.sync();
        const pointerStatus = await lstat(pointerPath, { bigint: true });
        if (
            !pointerStatus.isSymbolicLink() ||
            pointerStatus.uid !== BigInt(process.getuid()) ||
            (await readlink(pointerPath)) !== targetName ||
            (await realpath(pointerPath)) !== path.join(directory.path, targetName)
        ) {
            throw pointerFailure();
        }
        await revalidateDirectory(directory);
    } catch {
        if (stageOwned) await unlink(stagePath).catch(() => null);
        throw pointerFailure();
    }
}

/**
 * Updates the stopped-service release and Bun runtime pointers for one activation attempt.
 * The activation journal remains authoritative across a crash between the two atomic renames.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local delivery paths.
 * @param release Verified immutable release selected for process startup.
 * @param runtime Verified installed Bun runtime selected by that release.
 */
export async function pointProductionProcessesAtRelease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    release: PublishedProductionRelease,
    runtime: InstalledProductionRuntime
): Promise<void> {
    const releaseId = release.manifest.source.commitSha;
    const runtimeRevision = runtime.identity.revision;
    const bunRoot = path.join(paths.runtimesDirectory, "bun");
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        release.releaseRoot !== path.join(paths.releasesDirectory, releaseId) ||
        runtime.executable !== path.join(bunRoot, runtimeRevision, "bun") ||
        release.manifest.runtime.revision !== runtimeRevision ||
        release.manifest.runtime.version !== runtime.identity.version
    ) {
        throw pointerFailure();
    }
    const releases = await openPrivateDirectory(paths.releasesDirectory);
    let runtimes: OpenedDirectory | undefined;
    let failed = false;
    try {
        runtimes = await openPrivateDirectory(bunRoot);
        await replaceRelativePointer(releases, releaseId);
        await replaceRelativePointer(runtimes, runtimeRevision);
        await revalidateDirectory(releases);
        await revalidateDirectory(runtimes);
    } catch {
        failed = true;
    }
    const [releasesClosed, runtimesClosed] = await Promise.all([
        closeHandle(releases.handle),
        closeHandle(runtimes?.handle),
    ]);
    if (failed || !releasesClosed || !runtimesClosed) throw pointerFailure();
}
