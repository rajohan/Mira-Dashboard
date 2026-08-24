import type { BigIntStats, Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { readBoundedRegularFile } from "../files/boundedFile.ts";

const invalidArtifactTreeMessage = "Release artifact tree is invalid";
export const maximumReleaseArtifactBytes = 64 * 1024 * 1024;
export const maximumReleaseRuntimeBytes = 256 * 1024 * 1024;
const maximumArtifactCount = 4096;
const maximumArtifactDirectoryCount = 512;
const maximumArtifactDepth = 16;
const maximumArtifactTreeBytes = 512 * 1024 * 1024;
const artifactPathSegmentPattern = /^[A-Za-z0-9.@_+-]+$/u;

function compareCanonicalText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/** Immutable content identity for one regular file in a staged release. */
export interface ReleaseArtifactInventoryRecord {
    readonly bytes: number;
    readonly path: string;
    readonly sha256: string;
}

/** Deterministic mutation boundary used only by adversarial tests. */
export interface ReleaseArtifactInventoryTestHooks {
    readonly afterFileRead?: (relativePath: string) => Promise<void> | void;
}

interface DirectorySnapshot {
    readonly entries: readonly string[];
    readonly status: BigIntStats;
}

function invalidArtifactTree(): Error {
    return new Error(invalidArtifactTreeMessage);
}

function matchesDirectorySnapshot(before: BigIntStats, after: BigIntStats): boolean {
    return (
        after.isDirectory() &&
        !after.isSymbolicLink() &&
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.ctimeNs === before.ctimeNs &&
        after.mtimeNs === before.mtimeNs
    );
}

function matchesFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
    return (
        after.isFile() &&
        !after.isSymbolicLink() &&
        after.nlink === 1n &&
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.ctimeNs === before.ctimeNs &&
        after.mtimeNs === before.mtimeNs
    );
}

function entrySignature(entry: Dirent): string {
    if (entry.isDirectory()) return `d:${entry.name}`;
    if (entry.isFile()) return `f:${entry.name}`;
    return `x:${entry.name}`;
}

async function directorySnapshot(directory: string): Promise<DirectorySnapshot> {
    const status = await lstat(directory, { bigint: true });
    if (!status.isDirectory() || status.isSymbolicLink()) {
        throw invalidArtifactTree();
    }
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    const entries = directoryEntries
        .map((entry) => entrySignature(entry))
        .toSorted((left, right) => compareCanonicalText(left, right));
    return { entries, status };
}

function validPathSegment(segment: string): boolean {
    return (
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        artifactPathSegmentPattern.test(segment)
    );
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Inventories a canonical, stable release tree without following symbolic links.
 * Every regular file must be nonempty, single-linked, bounded, and unchanged across read.
 * @param releaseRoot Canonical absolute staged-release root.
 * @param testHooks Deterministic adversarial hooks used only by tests.
 * @returns Strictly path-sorted file identities.
 */
export async function inventoryReleaseArtifactTree(
    releaseRoot: string,
    testHooks: ReleaseArtifactInventoryTestHooks = {}
): Promise<readonly ReleaseArtifactInventoryRecord[]> {
    if (
        !path.isAbsolute(releaseRoot) ||
        releaseRoot.includes("\0") ||
        path.resolve(releaseRoot) !== releaseRoot ||
        path.parse(releaseRoot).root === releaseRoot
    ) {
        throw new TypeError(invalidArtifactTreeMessage);
    }

    try {
        const canonicalRoot = await realpath(releaseRoot);
        if (canonicalRoot !== releaseRoot) throw invalidArtifactTree();
        const rootSnapshot = await directorySnapshot(releaseRoot);
        const records: ReleaseArtifactInventoryRecord[] = [];
        let directoryCount = 0;
        let totalBytes = 0;

        const visit = async (relativeDirectory: string, depth: number): Promise<void> => {
            if (depth > maximumArtifactDepth) throw invalidArtifactTree();
            directoryCount += 1;
            if (directoryCount > maximumArtifactDirectoryCount) {
                throw invalidArtifactTree();
            }
            const absoluteDirectory =
                relativeDirectory.length === 0
                    ? releaseRoot
                    : path.join(releaseRoot, relativeDirectory);
            const before = await directorySnapshot(absoluteDirectory);
            if (before.status.dev !== rootSnapshot.status.dev) {
                throw invalidArtifactTree();
            }

            const entries = await readdir(absoluteDirectory, { withFileTypes: true });
            for (const entry of entries.toSorted((left, right) =>
                compareCanonicalText(left.name, right.name)
            )) {
                if (!validPathSegment(entry.name)) throw invalidArtifactTree();
                const relativePath =
                    relativeDirectory.length === 0
                        ? entry.name
                        : `${relativeDirectory}/${entry.name}`;
                const absolutePath = path.join(releaseRoot, relativePath);
                if (entry.isDirectory()) {
                    await visit(relativePath, depth + 1);
                    continue;
                }
                if (!entry.isFile() || records.length >= maximumArtifactCount) {
                    throw invalidArtifactTree();
                }

                const beforeRead = await lstat(absolutePath, { bigint: true });
                const maximumBytes =
                    relativePath === "runtime/bun"
                        ? maximumReleaseRuntimeBytes
                        : maximumReleaseArtifactBytes;
                if (
                    !beforeRead.isFile() ||
                    beforeRead.isSymbolicLink() ||
                    beforeRead.nlink !== 1n ||
                    beforeRead.dev !== rootSnapshot.status.dev ||
                    beforeRead.size <= 0n ||
                    beforeRead.size > BigInt(maximumBytes)
                ) {
                    throw invalidArtifactTree();
                }
                const contents = await readBoundedRegularFile(
                    absolutePath,
                    releaseRoot,
                    maximumBytes,
                    invalidArtifactTreeMessage
                );
                await testHooks.afterFileRead?.(relativePath);
                const afterRead = await lstat(absolutePath, { bigint: true });
                if (!matchesFileSnapshot(beforeRead, afterRead)) {
                    throw invalidArtifactTree();
                }
                totalBytes += contents.byteLength;
                if (totalBytes > maximumArtifactTreeBytes) throw invalidArtifactTree();
                records.push(
                    Object.freeze({
                        bytes: contents.byteLength,
                        path: relativePath,
                        sha256: sha256(contents),
                    })
                );
            }

            const after = await directorySnapshot(absoluteDirectory);
            if (
                !matchesDirectorySnapshot(before.status, after.status) ||
                before.entries.length !== after.entries.length ||
                before.entries.some((entry, index) => entry !== after.entries[index])
            ) {
                throw invalidArtifactTree();
            }
        };

        await visit("", 0);
        const finalRoot = await directorySnapshot(releaseRoot);
        if (
            !matchesDirectorySnapshot(rootSnapshot.status, finalRoot.status) ||
            rootSnapshot.entries.length !== finalRoot.entries.length ||
            rootSnapshot.entries.some(
                (entry, index) => entry !== finalRoot.entries[index]
            )
        ) {
            throw invalidArtifactTree();
        }
        if (records.length === 0) throw invalidArtifactTree();
        return Object.freeze(
            records.toSorted((left, right) => compareCanonicalText(left.path, right.path))
        );
    } catch (error) {
        if (error instanceof TypeError && error.message === invalidArtifactTreeMessage) {
            throw error;
        }
        throw invalidArtifactTree();
    }
}
