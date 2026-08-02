import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../../lib/errors.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { isMissingPathError, isPathExistsError } from "./globResolver.ts";

const logger = createStructuredLogger("log-rotation");

export interface VerifiedLogFile {
    handle: fs.FileHandle;
    stat: Stats;
}

export interface RotationResult {
    archivePath: string;
    compressed: boolean;
    warning?: string;
}

async function ignoreRejection(
    promise: Promise<unknown> | undefined
): Promise<void> {
    try {
        await promise;
    } catch {
        // Best-effort cleanup.
    }
}

async function ignoreMissingPath(
    promise: Promise<unknown>,
    onOtherError?: (error: unknown) => void
): Promise<void> {
    try {
        await promise;
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }
        if (onOtherError) {
            onOtherError(error);
            return;
        }
        throw error;
    }
}

function fileHandleReadableStream(
    handle: fs.FileHandle,
    size: number
): ReadableStream<Uint8Array> {
    let position = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (position >= size) {
                controller.close();
                return;
            }
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
            let bytesRead: number;
            try {
                ({ bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    position
                ));
            } catch (error) {
                controller.error(error);
                return;
            }
            if (bytesRead === 0) {
                controller.close();
                return;
            }
            position += bytesRead;
            controller.enqueue(buffer.subarray(0, bytesRead));
        },
    });
}

