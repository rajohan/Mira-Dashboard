import { createHash } from "node:crypto";
import Fs from "node:fs";
import Path from "node:path";

import { workspaceFileLimits } from "../../../contracts/files.ts";
import { WorkspaceFileError } from "../../domains/files/errors.ts";
import type {
    WorkspaceFileSpoolReceipt,
    WorkspaceFileUploadSpool,
} from "../../domains/files/ports.ts";

const spoolIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const spoolFilePattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.upload$/u;
const replaceIntentFilePattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.replace-intent$/u;
const replaceSettledFilePattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.replace-settled$/u;
const replaceIntentTemporaryFilePattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.replace-intent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const defaultMaximumCleanupEntries = 256;
const maximumCleanupEntries = 1024;
const maximumPreservedSpoolIds = 256;
const maximumSpoolEntries = 64;
const maximumSpoolBytes = 256 * 1024 * 1024;
const maximumIntentEntries = 256;
const maximumIntentBytes = 128 * 1024;
const maximumIntentTotalBytes = 8 * 1024 * 1024;
const maximumSpoolDirectoryEntries = 1024;
const defaultOrphanAgeMs = 2 * workspaceFileLimits.uploadTicketTtlMs;

export interface DescriptorWorkspaceFileUploadSpoolOptions {
    readonly nowMs?: () => number;
}

function runtimeOwnerId(): bigint {
    if (typeof process.getuid !== "function") {
        throw new TypeError("Workspace file spool requires a POSIX runtime owner");
    }
    return BigInt(process.getuid());
}

function isPrivateDirectory(stat: Fs.BigIntStats, ownerId: bigint): boolean {
    return stat.isDirectory() && stat.uid === ownerId && (stat.mode & 0o077n) === 0n;
}

function isPrivateSpoolFile(
    stat: Fs.BigIntStats,
    ownerId: bigint,
    rootDevice: bigint
): boolean {
    return (
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.uid === ownerId &&
        stat.dev === rootDevice &&
        (stat.mode & 0o077n) === 0n
    );
}

type WorkspaceFileSpoolArtifactKind =
    | "intent-pending"
    | "intent-settled"
    | "intent-temporary"
    | "upload";

function spoolArtifactKind(name: string): WorkspaceFileSpoolArtifactKind | undefined {
    if (spoolFilePattern.test(name)) return "upload";
    if (replaceIntentFilePattern.test(name)) return "intent-pending";
    if (replaceSettledFilePattern.test(name)) return "intent-settled";
    if (replaceIntentTemporaryFilePattern.test(name)) return "intent-temporary";
    return undefined;
}

function artifactSpoolId(name: string, kind: WorkspaceFileSpoolArtifactKind): string {
    if (kind === "upload") return name.slice(0, -".upload".length);
    return name.slice(0, 36);
}

function isPrivateIntentArtifact(
    stat: Fs.BigIntStats,
    ownerId: bigint,
    rootDevice: bigint,
    allowEmpty: boolean
): boolean {
    return (
        isPrivateSpoolFile(stat, ownerId, rootDevice) &&
        (stat.mode & 0o777n) === 0o600n &&
        stat.size <= BigInt(maximumIntentBytes) &&
        (allowEmpty || stat.size > 0n)
    );
}

