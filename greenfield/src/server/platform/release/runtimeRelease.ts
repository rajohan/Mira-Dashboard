import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
    parseReleaseManifest,
    type ReleaseManifest,
} from "../../../shared/releaseManifest.ts";
import {
    readRuntimeIdentity,
    type ObservedRuntimeIdentity,
} from "../runtime/readRuntimeIdentity.ts";

const manifestFileName = "release-manifest.json";
const maximumManifestBytes = 4 * 1024 * 1024;
const manifestOpenFlags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const writePermissionBits = 0o222n;

/** Verified immutable release identity consumed by one process composition root. */
export interface RuntimeRelease {
    readonly manifest: ReleaseManifest;
    readonly releaseRoot: string;
}

/** Deterministic read boundary exposed only to adversarial tests. */
export interface RuntimeReleaseTestHooks {
    readonly afterManifestRead?: () => Promise<void> | void;
}

function invalidRuntimeRelease(): Error {
    return new Error("Runtime release is invalid");
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw invalidRuntimeRelease();
    }
    return process.getuid();
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.ctimeNs === right.ctimeNs &&
        left.mtimeNs === right.mtimeNs
    );
}

function validReleaseDirectory(status: BigIntStats, userId: number): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & writePermissionBits) === 0n
    );
}

function validReleasesDirectory(status: BigIntStats, userId: number): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & 0o022n) === 0n
    );
}

async function closeFile(file: FileHandle | undefined): Promise<boolean> {
    if (!file) return true;
    try {
        await file.close();
        return true;
    } catch {
        return false;
    }
}

async function readStableManifest(
    releaseRoot: string,
    releaseStatus: BigIntStats,
    userId: number,
    testHooks: RuntimeReleaseTestHooks
): Promise<string> {
    const manifestPath = path.join(releaseRoot, manifestFileName);
    let file: FileHandle | undefined;
    let text: string | undefined;
    let failed = false;
    try {
        const before = await lstat(manifestPath, { bigint: true });
        file = await open(manifestPath, manifestOpenFlags);
        const held = await file.stat({ bigint: true });
        const descriptorPath = await realpath(`/proc/self/fd/${file.fd}`);
        if (
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== BigInt(userId) ||
            held.dev !== releaseStatus.dev ||
            held.size <= 0n ||
            held.size > BigInt(maximumManifestBytes) ||
            (held.mode & writePermissionBits) !== 0n ||
            path.dirname(descriptorPath) !== releaseRoot ||
            path.basename(descriptorPath) !== manifestFileName ||
            !sameSnapshot(held, before)
        ) {
            throw invalidRuntimeRelease();
        }

        const expectedBytes = Number(held.size);
        const contents = Buffer.alloc(expectedBytes + 1);
        let bytesRead = 0;
        while (bytesRead < contents.byteLength) {
            const read = await file.read(
                contents,
                bytesRead,
                contents.byteLength - bytesRead,
                bytesRead
            );
            if (read.bytesRead === 0) break;
            bytesRead += read.bytesRead;
        }
        await testHooks.afterManifestRead?.();
        const [after, pathAfter, releaseAfter] = await Promise.all([
            file.stat({ bigint: true }),
            lstat(manifestPath, { bigint: true }),
            lstat(releaseRoot, { bigint: true }),
        ]);
        if (
            bytesRead !== expectedBytes ||
            !sameSnapshot(held, after) ||
            !sameSnapshot(held, pathAfter) ||
            !sameSnapshot(releaseStatus, releaseAfter)
        ) {
            throw invalidRuntimeRelease();
        }
        text = new TextDecoder("utf-8", { fatal: true }).decode(
            contents.subarray(0, bytesRead)
        );
    } catch {
        failed = true;
    }
    if (!(await closeFile(file))) failed = true;
    if (failed || text === undefined) throw invalidRuntimeRelease();
    return text;
}

/**
 * Reads one immutable release manifest through a held no-follow descriptor.
 * @param releasesDirectory Canonical project-local production releases directory.
 * @param releaseRoot Canonical exact release directory, never the `current` symlink.
 * @param processRole Process role that must be represented by the manifest.
 * @param observedRuntime Optional deterministic runtime identity for tests.
 * @param testHooks Deterministic adversarial hooks used only by tests.
 * @returns Frozen verified runtime release.
 */
export async function loadRuntimeRelease(
    releasesDirectory: string,
    releaseRoot: string,
    processRole: "web" | "worker",
    observedRuntime?: ObservedRuntimeIdentity,
    testHooks: RuntimeReleaseTestHooks = {}
): Promise<RuntimeRelease> {
    if (
        !path.isAbsolute(releasesDirectory) ||
        !path.isAbsolute(releaseRoot) ||
        releasesDirectory.includes("\0") ||
        releaseRoot.includes("\0") ||
        path.resolve(releasesDirectory) !== releasesDirectory ||
        path.resolve(releaseRoot) !== releaseRoot ||
        path.dirname(releaseRoot) !== releasesDirectory
    ) {
        throw invalidRuntimeRelease();
    }
    try {
        const userId = currentUserId();
        const [canonicalReleases, canonicalRelease, releasesStatus, releaseStatus] =
            await Promise.all([
                realpath(releasesDirectory),
                realpath(releaseRoot),
                lstat(releasesDirectory, { bigint: true }),
                lstat(releaseRoot, { bigint: true }),
            ]);
        if (
            canonicalReleases !== releasesDirectory ||
            canonicalRelease !== releaseRoot ||
            !validReleasesDirectory(releasesStatus, userId) ||
            !validReleaseDirectory(releaseStatus, userId) ||
            releaseStatus.dev !== releasesStatus.dev
        ) {
            throw invalidRuntimeRelease();
        }
        const manifestText = await readStableManifest(
            releaseRoot,
            releaseStatus,
            userId,
            testHooks
        );
        let manifestValue: unknown;
        try {
            manifestValue = JSON.parse(manifestText) as unknown;
        } catch {
            throw invalidRuntimeRelease();
        }
        const manifest = parseReleaseManifest(manifestValue);
        const runtime = readRuntimeIdentity(observedRuntime);
        if (
            path.basename(releaseRoot) !== manifest.source.commitSha ||
            manifest.runtime.version !== runtime.version ||
            manifest.runtime.revision !== runtime.revision ||
            !manifest.processRoles.includes(processRole)
        ) {
            throw invalidRuntimeRelease();
        }
        return Object.freeze({ manifest, releaseRoot });
    } catch {
        throw invalidRuntimeRelease();
    }
}
