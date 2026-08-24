import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    open,
    readdir,
    realpath,
    readlink,
    rename,
    rmdir,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import {
    loadPublishedProductionReleaseById,
    type PublishedProductionRelease,
} from "./productionReleasePublication.ts";
import {
    inspectInstalledProductionRuntime,
    type InstalledProductionRuntime,
    type ProductionRuntimeVerificationDependencies,
} from "./productionRuntime.ts";

const retentionFailureMessage = "Production artifact retention failed";
const commitShaPattern = /^[a-f\d]{40}$/u;
const stageNamePattern =
    /^\.stage-([a-f\d]{40})-([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/u;
const retiredNamePattern = /^\.retire-([a-f\d]{40})$/u;
const pointerStageNamePattern =
    /^\.current-[a-f\d]{8}-[a-f\d]{4}-7[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u;
const maximumRootEntries = 128;
const maximumTreeEntries = 4608;
const maximumTreeDepth = 20;
const maximumDescriptorInfoBytes = 4096;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Release/runtime pair that must survive one retention pass. */
export interface ProductionArtifactReference {
    readonly releaseId: string;
    readonly runtimeRevision: string;
}

/** Read-only verification and race boundaries exposed to focused tests. */
export interface ProductionArtifactRetentionDependencies {
    readonly afterEntryRetired?: (
        kind: "release" | "runtime",
        identity: string
    ) => Promise<void> | void;
    readonly beforeEntryRetired?: (
        kind: "release" | "runtime",
        identity: string
    ) => Promise<void> | void;
    readonly afterFileRetired?: (
        fileName: string,
        retiredName: string
    ) => Promise<void> | void;
    readonly beforeFileRetired?: (fileName: string) => Promise<void> | void;
    readonly readMountId?: (fileDescriptor: number) => Promise<bigint>;
    readonly runtimeVerification?: ProductionRuntimeVerificationDependencies;
    readonly verifyRelease?: (
        paths: PreparedProductionDeliveryPaths,
        releaseId: string
    ) => Promise<PublishedProductionRelease>;
    readonly verifyRuntime?: (
        paths: PreparedProductionDeliveryPaths,
        revision: string,
        dependencies?: ProductionRuntimeVerificationDependencies
    ) => Promise<InstalledProductionRuntime>;
}

interface OpenedRoot {
    readonly device: bigint;
    readonly handle: FileHandle;
    readonly inode: bigint;
    readonly mountId: bigint;
    readonly path: string;
    readonly readMountId: (fileDescriptor: number) => Promise<bigint>;
}

interface ManagedEntry {
    readonly identity: string;
    readonly inode: bigint;
    readonly kind: "published" | "retired" | "stage";
    readonly name: string;
}

interface ManagedPointerStage {
    readonly inode: bigint;
    readonly name: string;
    readonly target: string;
}

interface VerifiedInventory {
    readonly entries: readonly ManagedEntry[];
    readonly pointerStages: readonly ManagedPointerStage[];
    readonly published: ReadonlyMap<string, ManagedEntry>;
}

function failure(): Error {
    return new Error(retentionFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function validPrivateRoot(status: BigIntStats): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
        (status.mode & 0o7777n) === 0o700n
    );
}

function validManagedDirectory(status: BigIntStats, device: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === device &&
        [0o500n, 0o700n].includes(status.mode & 0o7777n)
    );
}

function validManagedFile(status: BigIntStats, device: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === device &&
        [0o400n, 0o500n, 0o600n].includes(status.mode & 0o7777n)
    );
}

function validManagedPointer(status: BigIntStats, device: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === device
    );
}

