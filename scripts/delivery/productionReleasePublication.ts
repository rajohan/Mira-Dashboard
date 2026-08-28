import { constants, type BigIntStats, type Dirent } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rm,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { ProductionReleaseDescriptor } from "../../src/shared/productionReleaseDescriptor.ts";
import type { ReleaseManifest } from "../../src/shared/releaseManifest.ts";
import { parseReleaseManifest } from "../../src/shared/releaseManifest.ts";
import { readBoundedRegularFile } from "../files/boundedFile.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import {
    assertProductionArtifactCopyCapacity,
    type ProductionArtifactCapacityDependencies,
} from "./productionArtifactCapacity.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import {
    inventoryReleaseArtifactTree,
    maximumReleaseArtifactBytes,
    maximumReleaseRuntimeBytes,
    type ReleaseArtifactInventoryRecord,
} from "./releaseArtifactInventory.ts";
import {
    type ReleaseRuntimeIdentity,
    verifyProductionReleaseDescriptorIdentity,
    verifyReleaseIdentity,
} from "./releaseIdentity.ts";

const productionReleaseFailureMessage = "Production release publication failed";
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const immutableDirectoryMode = 0o500;
const immutableExecutableMode = 0o500;
const immutableFileMode = 0o400;
const releaseRuntimePath = "runtime/bun";
const commitShaPattern = /^[a-f\d]{40}$/u;
const maximumCleanupEntries = 4608;
const maximumCleanupDepth = 20;
const maximumPublishedManifestBytes = 4 * 1024 * 1024;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const destinationFileFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;

/** Immutable production release materialized below the project-local release root. */
export interface PublishedProductionRelease {
    readonly manifest: ReleaseManifest;
    readonly releaseRoot: string;
}

/** Cross-generation immutable release identity; contains no semantic manifest data. */
export interface DescribedPublishedProductionRelease {
    readonly descriptor: ProductionReleaseDescriptor;
    readonly releaseRoot: string;
}

/** Deterministic publication mutation boundaries exposed only to adversarial tests. */
export interface ProductionReleasePublicationTestHooks {
    readonly availableCapacity?: ProductionArtifactCapacityDependencies["availableCapacity"];
    readonly beforeCopy?: (sourceRoot: string) => Promise<void> | void;
    readonly afterCopy?: (stagingRoot: string) => Promise<void> | void;
    readonly afterFreeze?: (stagingRoot: string) => Promise<void> | void;
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

async function syncDirectory(directory: string): Promise<void> {
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(directory, directoryFlags);
        await handle.sync();
    } catch {
        failed = true;
    }
    if (!(await closeHandle(handle)) || failed) throw productionReleaseFailure();
}

async function writeSyncedPrivateFile(
    filePath: string,
    contents: Uint8Array
): Promise<void> {
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(filePath, destinationFileFlags, privateFileMode);
        await handle.writeFile(contents);
        await handle.sync();
    } catch {
        failed = true;
    }
    if (!(await closeHandle(handle)) || failed) throw productionReleaseFailure();
}

function releaseDirectories(
    releaseRoot: string,
    records: readonly ReleaseArtifactInventoryRecord[]
): readonly string[] {
    const directories = new Set<string>([releaseRoot]);
    for (const record of records) {
        let directory = path.dirname(path.join(releaseRoot, record.path));
        while (directory !== releaseRoot) {
            directories.add(directory);
            directory = path.dirname(directory);
        }
    }
    return Object.freeze(
        [...directories].toSorted((left, right) => right.length - left.length)
    );
}

interface ExpectedTreeEntry {
    readonly kind: "directory" | "file";
    readonly name: string;
}

function productionReleaseFailure(): Error {
    return new Error(productionReleaseFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function compareText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function sameArtifactRecords(
    left: readonly ReleaseArtifactInventoryRecord[],
    right: readonly ReleaseArtifactInventoryRecord[]
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (record, index) =>
                record.bytes === right[index]?.bytes &&
                record.path === right[index]?.path &&
                record.sha256 === right[index]?.sha256
        )
    );
}

function sameManifest(left: ReleaseManifest, right: ReleaseManifest): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function entrySignature(entry: Dirent): string {
    if (entry.isDirectory()) return `directory:${entry.name}`;
    if (entry.isFile()) return `file:${entry.name}`;
    return `other:${entry.name}`;
}

