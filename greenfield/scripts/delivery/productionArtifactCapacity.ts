import type { BigIntStats } from "node:fs";
import { lstat, realpath, statfs } from "node:fs/promises";
import path from "node:path";

import type { ReleaseManifest } from "../../src/shared/releaseManifest.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import { inventoryReleaseArtifactTree } from "./releaseArtifactInventory.ts";
import { verifyReleaseArtifactIdentity } from "./releaseIdentity.ts";

const capacityFailureMessage = "Production artifact capacity admission failed";
const commitShaPattern = /^[a-f\d]{40}$/u;
const maximumRuntimeBytes = 256n * 1024n * 1024n;
const maximumCapacityObjects = 8192;
const privateDirectoryMode = 0o700n;

/** Free space left untouched when admitting a new immutable release/runtime pair. */
export const productionArtifactCapacityReserveBytes = 64n * 1024n * 1024n;

/** Free inodes left untouched when admitting immutable production artifacts. */
export const productionArtifactCapacityReserveInodes = 64n;

/** Exact filesystem capacity used to admit one immutable copy. */
export interface ProductionArtifactFilesystemCapacity {
    readonly availableBytes: bigint;
    readonly availableInodes: bigint;
    readonly blockSize: bigint;
}

/** Logical files and new directories materialized by one immutable copy. */
export interface ProductionArtifactCopyInventory {
    readonly fileBytes: readonly bigint[];
    readonly newDirectoryCount: bigint;
}

/** Read-only source-verification and capacity boundaries exposed to focused tests. */
export interface ProductionArtifactCapacityDependencies {
    readonly availableCapacity?: (
        directory: string
    ) => Promise<ProductionArtifactFilesystemCapacity>;
    readonly verifySourceRelease?: typeof verifyReleaseArtifactIdentity;
}

function failure(): Error {
    return new Error(capacityFailureMessage);
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
        (status.mode & 0o7777n) === privateDirectoryMode
    );
}

async function defaultAvailableCapacity(
    directory: string
): Promise<ProductionArtifactFilesystemCapacity> {
    const status = await statfs(directory, { bigint: true });
    if (status.bsize <= 0n || status.bavail < 0n || status.ffree < 0n) {
        throw failure();
    }
    return Object.freeze({
        availableBytes: status.bsize * status.bavail,
        availableInodes: status.ffree,
        blockSize: status.bsize,
    });
}

function directoryCountForRelease(
    records: Awaited<ReturnType<typeof inventoryReleaseArtifactTree>>
): bigint {
    const directories = new Set<string>([""]);
    for (const record of records) {
        const segments = record.path.split("/");
        for (let index = 1; index < segments.length; index += 1) {
            directories.add(segments.slice(0, index).join("/"));
        }
    }
    return BigInt(directories.size);
}

function roundedAllocation(bytes: bigint, blockSize: bigint): bigint {
    return ((bytes + blockSize - 1n) / blockSize) * blockSize;
}

function assertFitsCapacity(
    capacity: ProductionArtifactFilesystemCapacity,
    inventory: ProductionArtifactCopyInventory
): void {
    const objectCount = BigInt(inventory.fileBytes.length) + inventory.newDirectoryCount;
    if (
        capacity.availableBytes < 0n ||
        capacity.availableInodes < 0n ||
        capacity.blockSize <= 0n ||
        inventory.fileBytes.length === 0 ||
        inventory.fileBytes.length > maximumCapacityObjects ||
        inventory.newDirectoryCount < 0n ||
        objectCount <= 0n ||
        objectCount > BigInt(maximumCapacityObjects) ||
        inventory.fileBytes.some((bytes) => bytes <= 0n)
    ) {
        throw failure();
    }

    const fileAllocationBytes = inventory.fileBytes.reduce(
        (total, bytes) => total + roundedAllocation(bytes, capacity.blockSize),
        0n
    );
    // One additional allocation unit per inode conservatively budgets directory entries,
    // indirect metadata, and small-file filesystem overhead without assuming ext4 internals.
    const requiredAllocationBytes =
        fileAllocationBytes + objectCount * capacity.blockSize;
    if (
        capacity.availableBytes <
            requiredAllocationBytes + productionArtifactCapacityReserveBytes ||
        capacity.availableInodes < objectCount + productionArtifactCapacityReserveInodes
    ) {
        throw failure();
    }
}

/**
 * Re-admits the exact bytes held by one copy operation immediately before its first write.
 * The outer delivery admission budgets the full release/runtime pair; this inner boundary
 * prevents later source replacement or filesystem consumption from spending the reserve.
 * @param destinationDirectory Existing private directory on the filesystem receiving the copy.
 * @param inventory Exact logical files and new directories the caller is about to materialize.
 * @param dependencies Injectable free-space measurement used only by focused tests.
 */
export async function assertProductionArtifactCopyCapacity(
    destinationDirectory: string,
    inventory: ProductionArtifactCopyInventory,
    dependencies: Pick<ProductionArtifactCapacityDependencies, "availableCapacity"> = {}
): Promise<void> {
    try {
        const [canonical, status] = await Promise.all([
            realpath(destinationDirectory),
            lstat(destinationDirectory, { bigint: true }),
        ] as const);
        if (canonical !== destinationDirectory || !validPrivateDirectory(status)) {
            throw failure();
        }
        const capacity = await (
            dependencies.availableCapacity ?? defaultAvailableCapacity
        )(destinationDirectory);
        assertFitsCapacity(capacity, inventory);
    } catch {
        throw failure();
    }
}