async function closeHandle(handle: FileHandle | undefined): Promise<boolean> {
    if (handle === undefined) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

async function readDescriptorMountId(fileDescriptor: number): Promise<bigint> {
    try {
        const text = await Bun.file(`/proc/self/fdinfo/${fileDescriptor}`).text();
        if (text.length <= 0 || text.length > maximumDescriptorInfoBytes) throw failure();
        const matches = [...text.matchAll(/^mnt_id:\s*(\d+)$/gmu)];
        if (matches.length !== 1 || !matches[0]?.[1]) throw failure();
        const mountId = BigInt(matches[0][1]);
        if (mountId <= 0n) throw failure();
        return mountId;
    } catch {
        throw failure();
    }
}

async function openPrivateRoot(
    directory: string,
    readMountId: (fileDescriptor: number) => Promise<bigint> = readDescriptorMountId
): Promise<OpenedRoot> {
    if (process.platform !== "linux") throw failure();
    let handle: FileHandle | undefined;
    try {
        handle = await open(directory, directoryFlags);
        const [held, named, canonical, mountId] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
            readMountId(handle.fd),
        ]);
        if (
            canonical !== directory ||
            !validPrivateRoot(held) ||
            !validPrivateRoot(named) ||
            named.dev !== held.dev ||
            named.ino !== held.ino
        ) {
            throw failure();
        }
        return Object.freeze({
            device: held.dev,
            handle,
            inode: held.ino,
            mountId,
            path: directory,
            readMountId,
        });
    } catch {
        await closeHandle(handle);
        throw failure();
    }
}

async function revalidateRoot(root: OpenedRoot): Promise<void> {
    const [held, named, canonical, mountId] = await Promise.all([
        root.handle.stat({ bigint: true }),
        lstat(root.path, { bigint: true }),
        realpath(`/proc/self/fd/${root.handle.fd}`),
        root.readMountId(root.handle.fd),
    ]);
    if (
        canonical !== root.path ||
        !validPrivateRoot(held) ||
        !validPrivateRoot(named) ||
        held.dev !== root.device ||
        held.ino !== root.inode ||
        named.dev !== root.device ||
        named.ino !== root.inode ||
        mountId !== root.mountId
    ) {
        throw failure();
    }
}

function parseManagedEntry(name: string): Pick<ManagedEntry, "identity" | "kind"> | null {
    if (commitShaPattern.test(name)) return { identity: name, kind: "published" };
    const retired = retiredNamePattern.exec(name);
    if (retired?.[1]) return { identity: retired[1], kind: "retired" };
    const stage = stageNamePattern.exec(name);
    if (stage?.[1]) return { identity: stage[1], kind: "stage" };
    return null;
}

async function validateManagedTree(root: OpenedRoot, entry: ManagedEntry): Promise<void> {
    let entryCount = 0;
    const inspect = async (
        directory: string,
        expectedInode: bigint,
        depth: number
    ): Promise<void> => {
        if (depth > maximumTreeDepth) throw failure();
        const opened = await openManagedDirectory(root, directory, expectedInode);
        let failed = false;
        try {
            const descriptor = `/proc/self/fd/${opened.handle.fd}`;
            for (const child of await readdir(descriptor, { withFileTypes: true })) {
                entryCount += 1;
                if (entryCount > maximumTreeEntries) throw failure();
                const childPath = path.join(descriptor, child.name);
                const childStatus = await lstat(childPath, { bigint: true });
                if (
                    typeof process.getuid !== "function" ||
                    childStatus.isSymbolicLink() ||
                    childStatus.uid !== BigInt(process.getuid()) ||
                    childStatus.dev !== root.device
                ) {
                    throw failure();
                }
                if (childStatus.isDirectory()) {
                    await inspect(childPath, childStatus.ino, depth + 1);
                } else if (!validManagedFile(childStatus, root.device)) {
                    throw failure();
                }
            }
        } catch {
            failed = true;
        }
        if (!(await closeHandle(opened.handle)) || failed) throw failure();
    };
    const entryPath = path.join(`/proc/self/fd/${root.handle.fd}`, entry.name);
    await inspect(entryPath, entry.inode, 0);
    const after = await lstat(entryPath, { bigint: true });
    if (after.dev !== root.device || after.ino !== entry.inode) throw failure();
}

