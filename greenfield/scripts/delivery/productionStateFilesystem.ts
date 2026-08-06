import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

const directoryOpenFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const permissionBits = 0o7777n;
const privateDirectoryMode = 0o700;
const privateDirectoryModeBigInt = 0o700n;
const otherPrincipalWriteBits = 0o022n;
const stickyBit = 0o1000n;

const productionDirectoryName = "production";
const stateDirectoryName = "state";
const stateChildDirectoryNames = Object.freeze([
    "backups",
    "job-output",
    "logs",
] as const);

/** Stable paths created beneath one canonical Dashboard project root. */
export interface PreparedProductionStatePaths {
    readonly backupsDirectory: string;
    readonly jobOutputDirectory: string;
    readonly logsDirectory: string;
    readonly productionDirectory: string;
    readonly projectRoot: string;
    readonly stateDirectory: string;
}

/** Deterministic mutation boundaries exposed only to adversarial tests. */
export type ProductionStateFilesystemTestStage =
    | "ancestor-protected"
    | "managed-directory-prepared";

/**
 * Deterministic test hook. Production delivery composition must leave this absent.
 * @internal
 */
export interface ProductionStateFilesystemTestHooks {
    readonly afterStage?: (
        stage: ProductionStateFilesystemTestStage,
        directory: string
    ) => Promise<void> | void;
}

/** Raised when project-local production state cannot be prepared safely. */
export class ProductionStateFilesystemError extends Error {
    override readonly name = "ProductionStateFilesystemError";
}

interface DirectoryIdentity {
    readonly device: bigint;
    readonly inode: bigint;
}

interface OpenedDirectory {
    readonly canonicalPath: string;
    readonly descriptorPath: string;
    readonly handle: FileHandle;
    readonly identity: DirectoryIdentity;
}

function invalidProductionStateFilesystem(): ProductionStateFilesystemError {
    return new ProductionStateFilesystemError(
        "Production state path violates the protected project-local filesystem policy"
    );
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw invalidProductionStateFilesystem();
    }
    return process.getuid();
}

function descriptorPath(handle: FileHandle): string {
    return `/proc/self/fd/${handle.fd}`;
}

function identityOf(stat: BigIntStats): DirectoryIdentity {
    return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function hasIdentity(stat: BigIntStats, identity: DirectoryIdentity): boolean {
    return stat.dev === identity.device && stat.ino === identity.inode;
}

function isMissingPathFailure(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        return descriptor !== undefined && "value" in descriptor
            ? descriptor.value === "ENOENT"
            : false;
    } catch {
        return false;
    }
}

function isExistingPathFailure(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        return descriptor !== undefined && "value" in descriptor
            ? descriptor.value === "EEXIST"
            : false;
    } catch {
        return false;
    }
}

function isDirectChild(parent: string, child: string, childName: string): boolean {
    return path.dirname(child) === parent && path.basename(child) === childName;
}

function isTrustedOwner(ownerId: bigint, userId: number): boolean {
    return ownerId === 0n || ownerId === BigInt(userId);
}

function isProtectedAncestor(
    stat: BigIntStats,
    childOwnerId: bigint,
    userId: number
): boolean {
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !isTrustedOwner(stat.uid, userId)
    ) {
        return false;
    }
    if ((stat.mode & otherPrincipalWriteBits) === 0n) return true;
    return (stat.mode & stickyBit) !== 0n && isTrustedOwner(childOwnerId, userId);
}

function isPrivateDirectory(stat: BigIntStats, userId: number): boolean {
    return (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === BigInt(userId) &&
        (stat.mode & permissionBits) === privateDirectoryModeBigInt
    );
}