function expectedTreeEntries(
    records: readonly ReleaseArtifactInventoryRecord[]
): ReadonlyMap<string, readonly ExpectedTreeEntry[]> {
    const entries = new Map<string, Map<string, ExpectedTreeEntry>>([["", new Map()]]);
    for (const record of records) {
        const segments = record.path.split("/");
        let directory = "";
        for (const segment of segments.slice(0, -1)) {
            const childDirectory = directory ? `${directory}/${segment}` : segment;
            const parentEntries = entries.get(directory);
            if (!parentEntries) throw productionReleaseFailure();
            parentEntries.set(
                `directory:${segment}`,
                Object.freeze({ kind: "directory", name: segment })
            );
            if (!entries.has(childDirectory)) entries.set(childDirectory, new Map());
            directory = childDirectory;
        }
        const filename = segments.at(-1);
        const directoryEntries = entries.get(directory);
        if (!filename || !directoryEntries) throw productionReleaseFailure();
        directoryEntries.set(
            `file:${filename}`,
            Object.freeze({ kind: "file", name: filename })
        );
    }
    return new Map(
        [...entries].map(([directory, values]) => [
            directory,
            Object.freeze(
                [...values.values()].toSorted((left, right) =>
                    compareText(
                        `${left.kind}:${left.name}`,
                        `${right.kind}:${right.name}`
                    )
                )
            ),
        ])
    );
}

function validDirectory(
    status: BigIntStats,
    userId: number,
    device: bigint,
    mode: bigint
): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        status.dev === device &&
        (status.mode & 0o7777n) === mode
    );
}

function validFile(
    status: BigIntStats,
    userId: number,
    device: bigint,
    mode: bigint,
    bytes: number
): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(userId) &&
        status.dev === device &&
        status.size === BigInt(bytes) &&
        (status.mode & 0o7777n) === mode
    );
}

async function assertReleaseTreeMode(
    releaseRoot: string,
    records: readonly ReleaseArtifactInventoryRecord[],
    immutable: boolean
): Promise<void> {
    if (typeof process.getuid !== "function") throw productionReleaseFailure();
    const [canonicalRoot, rootStatus] = await Promise.all([
        realpath(releaseRoot),
        lstat(releaseRoot, { bigint: true }),
    ]);
    const directoryMode = immutable ? 0o500n : 0o700n;
    const fileMode = immutable ? 0o400n : 0o600n;
    if (
        canonicalRoot !== releaseRoot ||
        !validDirectory(rootStatus, process.getuid(), rootStatus.dev, directoryMode)
    ) {
        throw productionReleaseFailure();
    }

    const entriesByDirectory = expectedTreeEntries(records);
    const recordByPath = new Map(records.map((record) => [record.path, record]));
    for (const [relativeDirectory, expectedEntries] of entriesByDirectory) {
        const directory = relativeDirectory
            ? path.join(releaseRoot, relativeDirectory)
            : releaseRoot;
        const directoryStatus = await lstat(directory, { bigint: true });
        if (
            !validDirectory(
                directoryStatus,
                process.getuid(),
                rootStatus.dev,
                directoryMode
            )
        ) {
            throw productionReleaseFailure();
        }
        const actualEntries = await readdir(directory, { withFileTypes: true });
        const actualSignatures = actualEntries
            .map((entry) => entrySignature(entry))
            .toSorted(compareText);
        const expectedSignatures = expectedEntries
            .map((entry) => `${entry.kind}:${entry.name}`)
            .toSorted(compareText);
        if (
            actualSignatures.length !== expectedSignatures.length ||
            actualSignatures.some(
                (signature, index) => signature !== expectedSignatures[index]
            )
        ) {
            throw productionReleaseFailure();
        }
        for (const entry of expectedEntries) {
            if (entry.kind !== "file") continue;
            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name;
            const record = recordByPath.get(relativePath);
            const expectedFileMode =
                immutable && relativePath === releaseRuntimePath
                    ? BigInt(immutableExecutableMode)
                    : fileMode;
            if (
                !record ||
                !validFile(
                    await lstat(path.join(releaseRoot, relativePath), {
                        bigint: true,
                    }),
                    process.getuid(),
                    rootStatus.dev,
                    expectedFileMode,
                    record.bytes
                )
            ) {
                throw productionReleaseFailure();
            }
        }
    }
}