async function inventoryRoot(
    root: OpenedRoot,
    protectedIdentities: ReadonlySet<string>
): Promise<VerifiedInventory> {
    const directoryEntries = await readdir(`/proc/self/fd/${root.handle.fd}`, {
        withFileTypes: true,
    });
    if (directoryEntries.length > maximumRootEntries) throw failure();
    const entries: ManagedEntry[] = [];
    const pointerStages: ManagedPointerStage[] = [];
    const published = new Map<string, ManagedEntry>();
    for (const directoryEntry of directoryEntries) {
        if (directoryEntry.name.startsWith(".current-")) {
            if (
                !pointerStageNamePattern.test(directoryEntry.name) ||
                !directoryEntry.isSymbolicLink()
            ) {
                throw failure();
            }
            const pointerPath = path.join(
                `/proc/self/fd/${root.handle.fd}`,
                directoryEntry.name
            );
            const before = await lstat(pointerPath, { bigint: true });
            const target = await readlink(pointerPath);
            const after = await lstat(pointerPath, { bigint: true });
            if (
                !validManagedPointer(before, root.device) ||
                !validManagedPointer(after, root.device) ||
                after.ino !== before.ino ||
                !commitShaPattern.test(target)
            ) {
                throw failure();
            }
            pointerStages.push(
                Object.freeze({ inode: before.ino, name: directoryEntry.name, target })
            );
            continue;
        }
        if (directoryEntry.name === "current") {
            if (!directoryEntry.isSymbolicLink()) throw failure();
            const pointerPath = path.join(
                `/proc/self/fd/${root.handle.fd}`,
                directoryEntry.name
            );
            const [status, target] = await Promise.all([
                lstat(pointerPath, { bigint: true }),
                readlink(pointerPath),
            ]);
            if (
                !validManagedPointer(status, root.device) ||
                !commitShaPattern.test(target) ||
                !protectedIdentities.has(target)
            ) {
                throw failure();
            }
            continue;
        }
        const parsed = parseManagedEntry(directoryEntry.name);
        if (!directoryEntry.isDirectory() || parsed === null) throw failure();
        const status = await lstat(
            path.join(`/proc/self/fd/${root.handle.fd}`, directoryEntry.name),
            { bigint: true }
        );
        if (!validManagedDirectory(status, root.device)) throw failure();
        const entry = Object.freeze({
            ...parsed,
            inode: status.ino,
            name: directoryEntry.name,
        });
        if (entry.kind === "published") {
            if (published.has(entry.identity)) throw failure();
            published.set(entry.identity, entry);
        }
        entries.push(entry);
    }
    for (const entry of entries.filter(({ kind }) => kind !== "published")) {
        await validateManagedTree(root, entry);
    }
    return Object.freeze({
        entries: Object.freeze(entries),
        pointerStages: Object.freeze(pointerStages),
        published,
    });
}

async function reapPointerStage(
    root: OpenedRoot,
    stage: ManagedPointerStage
): Promise<void> {
    const pointerPath = path.join(`/proc/self/fd/${root.handle.fd}`, stage.name);
    const before = await lstat(pointerPath, { bigint: true });
    const target = await readlink(pointerPath);
    const after = await lstat(pointerPath, { bigint: true });
    if (
        !validManagedPointer(before, root.device) ||
        !validManagedPointer(after, root.device) ||
        before.ino !== stage.inode ||
        after.ino !== stage.inode ||
        target !== stage.target
    ) {
        throw failure();
    }
    await unlink(pointerPath);
    await root.handle.sync();
    await revalidateRoot(root);
}

async function openManagedDirectory(
    root: OpenedRoot,
    directory: string,
    expectedInode?: bigint
): Promise<{ readonly handle: FileHandle; readonly inode: bigint }> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(directory, directoryFlags);
        const [held, named, mountId] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            root.readMountId(handle.fd),
        ]);
        if (
            !validManagedDirectory(held, root.device) ||
            !validManagedDirectory(named, root.device) ||
            held.ino !== named.ino ||
            mountId !== root.mountId ||
            (expectedInode !== undefined && held.ino !== expectedInode)
        ) {
            throw failure();
        }
        return Object.freeze({ handle, inode: held.ino });
    } catch {
        await closeHandle(handle);
        throw failure();
    }
}

