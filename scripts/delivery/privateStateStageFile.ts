import { constants, type BigIntStats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

const privateFileMode = 0o600n;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface RemoveStalePrivateStateStageOptions {
    readonly directoryHandle: FileHandle;
    readonly expectedDevice: bigint;
    readonly maximumBytes: number;
    readonly stageName: string;
}

function cleanupFailure(): Error {
    return new Error("Private state stage cleanup failed");
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function validStageFile(
    status: BigIntStats,
    expectedDevice: bigint,
    maximumBytes: number
): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === expectedDevice &&
        (status.mode & 0o7777n) === privateFileMode &&
        status.size >= 0n &&
        status.size <= BigInt(maximumBytes)
    );
}

async function closeHandle(handle: FileHandle | undefined): Promise<boolean> {
    if (!handle) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

async function requireMissing(candidate: string): Promise<void> {
    try {
        await lstat(candidate);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw cleanupFailure();
    }
    throw cleanupFailure();
}

/**
 * Removes only a private, descriptor-bound stage file left by an interrupted atomic replace.
 * @param options Held state-directory identity and the exact deterministic stage name.
 */
export async function removeStalePrivateStateStage(
    options: RemoveStalePrivateStateStageOptions
): Promise<void> {
    const { directoryHandle, expectedDevice, maximumBytes, stageName } = options;
    if (
        process.platform !== "linux" ||
        maximumBytes <= 0 ||
        stageName.length === 0 ||
        stageName.length > 255 ||
        stageName.includes("\0") ||
        path.basename(stageName) !== stageName ||
        stageName === "." ||
        stageName === ".."
    ) {
        throw cleanupFailure();
    }
    const stageFile = path.join(`/proc/self/fd/${directoryHandle.fd}`, stageName);
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        try {
            handle = await open(stageFile, readFlags);
        } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw cleanupFailure();
        }
        const [held, current] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(stageFile, { bigint: true }),
        ]);
        if (
            !validStageFile(held, expectedDevice, maximumBytes) ||
            !validStageFile(current, expectedDevice, maximumBytes) ||
            held.dev !== current.dev ||
            held.ino !== current.ino ||
            held.size !== current.size
        ) {
            throw cleanupFailure();
        }
        await unlink(stageFile);
        await directoryHandle.sync();
        const unlinked = await handle.stat({ bigint: true });
        if (
            unlinked.dev !== held.dev ||
            unlinked.ino !== held.ino ||
            unlinked.nlink !== 0n ||
            unlinked.uid !== held.uid ||
            unlinked.size !== held.size
        ) {
            throw cleanupFailure();
        }
        await requireMissing(stageFile);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw cleanupFailure();
}