async function assertPrivateReleasesDirectory(directory: string): Promise<void> {
    if (typeof process.getuid !== "function") throw productionReleaseFailure();
    const [canonical, status] = await Promise.all([
        realpath(directory),
        lstat(directory, { bigint: true }),
    ]);
    if (
        canonical !== directory ||
        !validDirectory(status, process.getuid(), status.dev, 0o700n)
    ) {
        throw productionReleaseFailure();
    }
}

function validatePublicationInputs(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    sourceReleaseRoot: string
): void {
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        paths.releasesDirectory !== path.join(paths.productionDirectory, "releases") ||
        paths.runtimesDirectory !== path.join(paths.productionDirectory, "runtimes") ||
        !path.isAbsolute(sourceReleaseRoot) ||
        sourceReleaseRoot.includes("\0") ||
        path.resolve(sourceReleaseRoot) !== sourceReleaseRoot
    ) {
        throw productionReleaseFailure();
    }
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await lstat(candidate);
        return true;
    } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw productionReleaseFailure();
    }
}

async function copyReleaseTree(
    sourceRoot: string,
    destinationRoot: string,
    expectedSource: readonly ReleaseArtifactInventoryRecord[],
    availableCapacity?: ProductionReleasePublicationTestHooks["availableCapacity"]
): Promise<readonly ReleaseArtifactInventoryRecord[]> {
    const sourceBefore = await inventoryReleaseArtifactTree(sourceRoot);
    if (!sameArtifactRecords(expectedSource, sourceBefore)) {
        throw productionReleaseFailure();
    }
    await assertProductionArtifactCopyCapacity(
        path.dirname(destinationRoot),
        Object.freeze({
            fileBytes: Object.freeze(sourceBefore.map((record) => BigInt(record.bytes))),
            newDirectoryCount: BigInt(
                releaseDirectories(destinationRoot, sourceBefore).length
            ),
        }),
        { availableCapacity }
    );
    await mkdir(destinationRoot, { mode: privateDirectoryMode });
    for (const record of sourceBefore) {
        const maximumBytes =
            record.path === releaseRuntimePath
                ? maximumReleaseRuntimeBytes
                : maximumReleaseArtifactBytes;
        const contents = await readBoundedRegularFile(
            path.join(sourceRoot, record.path),
            sourceRoot,
            maximumBytes,
            productionReleaseFailureMessage
        );
        if (
            contents.byteLength !== record.bytes ||
            new Bun.CryptoHasher("sha256").update(contents).digest("hex") !==
                record.sha256
        ) {
            throw productionReleaseFailure();
        }
        const destination = path.join(destinationRoot, record.path);
        await mkdir(path.dirname(destination), {
            mode: privateDirectoryMode,
            recursive: true,
        });
        await writeSyncedPrivateFile(destination, contents);
    }
    for (const directory of releaseDirectories(destinationRoot, sourceBefore)) {
        await syncDirectory(directory);
    }
    const [sourceAfter, destination] = await Promise.all([
        inventoryReleaseArtifactTree(sourceRoot),
        inventoryReleaseArtifactTree(destinationRoot),
    ]);
    if (
        !sameArtifactRecords(sourceBefore, sourceAfter) ||
        !sameArtifactRecords(sourceBefore, destination)
    ) {
        throw productionReleaseFailure();
    }
    await assertReleaseTreeMode(destinationRoot, destination, false);
    return destination;
}

async function freezeReleaseTree(
    releaseRoot: string,
    records: readonly ReleaseArtifactInventoryRecord[]
): Promise<void> {
    for (const record of records) {
        const filePath = path.join(releaseRoot, record.path);
        await chmod(
            filePath,
            record.path === releaseRuntimePath
                ? immutableExecutableMode
                : immutableFileMode
        );
        let handle: FileHandle | undefined;
        let failed = false;
        try {
            handle = await open(
                filePath,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            );
            await handle.sync();
        } catch {
            failed = true;
        }
        if (!(await closeHandle(handle)) || failed) throw productionReleaseFailure();
    }
    for (const directory of releaseDirectories(releaseRoot, records)) {
        let handle: FileHandle | undefined;
        let failed = false;
        try {
            handle = await open(directory, directoryFlags);
            await handle.chmod(immutableDirectoryMode);
            await handle.sync();
        } catch {
            failed = true;
        }
        if (!(await closeHandle(handle)) || failed) throw productionReleaseFailure();
    }
    const after = await inventoryReleaseArtifactTree(releaseRoot);
    if (!sameArtifactRecords(records, after)) throw productionReleaseFailure();
    await assertReleaseTreeMode(releaseRoot, after, true);
}