async function existingManagedDirectory(
    candidate: string,
    expectedDevice: bigint
): Promise<boolean> {
    try {
        const status = await lstat(candidate, { bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid()) ||
            status.dev !== expectedDevice ||
            ![0o500n, 0o700n].includes(status.mode & 0o7777n)
        ) {
            throw failure();
        }
        return true;
    } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw failure();
    }
}

async function runtimeSourceBytes(sourceExecutable: string): Promise<bigint> {
    try {
        if (
            !path.isAbsolute(sourceExecutable) ||
            sourceExecutable.includes("\0") ||
            path.resolve(sourceExecutable) !== sourceExecutable ||
            (await realpath(sourceExecutable)) !== sourceExecutable
        ) {
            throw failure();
        }
        const status = await lstat(sourceExecutable, { bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.nlink !== 1n ||
            status.uid !== BigInt(process.getuid()) ||
            status.size <= 0n ||
            status.size > maximumRuntimeBytes ||
            (status.mode & 0o100n) === 0n
        ) {
            throw failure();
        }
        return status.size;
    } catch {
        throw failure();
    }
}

/**
 * Refuses a new immutable copy unless the post-retention production filesystem can hold its
 * conservatively rounded destination allocation, directory metadata, inode demand, and fixed
 * operational reserves. Existing current/rollback artifacts are not charged twice because
 * install and publication verify and reuse their immutable slots.
 * @param lease Active deployment lease shared by retention, copy, and activation.
 * @param paths Exact prepared production delivery roots.
 * @param sourceReleaseRoot Canonical verified release source.
 * @param sourceManifest Verified release manifest naming the final release/runtime slots.
 * @param sourceExecutable Canonical Bun source that installation will copy when absent.
 * @param dependencies Injectable free-space measurement used only by focused tests.
 */
export async function assertProductionArtifactCapacity(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    sourceReleaseRoot: string,
    sourceManifest: ReleaseManifest,
    sourceExecutable: string,
    dependencies: ProductionArtifactCapacityDependencies = {}
): Promise<void> {
    try {
        if (
            lease.stateDirectory !== paths.stateDirectory ||
            paths.stateDirectory !== path.join(paths.productionDirectory, "state") ||
            paths.releasesDirectory !==
                path.join(paths.productionDirectory, "releases") ||
            paths.runtimesDirectory !==
                path.join(paths.productionDirectory, "runtimes") ||
            !commitShaPattern.test(sourceManifest.source.commitSha) ||
            !commitShaPattern.test(sourceManifest.runtime.revision)
        ) {
            throw failure();
        }

        const [
            production,
            releases,
            runtimes,
            releaseRecords,
            verifiedManifest,
            runtimeBytes,
        ] = await Promise.all([
            lstat(paths.productionDirectory, { bigint: true }),
            lstat(paths.releasesDirectory, { bigint: true }),
            lstat(paths.runtimesDirectory, { bigint: true }),
            inventoryReleaseArtifactTree(sourceReleaseRoot),
            (dependencies.verifySourceRelease ?? verifyReleaseArtifactIdentity)(
                sourceReleaseRoot
            ),
            runtimeSourceBytes(sourceExecutable),
        ] as const);
        if (
            !validPrivateDirectory(production) ||
            !validPrivateDirectory(releases) ||
            !validPrivateDirectory(runtimes) ||
            releases.dev !== production.dev ||
            runtimes.dev !== production.dev ||
            JSON.stringify(verifiedManifest) !== JSON.stringify(sourceManifest)
        ) {
            throw failure();
        }

        const releaseExists = await existingManagedDirectory(
            path.join(paths.releasesDirectory, sourceManifest.source.commitSha),
            production.dev
        );
        const runtimeExists = await existingManagedDirectory(
            path.join(paths.runtimesDirectory, "bun", sourceManifest.runtime.revision),
            production.dev
        );
        if (releaseExists && runtimeExists) return;

        const bunRootExists = runtimeExists
            ? true
            : await existingManagedDirectory(
                  path.join(paths.runtimesDirectory, "bun"),
                  production.dev
              );
        let runtimeDirectoryCount = 0n;
        if (!runtimeExists) runtimeDirectoryCount = bunRootExists ? 1n : 2n;
        const inventory: ProductionArtifactCopyInventory = Object.freeze({
            fileBytes: Object.freeze([
                ...(releaseExists
                    ? []
                    : releaseRecords.map((record) => BigInt(record.bytes))),
                ...(runtimeExists ? [] : [runtimeBytes]),
            ]),
            newDirectoryCount:
                (releaseExists ? 0n : directoryCountForRelease(releaseRecords)) +
                runtimeDirectoryCount,
        });
        const capacity = await (
            dependencies.availableCapacity ?? defaultAvailableCapacity
        )(paths.productionDirectory);
        assertFitsCapacity(capacity, inventory);
    } catch {
        throw failure();
    }
}