async function openStableDirectory(
    requestedPath: string,
    expectedCanonicalPath: string,
    resources: FileHandle[]
): Promise<OpenedDirectory> {
    try {
        const beforeOpen = await lstat(requestedPath, { bigint: true });
        if (!beforeOpen.isDirectory() || beforeOpen.isSymbolicLink()) {
            throw invalidProductionStateFilesystem();
        }

        const handle = await open(requestedPath, directoryOpenFlags);
        resources.push(handle);
        const heldDescriptorPath = descriptorPath(handle);
        const [snapshot, canonicalPath, afterOpen] = await Promise.all([
            handle.stat({ bigint: true }),
            realpath(heldDescriptorPath),
            lstat(requestedPath, { bigint: true }),
        ]);
        const identity = identityOf(snapshot);
        if (
            !snapshot.isDirectory() ||
            snapshot.isSymbolicLink() ||
            canonicalPath !== expectedCanonicalPath ||
            !hasIdentity(beforeOpen, identity) ||
            !hasIdentity(afterOpen, identity)
        ) {
            throw invalidProductionStateFilesystem();
        }
        return {
            canonicalPath,
            descriptorPath: heldDescriptorPath,
            handle,
            identity,
        };
    } catch (error) {
        if (error instanceof ProductionStateFilesystemError) throw error;
        throw invalidProductionStateFilesystem();
    }
}

async function entryStillMatches(directory: OpenedDirectory): Promise<boolean> {
    let pathHandle: FileHandle | undefined;
    let matches: boolean | undefined;
    try {
        const beforeOpen = await lstat(directory.canonicalPath, { bigint: true });
        pathHandle = await open(directory.canonicalPath, directoryOpenFlags);
        const pathDescriptor = descriptorPath(pathHandle);
        const [heldStat, pathStat, canonicalPath, afterOpen] = await Promise.all([
            directory.handle.stat({ bigint: true }),
            pathHandle.stat({ bigint: true }),
            realpath(pathDescriptor),
            lstat(directory.canonicalPath, { bigint: true }),
        ]);
        matches =
            heldStat.isDirectory() &&
            pathStat.isDirectory() &&
            !beforeOpen.isSymbolicLink() &&
            !afterOpen.isSymbolicLink() &&
            canonicalPath === directory.canonicalPath &&
            hasIdentity(heldStat, directory.identity) &&
            hasIdentity(pathStat, directory.identity) &&
            hasIdentity(beforeOpen, directory.identity) &&
            hasIdentity(afterOpen, directory.identity);
    } catch {
        matches = false;
    }
    if (pathHandle) {
        try {
            await pathHandle.close();
        } catch {
            matches = false;
        }
    }
    return matches ?? false;
}

async function protectAncestor(
    directory: OpenedDirectory,
    childOwnerId: bigint,
    userId: number
): Promise<bigint> {
    const before = await directory.handle.stat({ bigint: true });
    if (
        !hasIdentity(before, directory.identity) ||
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        !isTrustedOwner(before.uid, userId)
    ) {
        throw invalidProductionStateFilesystem();
    }

    const writableByAnotherPrincipal = (before.mode & otherPrincipalWriteBits) !== 0n;
    const sticky = (before.mode & stickyBit) !== 0n;
    if (writableByAnotherPrincipal && !sticky) {
        if (before.uid !== BigInt(userId)) {
            throw invalidProductionStateFilesystem();
        }
        const currentMode = before.mode & permissionBits;
        const protectedMode = currentMode & ~otherPrincipalWriteBits;
        await directory.handle.chmod(Number(protectedMode));
    }

    const after = await directory.handle.stat({ bigint: true });
    if (
        !hasIdentity(after, directory.identity) ||
        after.uid !== before.uid ||
        !isProtectedAncestor(after, childOwnerId, userId) ||
        !(await entryStillMatches(directory))
    ) {
        throw invalidProductionStateFilesystem();
    }
    return after.uid;
}

async function protectAncestorChain(
    projectRoot: string,
    userId: number,
    resources: FileHandle[],
    testHooks?: ProductionStateFilesystemTestHooks
): Promise<readonly OpenedDirectory[]> {
    const directories: OpenedDirectory[] = [];
    let currentPath = projectRoot;
    let childOwnerId = BigInt(userId);

    while (true) {
        const directory = await openStableDirectory(currentPath, currentPath, resources);
        directories.push(directory);
        const ownerId = await protectAncestor(directory, childOwnerId, userId);
        if (directories.length === 1 && ownerId !== BigInt(userId)) {
            throw invalidProductionStateFilesystem();
        }
        await testHooks?.afterStage?.("ancestor-protected", currentPath);
        childOwnerId = ownerId;

        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) break;
        currentPath = parentPath;
    }

    await revalidateAncestorChain(directories, userId);
    return directories;
}