async function retireAndUnlinkManagedFile(
    root: OpenedRoot,
    directoryHandle: FileHandle,
    fileName: string,
    expectedInode: bigint,
    dependencies: ProductionArtifactRetentionDependencies
): Promise<void> {
    const descriptor = `/proc/self/fd/${directoryHandle.fd}`;
    const source = path.join(descriptor, fileName);
    const retiredName = `.reap-${Bun.randomUUIDv7()}`;
    const retired = path.join(descriptor, retiredName);
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        await dependencies.beforeFileRetired?.(fileName);
        handle = await open(source, fileFlags);
        const [held, named] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(source, { bigint: true }),
        ]);
        if (
            !validManagedFile(held, root.device) ||
            !validManagedFile(named, root.device) ||
            held.ino !== named.ino ||
            held.ino !== expectedInode
        ) {
            throw failure();
        }
        try {
            await lstat(retired);
            throw failure();
        } catch (error) {
            if (errorCode(error) !== "ENOENT") throw failure();
        }
        await rename(source, retired);
        await directoryHandle.sync();
        await dependencies.afterFileRetired?.(fileName, retiredName);
        const [heldAtRetiredName, namedAtRetiredName] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(retired, { bigint: true }),
        ]);
        if (
            !validManagedFile(heldAtRetiredName, root.device) ||
            !validManagedFile(namedAtRetiredName, root.device) ||
            heldAtRetiredName.ino !== expectedInode ||
            namedAtRetiredName.ino !== expectedInode
        ) {
            throw failure();
        }
        try {
            await lstat(source);
            throw failure();
        } catch (error) {
            if (errorCode(error) !== "ENOENT") throw failure();
        }
        await handle.chmod(privateFileMode);
        const after = await handle.stat({ bigint: true });
        if (
            !validManagedFile(after, root.device) ||
            after.ino !== held.ino ||
            (after.mode & 0o7777n) !== 0o600n
        ) {
            throw failure();
        }
        const current = await lstat(retired, { bigint: true });
        if (current.dev !== held.dev || current.ino !== held.ino) throw failure();
        // Linux has no inode-conditional unlink primitive: the final operation is
        // necessarily pathname based. The deployment lease serializes every authorized
        // mutation by this trusted application UID. The descriptor/inode checks above
        // fail closed for drift observed before unlink, but a malicious concurrent
        // same-UID process is outside this boundary because it can already rewrite the
        // complete application-owned production namespace. Closing that boundary
        // requires the planned root-owned release handoff and a different-principal GC.
        await unlink(retired);
        await directoryHandle.sync();
    } catch {
        failed = true;
    }
    if (!(await closeHandle(handle)) || failed) throw failure();
}

async function emptyManagedDirectory(
    root: OpenedRoot,
    directory: string,
    expectedInode: bigint,
    depth: number,
    observedEntries: { count: number },
    dependencies: ProductionArtifactRetentionDependencies
): Promise<void> {
    if (depth > maximumTreeDepth) throw failure();
    const opened = await openManagedDirectory(root, directory, expectedInode);
    let failed = false;
    try {
        await opened.handle.chmod(privateDirectoryMode);
        const held = await opened.handle.stat({ bigint: true });
        if (
            !validManagedDirectory(held, root.device) ||
            held.ino !== opened.inode ||
            (held.mode & 0o7777n) !== 0o700n
        ) {
            throw failure();
        }
        const descriptor = `/proc/self/fd/${opened.handle.fd}`;
        for (const child of await readdir(descriptor, { withFileTypes: true })) {
            observedEntries.count += 1;
            if (observedEntries.count > maximumTreeEntries) throw failure();
            const childPath = path.join(descriptor, child.name);
            const childStatus = await lstat(childPath, { bigint: true });
            if (validManagedDirectory(childStatus, root.device)) {
                await emptyManagedDirectory(
                    root,
                    childPath,
                    childStatus.ino,
                    depth + 1,
                    observedEntries,
                    dependencies
                );
                const current = await lstat(childPath, { bigint: true });
                if (
                    !validManagedDirectory(current, root.device) ||
                    current.ino !== childStatus.ino ||
                    (current.mode & 0o7777n) !== 0o700n
                ) {
                    throw failure();
                }
                await rmdir(childPath);
            } else if (validManagedFile(childStatus, root.device)) {
                await retireAndUnlinkManagedFile(
                    root,
                    opened.handle,
                    child.name,
                    childStatus.ino,
                    dependencies
                );
            } else {
                throw failure();
            }
        }
        const remainingEntries = await readdir(descriptor);
        if (remainingEntries.length > 0) throw failure();
        await opened.handle.sync();
    } catch {
        failed = true;
    }
    if (!(await closeHandle(opened.handle)) || failed) throw failure();
}