/**
 * Restores and removes one same-user, same-filesystem immutable release candidate.
 * @param releasesDirectory Canonical private parent directory.
 * @param candidateRoot Exact direct child selected for removal.
 * @param expectedName Exact basename admitted by the caller.
 */
export async function discardOwnedProductionReleaseCandidate(
    releasesDirectory: string,
    candidateRoot: string,
    expectedName: string
): Promise<void> {
    if (
        path.dirname(candidateRoot) !== releasesDirectory ||
        path.basename(candidateRoot) !== expectedName
    ) {
        throw productionReleaseFailure();
    }
    if (!(await pathExists(candidateRoot))) return;
    if (typeof process.getuid !== "function") throw productionReleaseFailure();
    const userId = process.getuid();
    const rootStatus = await lstat(candidateRoot, { bigint: true });
    if (
        !rootStatus.isDirectory() ||
        rootStatus.isSymbolicLink() ||
        rootStatus.uid !== BigInt(userId)
    ) {
        throw productionReleaseFailure();
    }

    let entryCount = 0;
    const restore = async (directory: string, depth: number): Promise<void> => {
        if (depth > maximumCleanupDepth) throw productionReleaseFailure();
        await chmod(directory, privateDirectoryMode);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            entryCount += 1;
            if (entryCount > maximumCleanupEntries) throw productionReleaseFailure();
            const entryPath = path.join(directory, entry.name);
            const status = await lstat(entryPath, { bigint: true });
            if (
                status.isSymbolicLink() ||
                status.uid !== BigInt(userId) ||
                status.dev !== rootStatus.dev
            ) {
                throw productionReleaseFailure();
            }
            if (status.isDirectory()) {
                await restore(entryPath, depth + 1);
            } else if (status.isFile() && status.nlink === 1n) {
                await chmod(entryPath, privateFileMode);
            } else {
                throw productionReleaseFailure();
            }
        }
    };
    await restore(candidateRoot, 0);
    await rm(candidateRoot, { force: false, recursive: true });
    await syncDirectory(releasesDirectory);
}

/**
 * Copies one verified local build into its immutable commit-addressed production slot.
 * The unforgeable lease proves this runs inside the wider release/database transition.
 * @param lease Active deployment lease token.
 * @param paths Revalidated project-local production delivery paths.
 * @param sourceReleaseRoot Immutable local release artifact created by `bun run build release`.
 * @param runtimeIdentity Exact Bun identity represented by the release.
 * @param testHooks Deterministic mutation hooks used only by tests.
 * @returns Idempotently published production release.
 */