async function revalidateAncestorChain(
    directories: readonly OpenedDirectory[],
    userId: number
): Promise<void> {
    let childOwnerId = BigInt(userId);
    for (const [index, directory] of directories.entries()) {
        const stat = await directory.handle.stat({ bigint: true });
        if (
            !hasIdentity(stat, directory.identity) ||
            !isProtectedAncestor(stat, childOwnerId, userId) ||
            (index === 0 && stat.uid !== BigInt(userId)) ||
            !(await entryStillMatches(directory))
        ) {
            throw invalidProductionStateFilesystem();
        }
        childOwnerId = stat.uid;
    }
}

async function createDirectoryIfMissing(
    parent: OpenedDirectory,
    childName: string
): Promise<boolean> {
    const anchoredPath = path.join(parent.descriptorPath, childName);
    try {
        await lstat(anchoredPath, { bigint: true });
        return false;
    } catch (error) {
        if (!isMissingPathFailure(error)) {
            throw invalidProductionStateFilesystem();
        }
    }

    try {
        await mkdir(anchoredPath, { mode: privateDirectoryMode });
        return true;
    } catch (error) {
        if (isExistingPathFailure(error)) return false;
        throw invalidProductionStateFilesystem();
    }
}

async function openManagedChild(
    parent: OpenedDirectory,
    childName: string,
    resources: FileHandle[]
): Promise<{ readonly created: boolean; readonly directory: OpenedDirectory }> {
    const created = await createDirectoryIfMissing(parent, childName);
    const canonicalPath = path.join(parent.canonicalPath, childName);
    const directory = await openStableDirectory(
        path.join(parent.descriptorPath, childName),
        canonicalPath,
        resources
    );
    const stat = await directory.handle.stat({ bigint: true });
    if (
        stat.dev !== parent.identity.device ||
        !isDirectChild(parent.canonicalPath, canonicalPath, childName)
    ) {
        throw invalidProductionStateFilesystem();
    }
    return { created, directory };
}

async function prepareProductionDirectory(
    projectRoot: OpenedDirectory,
    userId: number,
    resources: FileHandle[],
    testHooks?: ProductionStateFilesystemTestHooks
): Promise<OpenedDirectory> {
    const { created, directory } = await openManagedChild(
        projectRoot,
        productionDirectoryName,
        resources
    );
    const before = await directory.handle.stat({ bigint: true });
    if (before.uid !== BigInt(userId)) {
        throw invalidProductionStateFilesystem();
    }
    if (
        !created &&
        (before.mode & privateDirectoryModeBigInt) !== privateDirectoryModeBigInt
    ) {
        throw invalidProductionStateFilesystem();
    }
    await directory.handle.chmod(privateDirectoryMode);
    const after = await directory.handle.stat({ bigint: true });
    if (
        !hasIdentity(after, directory.identity) ||
        after.uid !== BigInt(userId) ||
        !isPrivateDirectory(after, userId) ||
        !(await entryStillMatches(directory))
    ) {
        throw invalidProductionStateFilesystem();
    }
    await testHooks?.afterStage?.("managed-directory-prepared", directory.canonicalPath);
    return directory;
}

async function preparePrivateDirectory(
    parent: OpenedDirectory,
    childName: string,
    userId: number,
    resources: FileHandle[],
    testHooks?: ProductionStateFilesystemTestHooks
): Promise<OpenedDirectory> {
    const { created, directory } = await openManagedChild(parent, childName, resources);
    const before = await directory.handle.stat({ bigint: true });
    if (
        before.uid !== BigInt(userId) ||
        (!created &&
            (before.mode & privateDirectoryModeBigInt) !== privateDirectoryModeBigInt)
    ) {
        throw invalidProductionStateFilesystem();
    }
    await directory.handle.chmod(privateDirectoryMode);
    const after = await directory.handle.stat({ bigint: true });
    if (
        !hasIdentity(after, directory.identity) ||
        after.uid !== before.uid ||
        !isPrivateDirectory(after, userId) ||
        !(await entryStillMatches(directory))
    ) {
        throw invalidProductionStateFilesystem();
    }
    await testHooks?.afterStage?.("managed-directory-prepared", directory.canonicalPath);
    return directory;
}