function sameSpoolIdentity(left: Fs.BigIntStats, right: Fs.BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.uid === right.uid &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function initialSpoolAccounting(
    rootFd: number,
    ownerId: bigint,
    rootDevice: bigint
): Map<string, number> {
    const accounted = new Map<string, number>();
    let totalBytes = 0;
    let intentEntries = 0;
    let intentBytes = 0;
    let inspected = 0;
    const directory = Fs.opendirSync(`/proc/self/fd/${rootFd}`);
    try {
        while (true) {
            const entry = directory.readSync();
            if (entry === null) break;
            inspected += 1;
            if (inspected > maximumSpoolDirectoryEntries) {
                throw new TypeError(
                    "Workspace file spool directory capacity is exceeded"
                );
            }
            const kind = spoolArtifactKind(entry.name);
            if (kind === undefined) continue;
            const path = `/proc/self/fd/${rootFd}/${entry.name}`;
            const fd = Fs.openSync(
                path,
                Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
            );
            try {
                const stat = Fs.fstatSync(fd, { bigint: true });
                const sizeBytes = Number(stat.size);
                if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
                    throw new TypeError("Workspace file spool contents are invalid");
                }
                if (kind === "upload") {
                    if (
                        accounted.size >= maximumSpoolEntries ||
                        !isPrivateSpoolFile(stat, ownerId, rootDevice) ||
                        sizeBytes > workspaceFileLimits.maximumUploadBytes ||
                        totalBytes > maximumSpoolBytes - sizeBytes
                    ) {
                        throw new TypeError(
                            "Workspace file spool entry capacity is exceeded"
                        );
                    }
                    accounted.set(artifactSpoolId(entry.name, kind), sizeBytes);
                    totalBytes += sizeBytes;
                } else {
                    if (
                        intentEntries >= maximumIntentEntries ||
                        !isPrivateIntentArtifact(
                            stat,
                            ownerId,
                            rootDevice,
                            kind === "intent-temporary"
                        ) ||
                        intentBytes > maximumIntentTotalBytes - sizeBytes
                    ) {
                        throw new TypeError(
                            "Workspace file spool intent capacity is exceeded"
                        );
                    }
                    intentEntries += 1;
                    intentBytes += sizeBytes;
                }
            } finally {
                Fs.closeSync(fd);
            }
        }
    } finally {
        directory.closeSync();
    }
    return accounted;
}

function requiredSpoolRoot(value: string, ownerId: bigint): string {
    if (
        process.platform !== "linux" ||
        !Path.isAbsolute(value) ||
        value !== Path.normalize(value)
    ) {
        throw new TypeError("Workspace file spool root must be an absolute Linux path");
    }
    const resolved = Path.resolve(value);
    if (resolved === Path.parse(resolved).root) {
        throw new TypeError("Workspace file spool root cannot be a filesystem root");
    }
    const canonical = Fs.realpathSync(resolved);
    const status = Fs.lstatSync(resolved, { bigint: true });
    if (
        canonical !== resolved ||
        status.isSymbolicLink() ||
        !isPrivateDirectory(status, ownerId)
    ) {
        throw new TypeError(
            "Workspace file spool root must be canonical, private, and runtime-owned"
        );
    }
    return resolved;
}

function spoolName(spoolId: string): string {
    if (!spoolIdPattern.test(spoolId)) {
        throw new WorkspaceFileError("invalid-input");
    }
    return `${spoolId}.upload`;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw new DOMException("Workspace file upload was aborted", "AbortError");
    }
}

async function writeChunk(
    handle: Fs.promises.FileHandle,
    bytes: Uint8Array,
    position: number
): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            position + offset
        );
        if (bytesWritten < 1) throw new WorkspaceFileError("unavailable");
        offset += bytesWritten;
    }
}

/**
 * Creates a narrow web-owned spool beneath one pre-created project-local directory.
 * Names are server UUIDs only; no workspace locator or user filename reaches this adapter.
 * @param spoolRoot Canonical private directory owned by the web runtime.
 * @param options Injectable clock used only by bounded orphan reclamation.
 * @returns Descriptor-anchored upload spool with durable directory settlement.
 */
