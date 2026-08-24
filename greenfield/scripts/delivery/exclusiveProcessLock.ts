import { constants, type BigIntStats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

const maximumProcessLockBytes = 512;
const processLockInitializationGraceMs = 5000;
const lockOpenFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const lockReadFlags = constants.O_NOFOLLOW | constants.O_RDONLY;
const processLockOwnerSchema = v.strictObject({
    pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
    token: v.pipe(v.string(), v.uuid()),
});

/** Bounded cross-process lock policy for one already protected parent directory. */
export interface ExclusiveProcessLockOptions {
    readonly deadlineMs: number;
    readonly failureMessage: string;
    readonly lockPath: string;
    readonly retryMs: number;
}

interface ProcessLockSnapshot {
    readonly ctimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
}

interface OwnedProcessLock {
    readonly path: string;
    readonly snapshot: ProcessLockSnapshot;
}

function processLockFailure(message: string): Error {
    return new Error(message);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function validateOptions(options: ExclusiveProcessLockOptions): void {
    if (
        !path.isAbsolute(options.lockPath) ||
        options.lockPath.includes("\0") ||
        path.resolve(options.lockPath) !== options.lockPath ||
        path.parse(options.lockPath).root === options.lockPath ||
        !Number.isSafeInteger(options.deadlineMs) ||
        options.deadlineMs <= 0 ||
        !Number.isSafeInteger(options.retryMs) ||
        options.retryMs <= 0 ||
        options.retryMs > options.deadlineMs ||
        options.failureMessage.length === 0
    ) {
        throw processLockFailure(options.failureMessage);
    }
}

function snapshot(status: BigIntStats, failureMessage: string): ProcessLockSnapshot {
    if (
        typeof process.getuid !== "function" ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o022n) !== 0n ||
        status.size <= 0n ||
        status.size > BigInt(maximumProcessLockBytes)
    ) {
        throw processLockFailure(failureMessage);
    }
    return Object.freeze({
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        size: status.size,
    });
}

function sameSnapshot(
    expected: ProcessLockSnapshot,
    actual: ProcessLockSnapshot
): boolean {
    return (
        expected.ctimeNs === actual.ctimeNs &&
        expected.dev === actual.dev &&
        expected.ino === actual.ino &&
        expected.size === actual.size
    );
}

async function processLockMayStillBeInitializing(
    lockPath: string,
    failureMessage: string,
    contents: string | undefined
): Promise<boolean> {
    // O_EXCL publishes the pathname before the owner can finish its bounded record.
    // A newline terminates every complete record, so completed malformed data must
    // fail immediately while only a secure incomplete publication receives grace.
    if (contents?.endsWith("\n")) return false;
    let status: BigIntStats;
    try {
        status = await lstat(lockPath, { bigint: true });
    } catch (error) {
        if (errorCode(error) === "ENOENT") return true;
        throw processLockFailure(failureMessage);
    }
    if (
        typeof process.getuid !== "function" ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o022n) !== 0n ||
        status.size < 0n ||
        status.size > BigInt(maximumProcessLockBytes)
    ) {
        return false;
    }
    const ageMs = Date.now() - Number(status.ctimeMs);
    return ageMs >= 0 && ageMs <= processLockInitializationGraceMs;
}