async function validatePrivateDirectory(
    directory: OpenedDirectory,
    userId: number
): Promise<void> {
    const stat = await directory.handle.stat({ bigint: true });
    if (
        !hasIdentity(stat, directory.identity) ||
        !isPrivateDirectory(stat, userId) ||
        !(await entryStillMatches(directory))
    ) {
        throw invalidProductionStateFilesystem();
    }
}

async function closeResources(resources: readonly FileHandle[]): Promise<boolean> {
    let closed = true;
    for (const handle of resources.toReversed()) {
        try {
            await handle.close();
        } catch {
            closed = false;
        }
    }
    return closed;
}

function validateProjectRootInput(projectRoot: string): void {
    if (
        !path.isAbsolute(projectRoot) ||
        projectRoot.includes("\0") ||
        path.resolve(projectRoot) !== projectRoot ||
        path.parse(projectRoot).root === projectRoot
    ) {
        throw invalidProductionStateFilesystem();
    }
}

/**
 * Creates and verifies private production state beneath one explicit project root.
 * Existing current-user-owned non-sticky ancestors are only made less writable;
 * application runtime startup must validate the result without calling this helper.
 * @param projectRoot Canonical Dashboard project root, not a checkout directory.
 * @param testHooks Deterministic adversarial hooks used only by tests.
 * @returns Canonical project-local production state paths.
 */
export async function prepareProtectedProductionStatePath(
    projectRoot: string,
    testHooks?: ProductionStateFilesystemTestHooks
): Promise<PreparedProductionStatePaths> {
    validateProjectRootInput(projectRoot);
    const userId = currentUserId();
    const resources: FileHandle[] = [];
    let preparedPaths: PreparedProductionStatePaths | undefined;
    let failure: unknown;

    try {
        const ancestors = await protectAncestorChain(
            projectRoot,
            userId,
            resources,
            testHooks
        );
        const canonicalProjectRoot = ancestors[0];
        if (!canonicalProjectRoot) throw invalidProductionStateFilesystem();

        const production = await prepareProductionDirectory(
            canonicalProjectRoot,
            userId,
            resources,
            testHooks
        );
        const state = await preparePrivateDirectory(
            production,
            stateDirectoryName,
            userId,
            resources,
            testHooks
        );
        const stateChildren = new Map<string, OpenedDirectory>();
        for (const childName of stateChildDirectoryNames) {
            stateChildren.set(
                childName,
                await preparePrivateDirectory(
                    state,
                    childName,
                    userId,
                    resources,
                    testHooks
                )
            );
        }

        await revalidateAncestorChain(ancestors, userId);
        await protectAncestor(production, BigInt(userId), userId);
        await validatePrivateDirectory(state, userId);
        for (const child of stateChildren.values()) {
            await validatePrivateDirectory(child, userId);
        }

        const backups = stateChildren.get("backups");
        const jobOutput = stateChildren.get("job-output");
        const logs = stateChildren.get("logs");
        if (!backups || !jobOutput || !logs) {
            throw invalidProductionStateFilesystem();
        }
        preparedPaths = Object.freeze({
            backupsDirectory: backups.canonicalPath,
            jobOutputDirectory: jobOutput.canonicalPath,
            logsDirectory: logs.canonicalPath,
            productionDirectory: production.canonicalPath,
            projectRoot: canonicalProjectRoot.canonicalPath,
            stateDirectory: state.canonicalPath,
        });
    } catch (error) {
        failure = error;
    }

    const closed = await closeResources(resources);
    if (failure instanceof ProductionStateFilesystemError) throw failure;
    if (failure !== undefined || !closed || !preparedPaths) {
        throw invalidProductionStateFilesystem();
    }
    return preparedPaths;
}