async function writeStreamToFileHandle(
    stream: ReadableStream<Uint8Array>,
    handle: fs.FileHandle
): Promise<void> {
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            let written = 0;
            while (written < value.byteLength) {
                const { bytesWritten } = await handle.write(
                    value,
                    written,
                    value.byteLength - written
                );
                written += bytesWritten;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

async function copyFileHandleBytes(
    source: fs.FileHandle,
    destination: fs.FileHandle,
    size: number
): Promise<void> {
    await writeStreamToFileHandle(fileHandleReadableStream(source, size), destination);
}

async function gzipFileHandleBytes(
    source: fs.FileHandle,
    destination: fs.FileHandle,
    size: number
): Promise<void> {
    const gzipStream = new CompressionStream(
        "gzip"
    ) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    await writeStreamToFileHandle(
        fileHandleReadableStream(source, size).pipeThrough(gzipStream),
        destination
    );
}

function isUnderRoot(filePath: string, root: string): boolean {
    const relative = path.relative(root, filePath);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

export async function assertSafePath(
    filePath: string,
    approvedRoots: string[]
): Promise<boolean> {
    let realFilePath: string;
    try {
        realFilePath = await fs.realpath(filePath);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
    const resolvedRoots = await Promise.all(
        approvedRoots.map(async (root) => {
            try {
                return await fs.realpath(root);
            } catch (error) {
                if (isMissingPathError(error)) {
                    return;
                }
                throw error;
            }
        })
    );
    const realRoots = resolvedRoots.filter((root): root is string => root !== undefined);
    if (realRoots.length === 0) {
        throw new Error(`No approved roots exist: ${approvedRoots.join(", ")}`);
    }
    if (realRoots.every((root) => !isUnderRoot(realFilePath, root))) {
        throw new Error(`Unsafe path outside approved roots: ${filePath}`);
    }
    const lstat = await fs.lstat(filePath);
    if (lstat.isSymbolicLink()) throw new Error(`Refusing symlink path: ${filePath}`);
    if (!lstat.isFile()) throw new Error(`Refusing non-file path: ${filePath}`);
    return true;
}

async function assertSafeNewFileParent(
    filePath: string,
    approvedRoots: string[]
): Promise<void> {
    const parent = await fs.realpath(path.dirname(filePath));
    const resolvedRoots = await Promise.all(
        approvedRoots.map(async (root) => {
            try {
                return await fs.realpath(root);
            } catch {
                return;
            }
        })
    );
    const realRoots = resolvedRoots.filter((root): root is string => root !== undefined);
    if (realRoots.length === 0) {
        throw new Error(`No approved roots exist: ${approvedRoots.join(", ")}`);
    }
    if (realRoots.every((root) => !isUnderRoot(parent, root))) {
        throw new Error(`Unsafe path outside approved roots: ${filePath}`);
    }
}

export async function openVerifiedLogFile(
    filePath: string,
    approvedRoots: string[]
): Promise<VerifiedLogFile> {
    return openVerifiedFile(filePath, approvedRoots, constants.O_RDWR);
}

async function openVerifiedFile(
    filePath: string,
    approvedRoots: string[],
    flags: number
): Promise<VerifiedLogFile> {
    const handle = await fs.open(filePath, flags | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
            throw new Error(`Refusing non-file path: ${filePath}`);
        }
        if (stat.nlink > 1) {
            throw new Error(`Refusing multi-linked file: ${filePath}`);
        }
        const realFilePath = await fs.realpath(filePath);
        const resolvedRoots = await Promise.all(
            approvedRoots.map(async (root) => {
                try {
                    return await fs.realpath(root);
                } catch {
                    return;
                }
            })
        );
        const realRoots = resolvedRoots.filter(
            (root): root is string => root !== undefined
        );
        if (realRoots.length === 0) {
            throw new Error(`No approved roots exist: ${approvedRoots.join(", ")}`);
        }
        if (realRoots.every((root) => !isUnderRoot(realFilePath, root))) {
            throw new Error(`Unsafe path outside approved roots: ${filePath}`);
        }
        await assertFileIdentity(filePath, stat, approvedRoots);
        return { handle, stat };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function assertFileIdentity(
    filePath: string,
    expected: { dev: number; ino: number },
    approvedRoots: string[]
): Promise<void> {
    const safe = await assertSafePath(filePath, approvedRoots);
    if (!safe) {
        throw new Error(`Unsafe path outside approved roots: ${filePath}`);
    }
    const currentStat = await fs.stat(filePath);
    if (expected.dev !== currentStat.dev || expected.ino !== currentStat.ino) {
        throw new Error(`Unsafe path changed before rotation: ${filePath}`);
    }
    if (currentStat.nlink > 1) {
        throw new Error(`Refusing multi-linked file: ${filePath}`);
    }
}

export async function unlinkVerified(
    filePath: string,
    approvedRoots: string[]
): Promise<void> {
    const file = await openVerifiedFile(filePath, approvedRoots, constants.O_RDONLY);
    const tombstonePath = `${filePath}.delete-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
    try {
        await assertFileIdentity(filePath, file.stat, approvedRoots);
        await assertSafeNewFileParent(tombstonePath, approvedRoots);
        await fs.rename(filePath, tombstonePath);
        await assertFileIdentity(tombstonePath, file.stat, approvedRoots);
        await fs.unlink(tombstonePath);
    } catch (error) {
        await ignoreRejection(fs.rename(tombstonePath, filePath));
        throw error;
    } finally {
        await file.handle.close();
    }
}

async function createNoFollowFile(
    filePath: string,
    mode: number,
    owner?: { uid: number; gid: number }
): Promise<fs.FileHandle> {
    const handle = await fs.open(
        filePath,
        constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
        mode
    );
    try {
        await handle.chmod(mode);
        if (owner) {
            const created = await handle.stat();
            if (created.uid !== owner.uid || created.gid !== owner.gid) {
                await handle.chown(owner.uid, owner.gid);
            }
        }
        return handle;
    } catch (error) {
        await ignoreRejection(handle.close());
        await ignoreRejection(fs.unlink(filePath));
        throw error;
    }
}

export async function gzipFile(
    filePath: string,
    approvedRoots: string[]
): Promise<string> {
    const source = await openVerifiedFile(filePath, approvedRoots, constants.O_RDONLY);
    const gzPath = `${filePath}.gz`;
    let destination: fs.FileHandle | undefined;
    let isSourceRemoved = false;
    try {
        await assertSafeNewFileParent(gzPath, approvedRoots);
        destination = await createNoFollowFile(gzPath, source.stat.mode & 0o777, {
            uid: source.stat.uid,
            gid: source.stat.gid,
        });
        await gzipFileHandleBytes(source.handle, destination, source.stat.size);
        await assertFileIdentity(filePath, source.stat, approvedRoots);
        const currentSourceStat = await source.handle.stat();
        if (currentSourceStat.size !== source.stat.size) {
            throw new Error("Source file changed during compression");
        }
        await fs.utimes(gzPath, source.stat.atime, source.stat.mtime);
        await destination.close();
        destination = undefined;
        await unlinkVerified(filePath, approvedRoots);
        isSourceRemoved = true;
        await source.handle.close();
        return gzPath;
    } catch (error) {
        await ignoreRejection(destination?.close());
        await ignoreRejection(source.handle.close());
        if (!isSourceRemoved && !isPathExistsError(error)) {
            await ignoreMissingPath(fs.unlink(gzPath));
        }
        throw error;
    }
}

export async function compressRotatedArchive(
    archivePath: string,
    shouldCompress: boolean,
    approvedRoots: string[]
): Promise<RotationResult> {
    if (!shouldCompress) {
        return { archivePath, compressed: false };
    }
    try {
        return {
            archivePath: await gzipFile(archivePath, approvedRoots),
            compressed: true,
        };
    } catch (error) {
        return {
            archivePath,
            compressed: false,
            warning: `Compression failed for ${archivePath}: ${errorMessage(
                error,
                "Log rotation failed"
            )}`,
        };
    }
}

export function archiveBasePath(filePath: string, now: Date): string {
    const stamp = now.toISOString().replaceAll(":", "-");
    return `${filePath}.${stamp}`;
}

export async function rotateCopyTruncate(
    filePath: string,
    file: VerifiedLogFile,
    archivePath: string,
    shouldCompress: boolean,
    approvedRoots: string[]
): Promise<RotationResult> {
    await assertSafeNewFileParent(archivePath, approvedRoots);
    const destination = await createNoFollowFile(
        archivePath,
        file.stat.mode & 0o777,
        { uid: file.stat.uid, gid: file.stat.gid }
    );
    let isCommitted = false;
    try {
        await copyFileHandleBytes(file.handle, destination, file.stat.size);
        await fs.utimes(archivePath, file.stat.atime, new Date());
        await destination.close();
        await assertFileIdentity(filePath, file.stat, approvedRoots);
        const currentStat = await file.handle.stat();
        if (currentStat.size !== file.stat.size) {
            throw new Error("Log file changed during rotation");
        }
        await file.handle.truncate(0);
        isCommitted = true;
        return compressRotatedArchive(archivePath, shouldCompress, approvedRoots);
    } catch (error) {
        if (!isCommitted) {
            await ignoreMissingPath(fs.unlink(archivePath), (unlinkError) => {
                logger.warn("log_rotation.incomplete_archive_remove_failed", {
                    error: unlinkError,
                });
            });
        }
        throw error;
    } finally {
        await ignoreRejection(destination.close());
    }
}

export async function rotateRename(
    filePath: string,
    file: VerifiedLogFile,
    archivePath: string,
    shouldCompress: boolean,
    approvedRoots: string[]
): Promise<RotationResult> {
    await assertFileIdentity(filePath, file.stat, approvedRoots);
    await fs.rename(filePath, archivePath);
    await fs.utimes(archivePath, file.stat.atime, new Date());
    try {
        const replacement = await createNoFollowFile(
            filePath,
            file.stat.mode & 0o777,
            { uid: file.stat.uid, gid: file.stat.gid }
        );
        await replacement.close();
    } catch (error) {
        if (isPathExistsError(error)) {
            return compressRotatedArchive(archivePath, shouldCompress, approvedRoots);
        }
        await ignoreRejection(fs.rename(archivePath, filePath));
        throw error;
    }
    return compressRotatedArchive(archivePath, shouldCompress, approvedRoots);
}
