import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

const bytesPerMebibyte = 1024 * 1024;
const reviewedMigrationArtifactNames = Object.freeze([
    "migration.sql",
    "snapshot.json",
] as const);

/** Reviewable resource ceilings for the canonical migration artifact graph. */
export const migrationArtifactByteLimits = Object.freeze({
    graph: 32 * bytesPerMebibyte,
    migrationSql: bytesPerMebibyte,
    snapshot: 4 * bytesPerMebibyte,
});

const migrationDirectoryMismatchError =
    "Migration directory does not match the reviewed manifest";
const migrationArtifactInventoryError =
    "Migration node does not contain the exact reviewed artifacts";
const migrationArtifactStateError =
    "Migration artifact graph is not a stable regular-file graph";
const migrationArtifactByteLimitError =
    "Migration artifact graph exceeds the reviewed byte budget";

/** Stable read boundaries exposed only for deterministic adversarial tests. */
export type MigrationArtifactVerificationTestStage =
    | "migration-sql-initial-stat"
    | "node-inventory"
    | "root-inventory"
    | "snapshot-initial-stat";

/**
 * Deterministic test hook. Production composition must leave this absent.
 * @internal
 */
export interface MigrationArtifactVerificationTestHooks {
    readonly afterStage?: (
        stage: MigrationArtifactVerificationTestStage
    ) => Promise<void> | void;
}

/** Stable artifact bytes aligned with the reviewed manifest order. */
export interface StableMigrationArtifacts {
    readonly migrationSql: Buffer;
    readonly snapshot: Buffer;
}

interface OpenedDirectory {
    readonly canonicalPath: string;
    readonly descriptorPath: string;
    readonly handle: FileHandle;
    readonly snapshot: BigIntStats;
}

interface OpenedArtifact {
    readonly directory: OpenedDirectory;
    readonly filename: (typeof reviewedMigrationArtifactNames)[number];
    readonly handle: FileHandle;
    readonly snapshot: BigIntStats;
}

interface OpenedMigrationNode {
    readonly artifacts: readonly [OpenedArtifact, OpenedArtifact];
    readonly directory: OpenedDirectory;
    readonly id: string;
}

interface DirectoryPathExpectation {
    readonly directChild?: {
        readonly name: string;
        readonly parentCanonicalPath: string;
    };
    readonly requestedPath: string;
}

function invalidState(message: string): Error {
    return new Error(message);
}

function descriptorPath(handle: FileHandle): string {
    return `/proc/self/fd/${handle.fd}`;
}

function isDirectChild(parent: string, child: string, expectedName: string): boolean {
    return path.dirname(child) === parent && path.basename(child) === expectedName;
}

function matchesSnapshot(before: BigIntStats, after: BigIntStats): boolean {
    return (
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.mode === before.mode &&
        after.nlink === before.nlink &&
        after.uid === before.uid &&
        after.gid === before.gid &&
        after.size === before.size &&
        after.ctimeNs === before.ctimeNs &&
        after.mtimeNs === before.mtimeNs
    );
}

async function readExactDirectoryInventory(
    directory: OpenedDirectory,
    expectedNames: readonly string[],
    invalidMessage: string
): Promise<void> {
    let openedDirectory: Awaited<ReturnType<typeof opendir>> | undefined;
    let names: string[] | undefined;
    let failed = false;
    try {
        openedDirectory = await opendir(directory.descriptorPath);
        const readNames: string[] = [];
        while (true) {
            const entry = await openedDirectory.read();
            if (!entry) break;
            if (readNames.length >= expectedNames.length) {
                throw invalidState(invalidMessage);
            }
            readNames.push(entry.name);
        }
        names = readNames.toSorted();
    } catch {
        failed = true;
    }
    if (openedDirectory) {
        try {
            await openedDirectory.close();
        } catch {
            failed = true;
        }
    }
    if (failed || !names || names.join("\n") !== expectedNames.join("\n")) {
        throw invalidState(invalidMessage);
    }
}

async function openRootDirectory(
    requestedDirectory: string,
    resources: FileHandle[]
): Promise<OpenedDirectory> {
    if (
        typeof requestedDirectory !== "string" ||
        requestedDirectory.length === 0 ||
        requestedDirectory.includes("\0")
    ) {
        throw invalidState(migrationDirectoryMismatchError);
    }
    const absoluteDirectory = path.resolve(requestedDirectory);
    try {
        const handle = await open(
            absoluteDirectory,
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK
        );
        resources.push(handle);
        const snapshot = await handle.stat({ bigint: true });
        if (!snapshot.isDirectory()) {
            throw invalidState(migrationDirectoryMismatchError);
        }
        const heldDescriptorPath = descriptorPath(handle);
        return {
            canonicalPath: await realpath(heldDescriptorPath),
            descriptorPath: heldDescriptorPath,
            handle,
            snapshot,
        };
    } catch {
        throw invalidState(migrationDirectoryMismatchError);
    }
}