export async function publishProductionRelease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    sourceReleaseRoot: string,
    runtimeIdentity: ReleaseRuntimeIdentity,
    testHooks: ProductionReleasePublicationTestHooks = {}
): Promise<PublishedProductionRelease> {
    validatePublicationInputs(lease, paths, sourceReleaseRoot);
    await assertPrivateReleasesDirectory(paths.releasesDirectory);
    let ownedRoot: string | undefined;
    let ownedName: string | undefined;
    try {
        const sourceManifest = await verifyReleaseIdentity(
            sourceReleaseRoot,
            runtimeIdentity
        );
        const sourceRecords = await inventoryReleaseArtifactTree(sourceReleaseRoot);
        await assertReleaseTreeMode(sourceReleaseRoot, sourceRecords, true);
        const commitSha = sourceManifest.source.commitSha;
        if (!commitShaPattern.test(commitSha)) throw productionReleaseFailure();
        const finalRoot = path.join(paths.releasesDirectory, commitSha);
        if (await pathExists(finalRoot)) {
            const existing = await verifyReleaseIdentity(finalRoot, runtimeIdentity);
            const existingRecords = await inventoryReleaseArtifactTree(finalRoot);
            await assertReleaseTreeMode(finalRoot, existingRecords, true);
            if (!sameManifest(sourceManifest, existing)) {
                throw productionReleaseFailure();
            }
            return Object.freeze({ manifest: existing, releaseRoot: finalRoot });
        }

        const stageName = `.stage-${commitSha}-${Bun.randomUUIDv7()}`;
        const stagingRoot = path.join(paths.releasesDirectory, stageName);
        ownedRoot = stagingRoot;
        ownedName = stageName;
        await testHooks.beforeCopy?.(sourceReleaseRoot);
        const stagedRecords = await copyReleaseTree(
            sourceReleaseRoot,
            stagingRoot,
            sourceRecords,
            testHooks.availableCapacity
        );
        await testHooks.afterCopy?.(stagingRoot);
        const stagedManifest = await verifyReleaseIdentity(stagingRoot, runtimeIdentity);
        if (!sameManifest(sourceManifest, stagedManifest)) {
            throw productionReleaseFailure();
        }
        await freezeReleaseTree(stagingRoot, stagedRecords);
        await testHooks.afterFreeze?.(stagingRoot);
        const frozenManifest = await verifyReleaseIdentity(stagingRoot, runtimeIdentity);
        if (!sameManifest(sourceManifest, frozenManifest)) {
            throw productionReleaseFailure();
        }

        await rename(stagingRoot, finalRoot);
        ownedRoot = finalRoot;
        ownedName = commitSha;
        await syncDirectory(paths.releasesDirectory);
        if ((await realpath(finalRoot)) !== finalRoot) throw productionReleaseFailure();
        const published = await verifyReleaseIdentity(finalRoot, runtimeIdentity);
        const publishedRecords = await inventoryReleaseArtifactTree(finalRoot);
        await assertReleaseTreeMode(finalRoot, publishedRecords, true);
        if (!sameManifest(sourceManifest, published)) {
            throw productionReleaseFailure();
        }
        ownedRoot = undefined;
        ownedName = undefined;
        return Object.freeze({ manifest: published, releaseRoot: finalRoot });
    } catch {
        if (ownedRoot && ownedName) {
            try {
                await discardOwnedProductionReleaseCandidate(
                    paths.releasesDirectory,
                    ownedRoot,
                    ownedName
                );
            } catch {
                // Preserve the fixed publication failure and leave bounded evidence.
            }
        }
        throw productionReleaseFailure();
    }
}

/**
 * Copies one descriptor-verified foreign release into its immutable production slot.
 * The caller intentionally learns no semantic manifest shape; the published release's
 * digest-bound executor is the only code allowed to interpret that manifest.
 * @param lease Held production deployment lease.
 * @param paths Prepared private production Delivery paths.
 * @param sourceReleaseRoot Descriptor-verified source release directory.
 * @param testHooks Optional deterministic publication test hooks.
 * @returns Immutable descriptor-only publication identity.
 */
export async function publishDescribedProductionRelease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    sourceReleaseRoot: string,
    testHooks: ProductionReleasePublicationTestHooks = {}
): Promise<DescribedPublishedProductionRelease> {
    validatePublicationInputs(lease, paths, sourceReleaseRoot);
    await assertPrivateReleasesDirectory(paths.releasesDirectory);
    let ownedRoot: string | undefined;
    let ownedName: string | undefined;
    try {
        const sourceDescriptor =
            await verifyProductionReleaseDescriptorIdentity(sourceReleaseRoot);
        const sourceRecords = await inventoryReleaseArtifactTree(sourceReleaseRoot);
        const commitSha = sourceDescriptor.releaseId;
        if (!commitShaPattern.test(commitSha)) throw productionReleaseFailure();
        const finalRoot = path.join(paths.releasesDirectory, commitSha);
        if (await pathExists(finalRoot)) {
            const existing = await loadDescribedPublishedProductionReleaseById(
                paths,
                commitSha
            );
            if (
                JSON.stringify(existing.descriptor) !== JSON.stringify(sourceDescriptor)
            ) {
                throw productionReleaseFailure();
            }
            return existing;
        }
        const stageName = `.stage-${commitSha}-${Bun.randomUUIDv7()}`;
        const stagingRoot = path.join(paths.releasesDirectory, stageName);
        ownedRoot = stagingRoot;
        ownedName = stageName;
        await testHooks.beforeCopy?.(sourceReleaseRoot);
        const stagedRecords = await copyReleaseTree(
            sourceReleaseRoot,
            stagingRoot,
            sourceRecords,
            testHooks.availableCapacity
        );
        await testHooks.afterCopy?.(stagingRoot);
        const staged = await verifyProductionReleaseDescriptorIdentity(stagingRoot);
        if (JSON.stringify(staged) !== JSON.stringify(sourceDescriptor)) {
            throw productionReleaseFailure();
        }
        await freezeReleaseTree(stagingRoot, stagedRecords);
        await testHooks.afterFreeze?.(stagingRoot);
        await rename(stagingRoot, finalRoot);
        ownedRoot = finalRoot;
        ownedName = commitSha;
        await syncDirectory(paths.releasesDirectory);
        const published = await loadDescribedPublishedProductionReleaseById(
            paths,
            commitSha
        );
        if (JSON.stringify(published.descriptor) !== JSON.stringify(sourceDescriptor)) {
            throw productionReleaseFailure();
        }
        ownedRoot = undefined;
        ownedName = undefined;
        return published;
    } catch {
        if (ownedRoot && ownedName) {
            try {
                await discardOwnedProductionReleaseCandidate(
                    paths.releasesDirectory,
                    ownedRoot,
                    ownedName
                );
            } catch {
                // Preserve the fixed publication failure and bounded evidence.
            }
        }
        throw productionReleaseFailure();
    }
}

