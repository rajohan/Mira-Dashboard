import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { readBoundedRegularFile } from "../files/boundedFile.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import {
    loadPublishedProductionRelease,
    type PublishedProductionRelease,
} from "./productionReleasePublication.ts";
import { productionSystemdUnits } from "./productionSystemdUnitPolicy.ts";

const verificationFailureMessage = "Production systemd authority verification failed";
const maximumUnitBytes = 64 * 1024;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Test-only root identity and destination substitution. */
export interface ProductionSystemdAuthorityVerificationOptions {
    readonly expectedGroupId?: number;
    readonly expectedUserId?: number;
    readonly rootUnitDirectory?: string;
}

function verificationFailure(): Error {
    return new Error(verificationFailureMessage);
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.ctimeNs === right.ctimeNs &&
        left.mtimeNs === right.mtimeNs
    );
}

async function close(handle: FileHandle | undefined): Promise<boolean> {
    if (!handle) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

async function readInstalledUnit(
    unitDirectory: string,
    fileName: string,
    expectedUserId: number,
    expectedGroupId: number
): Promise<Uint8Array> {
    const unitPath = path.join(unitDirectory, fileName);
    let handle: FileHandle | undefined;
    let bytes: Uint8Array | undefined;
    let failed = false;
    try {
        handle = await open(unitPath, fileFlags);
        const [held, atPath, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(unitPath, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== unitPath ||
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== BigInt(expectedUserId) ||
            held.gid !== BigInt(expectedGroupId) ||
            (held.mode & 0o7777n) !== 0o644n ||
            held.size < 1n ||
            held.size > BigInt(maximumUnitBytes) ||
            !sameFile(held, atPath)
        ) {
            throw verificationFailure();
        }
        const output = Buffer.alloc(Number(held.size) + 1);
        let offset = 0;
        while (offset < output.byteLength) {
            const read = await handle.read(
                output,
                offset,
                output.byteLength - offset,
                offset
            );
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
        }
        const [after, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(unitPath, { bigint: true }),
        ]);
        if (
            offset !== Number(held.size) ||
            !sameFile(held, after) ||
            !sameFile(held, pathAfter)
        ) {
            throw verificationFailure();
        }
        bytes = output.subarray(0, offset);
    } catch {
        failed = true;
    }
    if (!(await close(handle))) failed = true;
    if (failed || !bytes) throw verificationFailure();
    return bytes;
}

function sameRelease(
    left: PublishedProductionRelease,
    right: PublishedProductionRelease
): boolean {
    return (
        left.releaseRoot === right.releaseRoot &&
        JSON.stringify(left.manifest) === JSON.stringify(right.manifest)
    );
}

/**
 * Proves that root systemd still holds the exact two manifest-bound units for the
 * release about to be activated. This boundary performs no install, reload, or mutation.
 */
export async function verifyPublishedProductionSystemdUnitsInstalledAtRoot(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    release: PublishedProductionRelease,
    options: ProductionSystemdAuthorityVerificationOptions = {}
): Promise<void> {
    const unitDirectory = options.rootUnitDirectory ?? "/etc/systemd/system";
    const expectedUserId = options.expectedUserId ?? 0;
    const expectedGroupId = options.expectedGroupId ?? 0;
    let directory: FileHandle | undefined;
    let failed = false;
    try {
        if (
            lease.stateDirectory !== paths.stateDirectory ||
            !path.isAbsolute(unitDirectory) ||
            path.resolve(unitDirectory) !== unitDirectory ||
            path.parse(unitDirectory).root === unitDirectory ||
            unitDirectory.includes("\0")
        ) {
            throw verificationFailure();
        }
        const verifiedRelease = await loadPublishedProductionRelease(
            paths,
            release.manifest.source.commitSha,
            release.manifest.runtime.revision
        );
        if (!sameRelease(release, verifiedRelease)) throw verificationFailure();

        directory = await open(unitDirectory, directoryFlags);
        const [heldDirectory, atPathDirectory, canonicalDirectory] = await Promise.all([
            directory.stat({ bigint: true }),
            lstat(unitDirectory, { bigint: true }),
            realpath(`/proc/self/fd/${directory.fd}`),
        ]);
        if (
            canonicalDirectory !== unitDirectory ||
            !heldDirectory.isDirectory() ||
            heldDirectory.isSymbolicLink() ||
            heldDirectory.uid !== BigInt(expectedUserId) ||
            heldDirectory.gid !== BigInt(expectedGroupId) ||
            (heldDirectory.mode & 0o022n) !== 0n ||
            heldDirectory.dev !== atPathDirectory.dev ||
            heldDirectory.ino !== atPathDirectory.ino
        ) {
            throw verificationFailure();
        }

        for (const policy of productionSystemdUnits) {
            const artifact = verifiedRelease.manifest.artifacts.find(
                ({ path: artifactPath }) => artifactPath === policy.artifactPath
            );
            if (!artifact || artifact.bytes > maximumUnitBytes) {
                throw verificationFailure();
            }
            const [source, installed] = await Promise.all([
                readBoundedRegularFile(
                    path.join(verifiedRelease.releaseRoot, policy.artifactPath),
                    verifiedRelease.releaseRoot,
                    maximumUnitBytes,
                    verificationFailureMessage
                ),
                readInstalledUnit(
                    unitDirectory,
                    policy.fileName,
                    expectedUserId,
                    expectedGroupId
                ),
            ]);
            if (
                source.byteLength !== artifact.bytes ||
                sha256(source) !== artifact.sha256 ||
                !source.equals(installed)
            ) {
                throw verificationFailure();
            }
        }

        const directoryAfter = await directory.stat({ bigint: true });
        const releaseAfter = await loadPublishedProductionRelease(
            paths,
            release.manifest.source.commitSha,
            release.manifest.runtime.revision
        );
        if (
            directoryAfter.dev !== heldDirectory.dev ||
            directoryAfter.ino !== heldDirectory.ino ||
            !sameRelease(verifiedRelease, releaseAfter)
        ) {
            throw verificationFailure();
        }
    } catch {
        failed = true;
    }
    if (!(await close(directory))) failed = true;
    if (failed) throw verificationFailure();
}
