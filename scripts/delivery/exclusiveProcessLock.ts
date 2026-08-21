import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

const maximumProcessLockBytes = 512;
const maximumProcessStatBytes = 4096;
const processLockInitializationGraceMs = 5000;
const linuxBootIdPath = "/proc/sys/kernel/random/boot_id";
const lockOpenFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const lockReadFlags = constants.O_NOFOLLOW | constants.O_RDONLY;
const processLockOwnerSchema = v.strictObject({
    bootId: v.pipe(v.string(), v.uuid()),
    pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
    processStartTicks: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/u), v.maxLength(32)),
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

interface ObservedProcessLock {
    readonly owner?: v.InferOutput<typeof processLockOwnerSchema>;
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

function snapshot(
    status: BigIntStats,
    failureMessage: string,
    allowIncomplete = false
): ProcessLockSnapshot {
    if (
        typeof process.getuid !== "function" ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o022n) !== 0n ||
        status.size < (allowIncomplete ? 0n : 1n) ||
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

async function readLinuxBootId(failureMessage: string): Promise<string> {
    try {
        const contents = await readFile(linuxBootIdPath, "utf8");
        if (Buffer.byteLength(contents) > 64) throw processLockFailure(failureMessage);
        return v.parse(v.pipe(v.string(), v.uuid()), contents.trim());
    } catch {
        throw processLockFailure(failureMessage);
    }
}

async function readProcessStartTicks(
    pid: number,
    failureMessage: string
): Promise<string | undefined> {
    try {
        const contents = await readFile(`/proc/${pid}/stat`, "utf8");
        if (
            Buffer.byteLength(contents) === 0 ||
            Buffer.byteLength(contents) > maximumProcessStatBytes
        ) {
            throw processLockFailure(failureMessage);
        }
        // The command name is parenthesized and may contain spaces or `)` characters,
        // so field 22 (starttime) is located relative to the final closing parenthesis.
        const closingParenthesis = contents.lastIndexOf(")");
        if (
            !contents.startsWith(`${pid} (`) ||
            closingParenthesis <= String(pid).length + 1
        ) {
            throw processLockFailure(failureMessage);
        }
        const fields = contents
            .slice(closingParenthesis + 1)
            .trim()
            .split(/\s+/u);
        const processStartTicks = fields[19];
        if (
            fields.length < 20 ||
            processStartTicks === undefined ||
            !/^(?:0|[1-9]\d*)$/u.test(processStartTicks) ||
            processStartTicks.length > 32
        ) {
            throw processLockFailure(failureMessage);
        }
        return processStartTicks;
    } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") {
            return undefined;
        }
        throw processLockFailure(failureMessage);
    }
}

async function currentProcessIdentity(failureMessage: string): Promise<{
    bootId: string;
    processStartTicks: string;
}> {
    const [bootId, processStartTicks] = await Promise.all([
        readLinuxBootId(failureMessage),
        readProcessStartTicks(process.pid, failureMessage),
    ] as const);
    if (processStartTicks === undefined) throw processLockFailure(failureMessage);
    return Object.freeze({ bootId, processStartTicks });
}

async function createProcessLock(
    options: ExclusiveProcessLockOptions
): Promise<OwnedProcessLock | undefined> {
    const identity = await currentProcessIdentity(options.failureMessage);
    let handle: FileHandle;
    try {
        handle = await open(options.lockPath, lockOpenFlags, 0o600);
    } catch (error) {
        if (errorCode(error) === "EEXIST") return undefined;
        throw processLockFailure(options.failureMessage);
    }
    try {
        await handle.writeFile(
            `${JSON.stringify({
                bootId: identity.bootId,
                pid: process.pid,
                processStartTicks: identity.processStartTicks,
                token: Bun.randomUUIDv7(),
            })}\n`,
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

async function readProcessLock(
    options: ExclusiveProcessLockOptions
): Promise<ObservedProcessLock | undefined> {
    let handle: FileHandle;
    try {
        handle = await open(options.lockPath, lockReadFlags);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw processLockFailure(options.failureMessage);
    }
    try {
        const beforeStatus = await handle.stat({ bigint: true });
        if (beforeStatus.nlink === 0n) return undefined;
        const before = snapshot(beforeStatus, options.failureMessage, true);
        const buffer = Buffer.alloc(maximumProcessLockBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
        if (bytesRead > maximumProcessLockBytes) {
            throw processLockFailure(options.failureMessage);
        }
        const contents = buffer.subarray(0, bytesRead).toString("utf8");
        const afterStatus = await handle.stat({ bigint: true });
        if (afterStatus.nlink === 0n) return undefined;
        const after = snapshot(afterStatus, options.failureMessage, true);
        if (!sameSnapshot(before, after)) {
            return undefined;
        }
        let pathStatus: BigIntStats;
        try {
            pathStatus = await lstat(options.lockPath, { bigint: true });
        } catch (error) {
            if (errorCode(error) === "ENOENT") return undefined;
            throw processLockFailure(options.failureMessage);
        }
        if (!sameSnapshot(after, snapshot(pathStatus, options.failureMessage, true))) {
            return undefined;
        }
        if (!contents.endsWith("\n")) {
            return Object.freeze({ snapshot: after });
        }
        const parsed: unknown = JSON.parse(contents);
        return Object.freeze({
            owner: v.parse(processLockOwnerSchema, parsed),
            snapshot: after,
        });
    } catch {
        throw processLockFailure(options.failureMessage);
    } finally {
        await handle.close();
    }
}

async function ownerIdentityIsAlive(
    owner: v.InferOutput<typeof processLockOwnerSchema>,
    failureMessage: string
): Promise<boolean> {
    const bootId = await readLinuxBootId(failureMessage);
    if (bootId !== owner.bootId) return false;
    const processStartTicks = await readProcessStartTicks(owner.pid, failureMessage);
    return processStartTicks === owner.processStartTicks;
}

async function recoverStaleProcessLock(
    options: ExclusiveProcessLockOptions
): Promise<void> {
    const observed = await readProcessLock(options);
    if (observed === undefined) return;
    if (observed.owner === undefined) {
        let currentStatus: BigIntStats;
        try {
            currentStatus = await lstat(options.lockPath, { bigint: true });
        } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw processLockFailure(options.failureMessage);
        }
        const current = snapshot(currentStatus, options.failureMessage, true);
        if (!sameSnapshot(observed.snapshot, current)) return;
        const ageMs = Date.now() - Number(currentStatus.ctimeMs);
        if (!Number.isFinite(ageMs) || ageMs < processLockInitializationGraceMs) {
            return;
        }
    } else if (await ownerIdentityIsAlive(observed.owner, options.failureMessage)) {
        return;
    }
    let currentStatus: BigIntStats;
    try {
        currentStatus = await lstat(options.lockPath, { bigint: true });
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw processLockFailure(options.failureMessage);
    }
    const current = snapshot(
        currentStatus,
        options.failureMessage,
        observed.owner === undefined
    );
    if (!sameSnapshot(observed.snapshot, current)) {
        return;
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