/**
 * Reloads and fully verifies one immutable production release named by activation state.
 * @param paths Exact project-local production delivery paths.
 * @param releaseId Full commit identity stored in the activation record.
 * @param runtimeRevision Exact Bun revision stored in the activation record.
 * @returns Verified immutable production release and manifest.
 */
export async function loadPublishedProductionRelease(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string,
    runtimeRevision: string
): Promise<PublishedProductionRelease> {
    if (!commitShaPattern.test(runtimeRevision)) throw productionReleaseFailure();
    const release = await loadPublishedProductionReleaseById(paths, releaseId);
    if (release.manifest.runtime.revision !== runtimeRevision) {
        throw productionReleaseFailure();
    }
    return release;
}

/**
 * Reloads and fully verifies one immutable production release using its own manifest identity.
 * @param paths Exact project-local production delivery paths.
 * @param releaseId Full commit identity naming the immutable release directory.
 * @returns Verified immutable production release and manifest.
 */
export async function loadPublishedProductionReleaseById(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string
): Promise<PublishedProductionRelease> {
    try {
        if (!commitShaPattern.test(releaseId)) throw productionReleaseFailure();
        await assertPrivateReleasesDirectory(paths.releasesDirectory);
        const releaseRoot = path.join(paths.releasesDirectory, releaseId);
        const manifestBytes = await readBoundedRegularFile(
            path.join(releaseRoot, "release-manifest.json"),
            releaseRoot,
            maximumPublishedManifestBytes,
            productionReleaseFailureMessage
        );
        const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
            manifestBytes
        );
        const manifestValue: unknown = JSON.parse(manifestText);
        const preliminary = parseReleaseManifest(manifestValue);
        if (preliminary.source.commitSha !== releaseId) {
            throw productionReleaseFailure();
        }
        const manifest = await verifyReleaseIdentity(releaseRoot, preliminary.runtime);
        const records = await inventoryReleaseArtifactTree(releaseRoot);
        await assertReleaseTreeMode(releaseRoot, records, true);
        if (JSON.stringify(manifest) !== JSON.stringify(preliminary)) {
            throw productionReleaseFailure();
        }
        return Object.freeze({ manifest, releaseRoot });
    } catch {
        throw productionReleaseFailure();
    }
}

/**
 * Loads a foreign immutable release through the stable descriptor contract only.
 * Semantic manifest validation belongs exclusively to that release's executor.
 * @param paths Prepared private production Delivery paths.
 * @param releaseId Exact immutable release identifier.
 * @returns Descriptor-verified foreign release identity and root.
 */
export async function loadDescribedPublishedProductionReleaseById(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string
): Promise<DescribedPublishedProductionRelease> {
    try {
        if (!commitShaPattern.test(releaseId)) throw productionReleaseFailure();
        await assertPrivateReleasesDirectory(paths.releasesDirectory);
        const releaseRoot = path.join(paths.releasesDirectory, releaseId);
        const descriptor = await verifyProductionReleaseDescriptorIdentity(releaseRoot);
        if (descriptor.releaseId !== releaseId) throw productionReleaseFailure();
        const records = await inventoryReleaseArtifactTree(releaseRoot);
        await assertReleaseTreeMode(releaseRoot, records, true);
        return Object.freeze({ descriptor, releaseRoot });
    } catch {
        throw productionReleaseFailure();
    }
}
