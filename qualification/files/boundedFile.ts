import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface BoundedFileReadQualificationHooks {
    /** Holds the read after its initial descriptor stat for deterministic mutation tests. */
    readonly afterInitialStat?: () => Promise<void> | void;
}

function isContainedPath(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return (
        relative.length > 0 &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function invalidFileState(message: string): Error {
    return new Error(message);
}

function matchesSnapshot(before: BigIntStats, after: BigIntStats): boolean {
    return (
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.ctimeNs === before.ctimeNs &&
        after.mtimeNs === before.mtimeNs
    );
}

/**
 * Reads one stable regular file through a held nonblocking, no-follow descriptor.
 * A post-read no-follow path snapshot revalidates that the requested path still names
 * the same held descriptor snapshot before any bytes are returned.
 * @param absolutePath Absolute file path selected by the qualification caller.
 * @param allowedRoot Explicit root that is permitted to contain the descriptor target.
 * @param maximumBytes Maximum accepted file size.
 * @param invalidMessage Redacted failure message for every invalid file operation.
 * @param qualificationHooks Deterministic qualification-only read boundaries.
 * @returns Exact file bytes from the opened descriptor.
 */
export async function readBoundedRegularFile(
    absolutePath: string,
    allowedRoot: string,
    maximumBytes: number,
    invalidMessage: string,
    qualificationHooks: BoundedFileReadQualificationHooks = {}
): Promise<Buffer> {
    if (
        !path.isAbsolute(absolutePath) ||
        absolutePath.includes("\0") ||
        !path.isAbsolute(allowedRoot) ||
        allowedRoot.includes("\0") ||
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes <= 0 ||
        invalidMessage.length === 0 ||
        invalidMessage.includes("\0")
    ) {
        throw new TypeError(
            "Bounded file reads require absolute paths, a byte limit, and a failure message"
        );
    }

    const requestedRoot = path.resolve(allowedRoot);
    const requestedPath = path.resolve(absolutePath);
    if (!isContainedPath(requestedRoot, requestedPath)) {
        throw invalidFileState(invalidMessage);
    }

    let file: Awaited<ReturnType<typeof open>> | undefined;
    let result: Buffer | undefined;
    let failed = false;
    try {
        const canonicalRoot = await realpath(requestedRoot);
        file = await open(
            requestedPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const descriptorPath = await realpath(`/proc/self/fd/${file.fd}`);
        if (!isContainedPath(canonicalRoot, descriptorPath)) {
            throw invalidFileState(invalidMessage);
        }

        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes)) {
            throw invalidFileState(invalidMessage);
        }
        await qualificationHooks.afterInitialStat?.();

        const expectedBytes = Number(before.size);
        const buffer = Buffer.alloc(expectedBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
            const read = await file.read(
                buffer,
                bytesRead,
                buffer.byteLength - bytesRead,
                null
            );
            if (read.bytesRead === 0) break;
            bytesRead += read.bytesRead;
        }

        const after = await file.stat({ bigint: true });
        const pathState = await lstat(requestedPath, { bigint: true });
        if (
            bytesRead !== expectedBytes ||
            !matchesSnapshot(before, after) ||
            !pathState.isFile() ||
            !matchesSnapshot(before, pathState)
        ) {
            throw invalidFileState(invalidMessage);
        }
        result = buffer.subarray(0, bytesRead);
    } catch {
        failed = true;
    }

    if (file) {
        try {
            await file.close();
        } catch {
            failed = true;
        }
    }
    if (failed || !result) throw invalidFileState(invalidMessage);
    return result;
}

/**
 * Reads a stable bounded file and rejects malformed UTF-8 with a redacted error.
 * @param absolutePath Absolute file path selected by the qualification caller.
 * @param allowedRoot Explicit root permitted to contain the descriptor target.
 * @param maximumBytes Maximum accepted file size.
 * @param invalidStateMessage Redacted file-operation failure message.
 * @param invalidUtf8Message Redacted malformed-text failure message.
 * @returns Exact bytes and their strictly decoded UTF-8 text.
 */
export async function readBoundedUtf8RegularFile(
    absolutePath: string,
    allowedRoot: string,
    maximumBytes: number,
    invalidStateMessage: string,
    invalidUtf8Message: string
): Promise<{ bytes: Buffer; text: string }> {
    const bytes = await readBoundedRegularFile(
        absolutePath,
        allowedRoot,
        maximumBytes,
        invalidStateMessage
    );
    try {
        return {
            bytes,
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
    } catch {
        throw new Error(invalidUtf8Message);
    }
}