async function reapEntry(
    root: OpenedRoot,
    entry: ManagedEntry,
    dependencies: ProductionArtifactRetentionDependencies
): Promise<void> {
    await validateManagedTree(root, entry);
    const entryPath = path.join(`/proc/self/fd/${root.handle.fd}`, entry.name);
    await emptyManagedDirectory(
        root,
        entryPath,
        entry.inode,
        0,
        { count: 0 },
        dependencies
    );
    const named = await lstat(entryPath, { bigint: true });
    if (
        !validManagedDirectory(named, root.device) ||
        named.ino !== entry.inode ||
        (named.mode & 0o7777n) !== 0o700n
    ) {
        throw failure();
    }
    await rmdir(entryPath);
    await root.handle.sync();
    await revalidateRoot(root);
}

async function retireEntry(
    root: OpenedRoot,
    entry: ManagedEntry,
    artifactKind: "release" | "runtime",
    dependencies: ProductionArtifactRetentionDependencies
): Promise<ManagedEntry> {
    if (entry.kind !== "published") throw failure();
    const source = path.join(`/proc/self/fd/${root.handle.fd}`, entry.name);
    const retiredName = `.retire-${entry.identity}`;
    const target = path.join(`/proc/self/fd/${root.handle.fd}`, retiredName);
    await dependencies.beforeEntryRetired?.(artifactKind, entry.identity);
    const before = await lstat(source, { bigint: true });
    if (before.dev !== root.device || before.ino !== entry.inode) throw failure();
    await rename(source, target);
    const retired = await lstat(target, { bigint: true });
    if (retired.dev !== root.device || retired.ino !== entry.inode) throw failure();
    await root.handle.sync();
    await revalidateRoot(root);
    await dependencies.afterEntryRetired?.(artifactKind, entry.identity);
    return Object.freeze({ ...entry, kind: "retired", name: retiredName });
}

function validateReferences(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    references: readonly ProductionArtifactReference[]
): void {
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        paths.releasesDirectory !== path.join(paths.productionDirectory, "releases") ||
        paths.runtimesDirectory !== path.join(paths.productionDirectory, "runtimes") ||
        references.length > 3 ||
        references.some(
            ({ releaseId, runtimeRevision }) =>
                !commitShaPattern.test(releaseId) ||
                !commitShaPattern.test(runtimeRevision)
        )
    ) {
        throw failure();
    }
    const releaseIds = new Set(references.map(({ releaseId }) => releaseId));
    if (releaseIds.size !== references.length) throw failure();
}

async function openOptionalBunRoot(
    paths: PreparedProductionDeliveryPaths,
    references: readonly ProductionArtifactReference[],
    readMountId: (fileDescriptor: number) => Promise<bigint>
): Promise<OpenedRoot | undefined> {
    const bunRoot = path.join(paths.runtimesDirectory, "bun");
    try {
        await lstat(bunRoot);
    } catch (error) {
        if (errorCode(error) === "ENOENT" && references.length === 0) return undefined;
        throw failure();
    }
    return openPrivateRoot(bunRoot, readMountId);
}

/**
 * Prunes every unreferenced immutable release and Bun runtime under the deployment lease.
 * The active, rollback, and candidate pairs are always retained; root inventories are bounded
 * and completely verified before the first rename. This protects against untrusted filesystem
 * shapes and accidental path/rename races. All authorized delivery mutations by the trusted
 * application UID must hold the exact deployment lease; hostile concurrent mutation by that UID
 * requires the planned root-owned handoff and is outside the current application-owned boundary.
 */
