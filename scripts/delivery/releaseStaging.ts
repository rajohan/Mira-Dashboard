import {
    chmod,
    lstat,
    mkdir,
    readdir,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

import { readBoundedRegularFile } from "../files/boundedFile.ts";
import { resolveRepositoryBuildPath } from "./buildPaths.ts";
import {
    inventoryReleaseArtifactTree,
    maximumReleaseArtifactBytes,
    maximumReleaseRuntimeBytes,
    type ReleaseArtifactInventoryRecord,
} from "./releaseArtifactInventory.ts";

const invalidReleaseStagingMessage = "Release staging failed";
const commitShaPattern = /^[a-f\d]{40}$/u;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const immutableDirectoryMode = 0o500;
const immutableExecutableMode = 0o500;
const immutableFileMode = 0o400;
const maximumMetadataBytes = 4 * 1024 * 1024;

/** Exclusive temporary and final paths for one source commit. */
export interface ReleaseStagingPaths {
    readonly finalRoot: string;
    readonly stagingRoot: string;
}

/** Artifact sources copied into a fresh release candidate. */
export interface ReleaseStagingSources {
    readonly browserRoot: string;
    readonly processRoot: string;
    readonly repositoryRoot: string;
    readonly runtimeExecutable: string;
    readonly stagingRoot: string;
}

function invalidReleaseStaging(): Error {
    return new Error(invalidReleaseStagingMessage);
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
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

function isMissingPath(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

async function requireMissing(candidate: string): Promise<void> {
    try {
        await lstat(candidate);
    } catch (error) {
        if (isMissingPath(error)) return;
        throw invalidReleaseStaging();
    }
    throw invalidReleaseStaging();
}

async function requireProtectedOwnedDirectory(directory: string): Promise<void> {
    if (typeof process.getuid !== "function") throw invalidReleaseStaging();
    const [canonical, status] = await Promise.all([
        realpath(directory),
        lstat(directory, { bigint: true }),
    ]);
    if (
        canonical !== directory ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o022n) !== 0n
    ) {
        throw invalidReleaseStaging();
    }
}

async function copyArtifactTree(sourceRoot: string, destinationRoot: string) {
    const sourceBefore = await inventoryReleaseArtifactTree(sourceRoot);
    await mkdir(path.dirname(destinationRoot), {
        mode: privateDirectoryMode,
        recursive: true,
    });
    await mkdir(destinationRoot, { mode: privateDirectoryMode, recursive: false });

    for (const record of sourceBefore) {
        const contents = await readBoundedRegularFile(
            path.join(sourceRoot, record.path),
            sourceRoot,
            maximumReleaseArtifactBytes,
            invalidReleaseStagingMessage
        );
        if (contents.byteLength !== record.bytes || sha256(contents) !== record.sha256) {
            throw invalidReleaseStaging();
        }
        const destination = path.join(destinationRoot, record.path);
        await mkdir(path.dirname(destination), {
            mode: privateDirectoryMode,
            recursive: true,
        });
        await writeFile(destination, contents, {
            flag: "wx",
            mode: privateFileMode,
        });
    }

    const [sourceAfter, destination] = await Promise.all([
        inventoryReleaseArtifactTree(sourceRoot),
        inventoryReleaseArtifactTree(destinationRoot),
    ]);
    if (
        !sameArtifactRecords(sourceBefore, sourceAfter) ||
        !sameArtifactRecords(sourceBefore, destination)
    ) {
        throw invalidReleaseStaging();
    }
    return sourceBefore;
}

async function copyMetadataFile(
    source: string,
    sourceRoot: string,
    destination: string
): Promise<void> {
    const contents = await readBoundedRegularFile(
        source,
        sourceRoot,
        maximumMetadataBytes,
        invalidReleaseStagingMessage
    );
    await writeFile(destination, contents, { flag: "wx", mode: privateFileMode });
    const reread = await readBoundedRegularFile(
        source,
        sourceRoot,
        maximumMetadataBytes,
        invalidReleaseStagingMessage
    );
    if (
        contents.byteLength !== reread.byteLength ||
        sha256(contents) !== sha256(reread)
    ) {
        throw invalidReleaseStaging();
    }
}

async function copyRuntimeExecutable(source: string, destination: string): Promise<void> {
    const contents = await readBoundedRegularFile(
        source,
        path.dirname(source),
        maximumReleaseRuntimeBytes,
        invalidReleaseStagingMessage
    );
    await mkdir(path.dirname(destination), {
        mode: privateDirectoryMode,
        recursive: false,
    });
    await writeFile(destination, contents, {
        flag: "wx",
        mode: immutableExecutableMode,
    });
    const reread = await readBoundedRegularFile(
        source,
        path.dirname(source),
        maximumReleaseRuntimeBytes,
        invalidReleaseStagingMessage
    );
    if (
        contents.byteLength !== reread.byteLength ||
        sha256(contents) !== sha256(reread)
    ) {
        throw invalidReleaseStaging();
    }
}

/**
 * Allocates an exclusive staging directory and reserves a commit-addressed final path.
 * @param repositoryRoot Canonical future-root checkout.
 * @param commitSha Clean source commit represented by the release.
 * @returns Fresh staging and absent final paths below `dist/releases`.
 */
export async function createReleaseStagingPaths(
    repositoryRoot: string,
    commitSha: string
): Promise<ReleaseStagingPaths> {
    if (!commitShaPattern.test(commitSha)) throw invalidReleaseStaging();
    const buildPath = resolveRepositoryBuildPath(
        repositoryRoot,
        path.join(repositoryRoot, "dist/releases", commitSha),
        invalidReleaseStagingMessage
    );
    const releasesRoot = path.dirname(buildPath.output);
    await mkdir(releasesRoot, { mode: privateDirectoryMode, recursive: true });
    await requireProtectedOwnedDirectory(releasesRoot);
    await requireMissing(buildPath.output);

    const stagingRoot = path.join(
        releasesRoot,
        `.stage-${commitSha}-${Bun.randomUUIDv7()}`
    );
    await mkdir(stagingRoot, { mode: privateDirectoryMode, recursive: false });
    await requireProtectedOwnedDirectory(stagingRoot);
    return Object.freeze({ finalRoot: buildPath.output, stagingRoot });
}

/**
 * Copies exact browser, process, migration, documentation, and package metadata bytes.
 * @param sources Canonical build/source roots and an empty exclusive staging root.
 */
export async function stageReleaseArtifacts(
    sources: ReleaseStagingSources
): Promise<void> {
    const { output: stagingRoot } = resolveRepositoryBuildPath(
        sources.repositoryRoot,
        sources.stagingRoot,
        invalidReleaseStagingMessage
    );
    await requireProtectedOwnedDirectory(stagingRoot);
    const existingEntries = await readdir(stagingRoot);
    if (existingEntries.length > 0) throw invalidReleaseStaging();

    const metadataRoot = path.join(stagingRoot, "metadata");
    const sharedSourceRoot = path.join(stagingRoot, "src/shared");
    await Promise.all([
        mkdir(metadataRoot, { mode: privateDirectoryMode, recursive: false }),
        mkdir(sharedSourceRoot, { mode: privateDirectoryMode, recursive: true }),
    ]);
    await Promise.all([
        copyArtifactTree(sources.browserRoot, path.join(stagingRoot, "browser")),
        copyArtifactTree(sources.processRoot, path.join(stagingRoot, "server")),
        copyArtifactTree(
            path.join(sources.repositoryRoot, "docs/generated"),
            path.join(stagingRoot, "docs/generated")
        ),
        copyArtifactTree(
            path.join(sources.repositoryRoot, "migrations"),
            path.join(stagingRoot, "migrations")
        ),
        copyArtifactTree(
            path.join(sources.repositoryRoot, "systemd"),
            path.join(stagingRoot, "systemd")
        ),
        copyArtifactTree(
            path.join(sources.repositoryRoot, "scripts/delivery/provisioning"),
            path.join(stagingRoot, "scripts/delivery/provisioning")
        ),
        copyMetadataFile(
            path.join(sources.repositoryRoot, "src/shared/managedLogManifest.ts"),
            sources.repositoryRoot,
            path.join(sharedSourceRoot, "managedLogManifest.ts")
        ),
        copyRuntimeExecutable(
            sources.runtimeExecutable,
            path.join(stagingRoot, "runtime/bun")
        ),
        copyMetadataFile(
            path.join(sources.repositoryRoot, ".bun-version"),
            sources.repositoryRoot,
            path.join(metadataRoot, ".bun-version")
        ),
        copyMetadataFile(
            path.join(sources.repositoryRoot, "bun.lock"),
            sources.repositoryRoot,
            path.join(metadataRoot, "bun.lock")
        ),
        copyMetadataFile(
            path.join(sources.repositoryRoot, "package.json"),
            sources.repositoryRoot,
            path.join(metadataRoot, "package.json")
        ),
    ]);
    await inventoryReleaseArtifactTree(stagingRoot);
}

/**
 * Removes owner write access from every staged file and directory.
 * @param repositoryRoot Canonical future-root checkout.
 * @param releaseRoot Verified repository-contained release tree.
 */
export async function makeReleaseTreeImmutable(
    repositoryRoot: string,
    releaseRoot: string
): Promise<void> {
    const { output } = resolveRepositoryBuildPath(
        repositoryRoot,
        releaseRoot,
        invalidReleaseStagingMessage
    );
    const before = await inventoryReleaseArtifactTree(output);
    const directories = new Set<string>([output]);
    for (const artifact of before) {
        await chmod(
            path.join(output, artifact.path),
            artifact.path === "runtime/bun" ? immutableExecutableMode : immutableFileMode
        );
        let directory = path.dirname(artifact.path);
        while (directory !== ".") {
            directories.add(path.join(output, directory));
            directory = path.dirname(directory);
        }
    }
    for (const directory of [...directories].toSorted(
        (left, right) => right.length - left.length
    )) {
        await chmod(directory, immutableDirectoryMode);
    }
    const after = await inventoryReleaseArtifactTree(output);
    if (!sameArtifactRecords(before, after)) throw invalidReleaseStaging();
}

/**
 * Atomically moves a frozen staging tree into its commit-addressed build slot.
 * @param repositoryRoot Canonical future-root checkout.
 * @param paths Exclusive staging and final paths created together.
 */
export async function promoteStagedRelease(
    repositoryRoot: string,
    paths: ReleaseStagingPaths
): Promise<void> {
    const staging = resolveRepositoryBuildPath(
        repositoryRoot,
        paths.stagingRoot,
        invalidReleaseStagingMessage
    ).output;
    const final = resolveRepositoryBuildPath(
        repositoryRoot,
        paths.finalRoot,
        invalidReleaseStagingMessage
    ).output;
    if (path.dirname(staging) !== path.dirname(final)) {
        throw invalidReleaseStaging();
    }
    await requireMissing(final);
    await rename(staging, final);
    if ((await realpath(final)) !== final) throw invalidReleaseStaging();
}

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
        throw invalidReleaseStaging();
    }
    await chmod(directory, privateDirectoryMode);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await restoreOwnerWrite(entryPath);
        } else if (entry.isFile()) {
            await chmod(entryPath, privateFileMode);
        } else {
            throw invalidReleaseStaging();
        }
    }
}

/**
 * Discards only an explicit repository-contained build tree, including a frozen candidate.
 * @param repositoryRoot Canonical future-root checkout.
 * @param releaseRoot Exact staging or final tree to remove.
 */
export async function discardReleaseTree(
    repositoryRoot: string,
    releaseRoot: string
): Promise<void> {
    const { output } = resolveRepositoryBuildPath(
        repositoryRoot,
        releaseRoot,
        invalidReleaseStagingMessage
    );
    try {
        await restoreOwnerWrite(output);
    } catch (error) {
        if (isMissingPath(error)) return;
        throw error;
    }
    await rm(output, { force: false, recursive: true });
}