async function openChildDirectory(
    parent: OpenedDirectory,
    childName: string,
    resources: FileHandle[]
): Promise<OpenedDirectory> {
    try {
        const handle = await open(
            path.join(parent.descriptorPath, childName),
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK
        );
        resources.push(handle);
        const snapshot = await handle.stat({ bigint: true });
        const heldDescriptorPath = descriptorPath(handle);
        const canonicalPath = await realpath(heldDescriptorPath);
        if (
            !snapshot.isDirectory() ||
            snapshot.dev !== parent.snapshot.dev ||
            !isDirectChild(parent.canonicalPath, canonicalPath, childName)
        ) {
            throw invalidState(migrationArtifactStateError);
        }
        return {
            canonicalPath,
            descriptorPath: heldDescriptorPath,
            handle,
            snapshot,
        };
    } catch {
        throw invalidState(migrationArtifactStateError);
    }
}

async function openArtifact(
    directory: OpenedDirectory,
    filename: OpenedArtifact["filename"],
    byteLimit: number,
    resources: FileHandle[]
): Promise<OpenedArtifact> {
    try {
        const handle = await open(
            path.join(directory.descriptorPath, filename),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        resources.push(handle);
        const snapshot = await handle.stat({ bigint: true });
        const canonicalPath = await realpath(descriptorPath(handle));
        if (
            !snapshot.isFile() ||
            snapshot.nlink !== 1n ||
            snapshot.dev !== directory.snapshot.dev ||
            snapshot.size <= 0n ||
            snapshot.size > BigInt(byteLimit) ||
            !isDirectChild(directory.canonicalPath, canonicalPath, filename)
        ) {
            throw invalidState(
                snapshot.size > BigInt(byteLimit)
                    ? migrationArtifactByteLimitError
                    : migrationArtifactStateError
            );
        }
        return { directory, filename, handle, snapshot };
    } catch (error) {
        if (error instanceof Error && error.message === migrationArtifactByteLimitError) {
            throw error;
        }
        throw invalidState(migrationArtifactStateError);
    }
}

async function revalidateArtifactPath(artifact: OpenedArtifact): Promise<void> {
    let pathHandle: FileHandle | undefined;
    let failed = false;
    try {
        pathHandle = await open(
            path.join(artifact.directory.descriptorPath, artifact.filename),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const pathSnapshot = await pathHandle.stat({ bigint: true });
        const canonicalPath = await realpath(descriptorPath(pathHandle));
        if (
            !pathSnapshot.isFile() ||
            pathSnapshot.nlink !== 1n ||
            !matchesSnapshot(artifact.snapshot, pathSnapshot) ||
            !isDirectChild(
                artifact.directory.canonicalPath,
                canonicalPath,
                artifact.filename
            )
        ) {
            failed = true;
        }
    } catch {
        failed = true;
    }
    if (pathHandle) {
        try {
            await pathHandle.close();
        } catch {
            failed = true;
        }
    }
    if (failed) throw invalidState(migrationArtifactStateError);
}

async function readStableArtifact(artifact: OpenedArtifact): Promise<Buffer> {
    const expectedBytes = Number(artifact.snapshot.size);
    const bytes = Buffer.alloc(expectedBytes + 1);
    let bytesRead = 0;
    try {
        while (bytesRead < bytes.byteLength) {
            const read = await artifact.handle.read(
                bytes,
                bytesRead,
                bytes.byteLength - bytesRead,
                bytesRead
            );
            if (read.bytesRead === 0) break;
            bytesRead += read.bytesRead;
        }
        const afterRead = await artifact.handle.stat({ bigint: true });
        if (
            bytesRead !== expectedBytes ||
            !matchesSnapshot(artifact.snapshot, afterRead)
        ) {
            throw invalidState(migrationArtifactStateError);
        }
        await revalidateArtifactPath(artifact);
        return bytes.subarray(0, bytesRead);
    } catch {
        throw invalidState(migrationArtifactStateError);
    }
}

async function revalidateDirectory(
    directory: OpenedDirectory,
    expectedInventory: readonly string[],
    pathExpectation: DirectoryPathExpectation,
    invalidMessage: string
): Promise<void> {
    try {
        await readExactDirectoryInventory(directory, expectedInventory, invalidMessage);
        const afterRead = await directory.handle.stat({ bigint: true });
        if (!matchesSnapshot(directory.snapshot, afterRead)) {
            throw invalidState(invalidMessage);
        }

        const pathHandle = await open(
            pathExpectation.requestedPath,
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK
        );
        let pathFailed = false;
        try {
            const pathSnapshot = await pathHandle.stat({ bigint: true });
            const canonicalPath = await realpath(descriptorPath(pathHandle));
            if (
                !pathSnapshot.isDirectory() ||
                !matchesSnapshot(directory.snapshot, pathSnapshot) ||
                (pathExpectation.directChild &&
                    !isDirectChild(
                        pathExpectation.directChild.parentCanonicalPath,
                        canonicalPath,
                        pathExpectation.directChild.name
                    ))
            ) {
                pathFailed = true;
            }
        } catch {
            pathFailed = true;
        }
        try {
            await pathHandle.close();
        } catch {
            pathFailed = true;
        }
        if (pathFailed) throw invalidState(invalidMessage);
    } catch {
        throw invalidState(invalidMessage);
    }
}

async function closeResources(resources: readonly FileHandle[]): Promise<boolean> {
    let failed = false;
    for (const handle of resources.toReversed()) {
        try {
            await handle.close();
        } catch {
            failed = true;
        }
    }
    return !failed;
}

/**
 * Reads one exact, stable artifact pair for every reviewed migration id.
 * @param requestedDirectory Canonical migration graph root selected by composition.
 * @param manifestIds Ordered reviewed migration ids.
 * @param testHooks Deterministic mutation boundaries used only by security tests.
 * @returns Stable artifact bytes aligned with manifest order.
 */
export async function readStableMigrationArtifactGraph(
    requestedDirectory: string,
    manifestIds: readonly string[],
    testHooks?: MigrationArtifactVerificationTestHooks
): Promise<readonly StableMigrationArtifacts[]> {
    const resources: FileHandle[] = [];
    let result: readonly StableMigrationArtifacts[] | undefined;
    let failure: unknown;

    try {
        const root = await openRootDirectory(requestedDirectory, resources);
        const requestedRoot = path.resolve(requestedDirectory);
        await readExactDirectoryInventory(
            root,
            manifestIds,
            migrationDirectoryMismatchError
        );
        await testHooks?.afterStage?.("root-inventory");

        const openedNodes: OpenedMigrationNode[] = [];
        let graphBytes = 0n;
        for (const id of manifestIds) {
            const directory = await openChildDirectory(root, id, resources);
            await readExactDirectoryInventory(
                directory,
                reviewedMigrationArtifactNames,
                migrationArtifactInventoryError
            );
            await testHooks?.afterStage?.("node-inventory");

            const migrationSql = await openArtifact(
                directory,
                "migration.sql",
                migrationArtifactByteLimits.migrationSql,
                resources
            );
            await testHooks?.afterStage?.("migration-sql-initial-stat");
            const snapshot = await openArtifact(
                directory,
                "snapshot.json",
                migrationArtifactByteLimits.snapshot,
                resources
            );
            await testHooks?.afterStage?.("snapshot-initial-stat");
            graphBytes += migrationSql.snapshot.size + snapshot.snapshot.size;
            if (graphBytes > BigInt(migrationArtifactByteLimits.graph)) {
                throw invalidState(migrationArtifactByteLimitError);
            }
            openedNodes.push({
                artifacts: [migrationSql, snapshot],
                directory,
                id,
            });
        }

        const artifacts: StableMigrationArtifacts[] = [];
        for (const node of openedNodes) {
            const [migrationSql, snapshot] = node.artifacts;
            artifacts.push({
                migrationSql: await readStableArtifact(migrationSql),
                snapshot: await readStableArtifact(snapshot),
            });
        }
        for (const node of openedNodes) {
            await revalidateDirectory(
                node.directory,
                reviewedMigrationArtifactNames,
                {
                    directChild: {
                        name: node.id,
                        parentCanonicalPath: root.canonicalPath,
                    },
                    requestedPath: path.join(root.descriptorPath, node.id),
                },
                migrationArtifactStateError
            );
        }
        await revalidateDirectory(
            root,
            manifestIds,
            { requestedPath: requestedRoot },
            migrationDirectoryMismatchError
        );
        result = Object.freeze(artifacts);
    } catch (error) {
        failure = error;
    }

    const closed = await closeResources(resources);
    if (failure !== undefined) {
        throw failure instanceof Error
            ? failure
            : invalidState(migrationArtifactStateError);
    }
    if (!closed || !result) throw invalidState(migrationArtifactStateError);
    return result;
}