async function createProcessLock(
    options: ExclusiveProcessLockOptions
): Promise<OwnedProcessLock | undefined> {
    let handle: FileHandle;
    try {
        handle = await open(options.lockPath, lockOpenFlags, 0o600);
    } catch (error) {
        if (errorCode(error) === "EEXIST") return undefined;
        throw processLockFailure(options.failureMessage);
    }
    try {
        await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, token: Bun.randomUUIDv7() })}\n`,
            "utf8"
        );
        await handle.sync();
        const owned = Object.freeze({
            path: options.lockPath,
            snapshot: snapshot(
                await handle.stat({ bigint: true }),
                options.failureMessage
            ),
        });
        await handle.close();
        return owned;
    } catch {
        await handle.close().catch(() => {});
        await unlink(options.lockPath).catch(() => {});
        throw processLockFailure(options.failureMessage);
    }
}

async function readProcessLock(options: ExclusiveProcessLockOptions): Promise<
    | {
          owner: v.InferOutput<typeof processLockOwnerSchema>;
          snapshot: ProcessLockSnapshot;
      }
    | undefined
> {
    let handle: FileHandle;
    let contents: string | undefined;
    try {
        handle = await open(options.lockPath, lockReadFlags);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw processLockFailure(options.failureMessage);
    }
    try {
        const before = snapshot(
            await handle.stat({ bigint: true }),
            options.failureMessage
        );
        contents = await handle.readFile("utf8");
        const after = snapshot(
            await handle.stat({ bigint: true }),
            options.failureMessage
        );
        if (
            !sameSnapshot(before, after) ||
            Buffer.byteLength(contents) > maximumProcessLockBytes
        ) {
            throw processLockFailure(options.failureMessage);
        }
        const parsed: unknown = JSON.parse(contents);
        return Object.freeze({
            owner: v.parse(processLockOwnerSchema, parsed),
            snapshot: after,
        });
    } catch {
        if (
            await processLockMayStillBeInitializing(
                options.lockPath,
                options.failureMessage,
                contents
            )
        ) {
            return undefined;
        }
        throw processLockFailure(options.failureMessage);
    } finally {
        await handle.close();
    }
}

function isProcessAlive(pid: number, failureMessage: string): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (errorCode(error) === "ESRCH") return false;
        if (errorCode(error) === "EPERM") return true;
        throw processLockFailure(failureMessage);
    }
}

async function recoverStaleProcessLock(
    options: ExclusiveProcessLockOptions
): Promise<void> {
    const observed = await readProcessLock(options);
    if (
        observed === undefined ||
        isProcessAlive(observed.owner.pid, options.failureMessage)
    ) {
        return;
    }
    let currentStatus: BigIntStats;
    try {
        currentStatus = await lstat(options.lockPath, { bigint: true });
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw processLockFailure(options.failureMessage);
    }
    const current = snapshot(currentStatus, options.failureMessage);
    if (!sameSnapshot(observed.snapshot, current)) {
        throw processLockFailure(options.failureMessage);
    }
    try {
        await unlink(options.lockPath);
    } catch (error) {
        if (errorCode(error) !== "ENOENT") {
            throw processLockFailure(options.failureMessage);
        }
    }
}

async function acquireProcessLock(
    options: ExclusiveProcessLockOptions
): Promise<OwnedProcessLock> {
    const deadline = Date.now() + options.deadlineMs;
    while (Date.now() < deadline) {
        const owned = await createProcessLock(options);
        if (owned !== undefined) return owned;
        await recoverStaleProcessLock(options);
        await Bun.sleep(options.retryMs);
    }
    throw processLockFailure(options.failureMessage);
}

async function releaseProcessLock(
    lock: OwnedProcessLock,
    failureMessage: string
): Promise<void> {
    try {
        const current = snapshot(
            await lstat(lock.path, { bigint: true }),
            failureMessage
        );
        if (!sameSnapshot(lock.snapshot, current)) {
            throw processLockFailure(failureMessage);
        }
        await unlink(lock.path);
    } catch {
        throw processLockFailure(failureMessage);
    }
}

/**
 * Runs one operation under a bounded cross-process lock with dead-owner recovery.
 * @param options Exact lock path and admission policy below an already protected directory.
 * @param operation Complete operation that must never overlap another lock owner.
 * @returns Operation result after the owned lock is released.
 */
export async function withExclusiveProcessLock<T>(
    options: ExclusiveProcessLockOptions,
    operation: () => Promise<T>
): Promise<T> {
    validateOptions(options);
    const lock = await acquireProcessLock(options);
    try {
        return await operation();
    } finally {
        await releaseProcessLock(lock, options.failureMessage);
    }
}