export async function retainProductionArtifacts(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    references: readonly ProductionArtifactReference[],
    dependencies: ProductionArtifactRetentionDependencies = {}
): Promise<void> {
    validateReferences(lease, paths, references);
    const protectedReleaseIds = new Set(references.map(({ releaseId }) => releaseId));
    const protectedRuntimeRevisions = new Set(
        references.map(({ runtimeRevision }) => runtimeRevision)
    );
    const verifyRelease =
        dependencies.verifyRelease ?? loadPublishedProductionReleaseById;
    const verifyRuntime = dependencies.verifyRuntime ?? inspectInstalledProductionRuntime;
    const readMountId = dependencies.readMountId ?? readDescriptorMountId;
    const releases = await openPrivateRoot(paths.releasesDirectory, readMountId);
    let runtimes: OpenedRoot | undefined;
    let failed = false;
    try {
        runtimes = await openOptionalBunRoot(paths, references, readMountId);
        const releaseInventory = await inventoryRoot(releases, protectedReleaseIds);
        const runtimeInventory: VerifiedInventory = runtimes
            ? await inventoryRoot(runtimes, protectedRuntimeRevisions)
            : Object.freeze({
                  entries: Object.freeze([]),
                  pointerStages: Object.freeze([]),
                  published: new Map<string, ManagedEntry>(),
              });

        const verifiedReleases = new Map<string, PublishedProductionRelease>();
        for (const [releaseId, entry] of releaseInventory.published) {
            await validateManagedTree(releases, entry);
            const release = await verifyRelease(paths, releaseId);
            if (
                release.releaseRoot !== path.join(paths.releasesDirectory, releaseId) ||
                release.manifest.source.commitSha !== releaseId
            ) {
                throw failure();
            }
            verifiedReleases.set(releaseId, release);
        }
        for (const reference of references) {
            const release = verifiedReleases.get(reference.releaseId);
            if (release?.manifest.runtime.revision !== reference.runtimeRevision) {
                throw failure();
            }
        }

        const verifiedRuntimes = new Map<string, InstalledProductionRuntime>();
        for (const [revision, entry] of runtimeInventory.published) {
            if (!runtimes) throw failure();
            await validateManagedTree(runtimes, entry);
            const runtime = await verifyRuntime(
                paths,
                revision,
                dependencies.runtimeVerification
            );
            if (
                runtime.identity.revision !== revision ||
                runtime.executable !==
                    path.join(paths.runtimesDirectory, "bun", revision, "bun")
            ) {
                throw failure();
            }
            verifiedRuntimes.set(revision, runtime);
        }
        for (const release of verifiedReleases.values()) {
            const runtime = verifiedRuntimes.get(release.manifest.runtime.revision);
            if (
                !runtime ||
                release.manifest.runtime.version !== runtime.identity.version
            ) {
                throw failure();
            }
        }

        for (const pointerStage of releaseInventory.pointerStages) {
            await reapPointerStage(releases, pointerStage);
        }
        if (runtimes) {
            for (const pointerStage of runtimeInventory.pointerStages) {
                await reapPointerStage(runtimes, pointerStage);
            }
        }

        for (const entry of releaseInventory.entries.filter(
            ({ kind }) => kind !== "published"
        )) {
            await reapEntry(releases, entry, dependencies);
        }
        for (const entry of releaseInventory.entries.filter(
            ({ identity, kind }) =>
                kind === "published" && !protectedReleaseIds.has(identity)
        )) {
            await reapEntry(
                releases,
                await retireEntry(releases, entry, "release", dependencies),
                dependencies
            );
        }
        if (runtimes) {
            for (const entry of runtimeInventory.entries.filter(
                ({ kind }) => kind !== "published"
            )) {
                await reapEntry(runtimes, entry, dependencies);
            }
            for (const entry of runtimeInventory.entries.filter(
                ({ identity, kind }) =>
                    kind === "published" && !protectedRuntimeRevisions.has(identity)
            )) {
                await reapEntry(
                    runtimes,
                    await retireEntry(runtimes, entry, "runtime", dependencies),
                    dependencies
                );
            }
        }
    } catch {
        failed = true;
    }
    const [releasesClosed, runtimesClosed] = await Promise.all([
        closeHandle(releases.handle),
        closeHandle(runtimes?.handle),
    ]);
    if (failed || !releasesClosed || !runtimesClosed) throw failure();
}
