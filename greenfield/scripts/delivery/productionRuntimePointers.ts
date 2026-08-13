import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    open,
    readdir,
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
const artifactIdentityPattern = /^[a-f\d]{40}$/u;
const pointerStageNamePattern =
    /^\.current-[a-f\d]{8}-[a-f\d]{4}-7[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u;
const maximumPointerRootEntries = 128;
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

interface ExistingPointer {
    readonly device: bigint;
    readonly inode: bigint;
    readonly target: string;
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
        handle = await open(directory, directoryFlags);
        const [held, after, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== directory ||
            !validPrivateDirectory(held) ||
            !validPrivateDirectory(after) ||
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

function validOwnedSymlink(status: BigIntStats, device: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === device
    );
}

async function inspectExistingPointer(
    directory: OpenedDirectory,
    pointerName: string
): Promise<ExistingPointer | undefined> {
    const descriptorRoot = `/proc/self/fd/${directory.handle.fd}`;
    const pointerPath = path.join(descriptorRoot, pointerName);
    try {
        const before = await lstat(pointerPath, { bigint: true });
        if (!validOwnedSymlink(before, directory.device)) {
            throw pointerFailure();
        }
        const target = await readlink(pointerPath);
        const after = await lstat(pointerPath, { bigint: true });
        if (
            !artifactIdentityPattern.test(target) ||
            !validOwnedSymlink(after, directory.device) ||
            after.dev !== before.dev ||
            after.ino !== before.ino
        ) {
            throw pointerFailure();
        }
        return Object.freeze({
            device: before.dev,
            inode: before.ino,
            target,
        });
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw pointerFailure();
        return undefined;
    }
}

async function removeCrashLeftPointerStages(directory: OpenedDirectory): Promise<void> {
    await revalidateDirectory(directory);
    const descriptorRoot = `/proc/self/fd/${directory.handle.fd}`;
    const entries = await readdir(descriptorRoot, { withFileTypes: true });
    if (entries.length > maximumPointerRootEntries) throw pointerFailure();
    const stages: (ExistingPointer & { readonly name: string })[] = [];
    for (const entry of entries) {
        if (!entry.name.startsWith(".current-")) continue;
        if (!pointerStageNamePattern.test(entry.name) || !entry.isSymbolicLink()) {
            throw pointerFailure();
        }
        const stage = await inspectExistingPointer(directory, entry.name);
        if (!stage) throw pointerFailure();
        stages.push(Object.freeze({ ...stage, name: entry.name }));
    }
    for (const stage of stages) {
        const observed = await inspectExistingPointer(directory, stage.name);
        if (
            !observed ||
            observed.device !== stage.device ||
            observed.inode !== stage.inode ||
            observed.target !== stage.target
        ) {
            throw pointerFailure();
        }
        await unlink(path.join(descriptorRoot, stage.name));
    }
    if (stages.length > 0) await directory.handle.sync();
    await revalidateDirectory(directory);
}

async function clearExistingPointer(
    directory: OpenedDirectory,
    pointerName: string,
    expected: ExistingPointer | undefined
): Promise<void> {
    if (!expected) return;
    const observed = await inspectExistingPointer(directory, pointerName);
    if (
        !observed ||
        observed.device !== expected.device ||
        observed.inode !== expected.inode ||
        observed.target !== expected.target
    ) {
        throw pointerFailure();
    }
    await unlink(path.join(`/proc/self/fd/${directory.handle.fd}`, pointerName));
    await directory.handle.sync();
    if ((await inspectExistingPointer(directory, pointerName)) !== undefined) {
        throw pointerFailure();
    }
    await revalidateDirectory(directory);
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
        if (!artifactIdentityPattern.test(targetName)) {
            throw pointerFailure();
        }
        await inspectExistingPointer(directory, pointerName);
        await symlink(targetName, stagePath, "dir");
        stageOwned = true;
        const stageStatus = await lstat(stagePath, { bigint: true });
        if (
            !validOwnedSymlink(stageStatus, directory.device) ||
            (await readlink(stagePath)) !== targetName
        ) {
            throw pointerFailure();
        }
        await rename(stagePath, pointerPath);
        stageOwned = false;
        await directory.handle.sync();
        const pointer = await inspectExistingPointer(directory, pointerName);
        if (
            pointer?.target !== targetName ||
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
        await removeCrashLeftPointerStages(releases);
        await removeCrashLeftPointerStages(runtimes);
        await inspectExistingPointer(releases, "current");
        await inspectExistingPointer(runtimes, "current");
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

/**
 * Clears stopped-service release/runtime pointers when no activation remains authoritative.
 * A retained rollback journal makes a crash between the two durable unlinks retryable.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local delivery paths.
 */
export async function clearProductionProcessPointers(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths
): Promise<void> {
    const bunRoot = path.join(paths.runtimesDirectory, "bun");
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        paths.releasesDirectory !== path.join(paths.productionDirectory, "releases") ||
        paths.runtimesDirectory !== path.join(paths.productionDirectory, "runtimes")
    ) {
        throw pointerFailure();
    }
    const releases = await openPrivateDirectory(paths.releasesDirectory);
    let runtimes: OpenedDirectory | undefined;
    let failed = false;
    try {
        runtimes = await openPrivateDirectory(bunRoot);
        await removeCrashLeftPointerStages(releases);
        await removeCrashLeftPointerStages(runtimes);
        const releasePointer = await inspectExistingPointer(releases, "current");
        const runtimePointer = await inspectExistingPointer(runtimes, "current");
        await clearExistingPointer(releases, "current", releasePointer);
        await clearExistingPointer(runtimes, "current", runtimePointer);
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