export function createDescriptorWorkspaceFileUploadSpool(
    spoolRoot: string,
    options: DescriptorWorkspaceFileUploadSpoolOptions = {}
): WorkspaceFileUploadSpool {
    const ownerId = runtimeOwnerId();
    const root = requiredSpoolRoot(spoolRoot, ownerId);
    const rootFd = Fs.openSync(
        root,
        Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW
    );
    const rootStat = Fs.fstatSync(rootFd, { bigint: true });
    if (!isPrivateDirectory(rootStat, ownerId)) {
        Fs.closeSync(rootFd);
        throw new TypeError("Workspace file spool root owner or mode is invalid");
    }
    let accounted: Map<string, number>;
    try {
        accounted = initialSpoolAccounting(rootFd, ownerId, rootStat.dev);
    } catch (error) {
        Fs.closeSync(rootFd);
        throw error;
    }
    const inFlight = new Set<string>();
    const nowMs = options.nowMs ?? Date.now;
    let disposed = false;
    const anchoredPath = (spoolId: string) =>
        `/proc/self/fd/${rootFd}/${spoolName(spoolId)}`;
    const requireAvailable = () => {
        if (disposed) throw new WorkspaceFileError("unavailable");
        const stat = Fs.fstatSync(rootFd, { bigint: true });
        if (
            stat.dev !== rootStat.dev ||
            stat.ino !== rootStat.ino ||
            !isPrivateDirectory(stat, ownerId)
        ) {
            throw new WorkspaceFileError("unavailable");
        }
    };
    const reconcileExternalDeletion = async () => {
        for (const [spoolId, expectedBytes] of accounted) {
            if (inFlight.has(spoolId)) continue;
            try {
                const stat = await Fs.promises.lstat(anchoredPath(spoolId), {
                    bigint: true,
                });
                if (
                    !isPrivateSpoolFile(stat, ownerId, rootStat.dev) ||
                    stat.size !== BigInt(expectedBytes)
                ) {
                    throw new WorkspaceFileError("unavailable");
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    accounted.delete(spoolId);
                    continue;
                }
                throw error instanceof WorkspaceFileError
                    ? error
                    : new WorkspaceFileError("unavailable", error);
            }
        }
    };
    const accountedBytes = () => {
        let total = 0;
        for (const sizeBytes of accounted.values()) total += sizeBytes;
        return total;
    };
    const spool: WorkspaceFileUploadSpool & { readonly dispose: () => void } = {
        async cleanupOrphans(input = {}) {
            requireAvailable();
            const limit = input.maximumEntries ?? defaultMaximumCleanupEntries;
            const olderThanMs = input.olderThanMs ?? defaultOrphanAgeMs;
            const preserved = new Set(input.preserveSpoolIds);
            if (
                !Number.isSafeInteger(limit) ||
                limit < 1 ||
                limit > maximumCleanupEntries ||
                !Number.isSafeInteger(olderThanMs) ||
                olderThanMs < workspaceFileLimits.uploadTicketTtlMs ||
                preserved.size > maximumPreservedSpoolIds ||
                [...preserved].some((spoolId) => !spoolIdPattern.test(spoolId))
            ) {
                throw new WorkspaceFileError("invalid-input");
            }
            const now = nowMs();
            if (!Number.isSafeInteger(now) || now < 0) {
                throw new WorkspaceFileError("unavailable");
            }
            const directory = await Fs.promises.opendir(`/proc/self/fd/${rootFd}`);
            let inspected = 0;
            let truncated = false;
            const candidates: Array<{
                readonly kind: WorkspaceFileSpoolArtifactKind;
                readonly name: string;
                readonly spoolId: string;
                readonly stat: Fs.BigIntStats;
            }> = [];
            try {
                for await (const entry of directory) {
                    if (inspected >= limit) {
                        truncated = true;
                        break;
                    }
                    inspected += 1;
                    const kind = spoolArtifactKind(entry.name);
                    if (kind === undefined) continue;
                    const spoolId = artifactSpoolId(entry.name, kind);
                    if (preserved.has(spoolId)) continue;
                    if (kind === "intent-pending") continue;
                    let handle: Fs.promises.FileHandle | undefined;
                    try {
                        const candidatePath = `/proc/self/fd/${rootFd}/${entry.name}`;
                        handle = await Fs.promises.open(
                            candidatePath,
                            Fs.constants.O_RDONLY |
                                Fs.constants.O_NOFOLLOW |
                                Fs.constants.O_NONBLOCK
                        );
                        const stat = await handle.stat({ bigint: true });
                        const modifiedAtMs = Number(stat.mtimeNs / 1_000_000n);
                        if (
                            (kind === "upload"
                                ? !isPrivateSpoolFile(stat, ownerId, rootStat.dev)
                                : !isPrivateIntentArtifact(
                                      stat,
                                      ownerId,
                                      rootStat.dev,
                                      kind === "intent-temporary"
                                  )) ||
                            !Number.isSafeInteger(modifiedAtMs) ||
                            modifiedAtMs > now - olderThanMs
                        ) {
                            continue;
                        }
                        candidates.push({ kind, name: entry.name, spoolId, stat });
                    } catch (error) {
                        const code = (error as NodeJS.ErrnoException).code;
                        if (code !== "ENOENT" && code !== "ELOOP") {
                            throw new WorkspaceFileError("unavailable", error);
                        }
                    } finally {
                        await handle?.close();
                    }
                }
            } finally {
                await directory.close().catch(() => {});
            }
            let removed = 0;
            for (const candidate of candidates) {
                const candidatePath = `/proc/self/fd/${rootFd}/${candidate.name}`;
                let handle: Fs.promises.FileHandle | undefined;
                try {
                    handle = await Fs.promises.open(
                        candidatePath,
                        Fs.constants.O_RDONLY |
                            Fs.constants.O_NOFOLLOW |
                            Fs.constants.O_NONBLOCK
                    );
                    const current = await handle.stat({ bigint: true });
                    if (
                        !sameSpoolIdentity(current, candidate.stat) ||
                        (candidate.kind === "upload"
                            ? !isPrivateSpoolFile(current, ownerId, rootStat.dev)
                            : !isPrivateIntentArtifact(
                                  current,
                                  ownerId,
                                  rootStat.dev,
                                  candidate.kind === "intent-temporary"
                              ))
                    ) {
                        continue;
                    }
                    await Fs.promises.unlink(candidatePath);
                    if (candidate.kind === "upload") {
                        accounted.delete(candidate.spoolId);
                    }
                    removed += 1;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code !== "ENOENT" && code !== "ELOOP") {
                        throw new WorkspaceFileError("unavailable", error);
                    }
                } finally {
                    await handle?.close();
                }
            }
            if (removed > 0) Fs.fsyncSync(rootFd);
            return { inspected, removed, truncated };
        },
        async discard(spoolId) {
            requireAvailable();
            try {
                await Fs.promises.unlink(anchoredPath(spoolId));
                accounted.delete(spoolId);
                Fs.fsyncSync(rootFd);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw new WorkspaceFileError("unavailable", error);
                }
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            Fs.closeSync(rootFd);
        },
        async receive(input): Promise<WorkspaceFileSpoolReceipt> {
            requireAvailable();
            if (
                !Number.isSafeInteger(input.expectedBytes) ||
                input.expectedBytes < 0 ||
                input.expectedBytes > workspaceFileLimits.maximumUploadBytes
            ) {
                throw new WorkspaceFileError("too-large");
            }
            abortIfRequested(input.signal);
            spoolName(input.spoolId);
            await reconcileExternalDeletion();
            if (
                accounted.has(input.spoolId) ||
                accounted.size >= maximumSpoolEntries ||
                accountedBytes() > maximumSpoolBytes - input.expectedBytes
            ) {
                throw new WorkspaceFileError(
                    accounted.has(input.spoolId) ? "conflict" : "capacity"
                );
            }
            accounted.set(input.spoolId, input.expectedBytes);
            inFlight.add(input.spoolId);
            let handle: Fs.promises.FileHandle | undefined;
            let completed = false;
            try {
                handle = await Fs.promises.open(
                    anchoredPath(input.spoolId),
                    Fs.constants.O_WRONLY |
                        Fs.constants.O_CREAT |
                        Fs.constants.O_EXCL |
                        Fs.constants.O_NOFOLLOW,
                    0o600
                );
                const digest = createHash("sha256");
                const reader = input.body.getReader();
                let sizeBytes = 0;
                try {
                    while (true) {
                        abortIfRequested(input.signal);
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        const bytes = chunk.value;
                        if (
                            sizeBytes > input.expectedBytes - bytes.byteLength ||
                            sizeBytes >
                                workspaceFileLimits.maximumUploadBytes - bytes.byteLength
                        ) {
                            throw new WorkspaceFileError("too-large");
                        }
                        await writeChunk(handle, bytes, sizeBytes);
                        digest.update(bytes);
                        sizeBytes += bytes.byteLength;
                    }
                } finally {
                    reader.releaseLock();
                }
                if (sizeBytes !== input.expectedBytes) {
                    throw new WorkspaceFileError("invalid-input");
                }
                const stat = await handle.stat({ bigint: true });
                if (
                    !isPrivateSpoolFile(stat, ownerId, rootStat.dev) ||
                    stat.size !== BigInt(sizeBytes) ||
                    (stat.mode & 0o777n) !== 0o600n
                ) {
                    throw new WorkspaceFileError("access-denied");
                }
                await handle.sync();
                Fs.fsyncSync(rootFd);
                completed = true;
                return {
                    sha256: digest.digest("hex"),
                    sizeBytes,
                    spoolId: input.spoolId,
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                    throw new WorkspaceFileError("conflict", error);
                }
                throw error instanceof WorkspaceFileError
                    ? error
                    : new WorkspaceFileError("unavailable", error);
            } finally {
                await handle?.close();
                if (!completed) {
                    await Fs.promises.unlink(anchoredPath(input.spoolId)).catch(() => {});
                    accounted.delete(input.spoolId);
                }
                inFlight.delete(input.spoolId);
            }
        },
    };
    return Object.freeze(spool);
}
