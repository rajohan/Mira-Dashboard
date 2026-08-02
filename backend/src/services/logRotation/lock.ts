import fs from "node:fs/promises";
import path from "node:path";

import {
    resolveDashboardProjectPathsForRuntime,
    resolveDashboardRuntimePath,
} from "../../lib/dashboardPaths.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";

const DEFAULT_LOCK_FILE = path.resolve(process.cwd(), "data/log-rotation.lock");
const RECLAIM_DIR_STALE_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 12 * 60 * 60 * 1000;

export interface LogRotationLock {
    file: fs.FileHandle;
    path: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === code
    );
}

function resolveLogRotationLockFile(): string {
    return resolveAbsoluteNonRootPath(
        resolveDashboardRuntimePath(
            resolveDashboardProjectPathsForRuntime()?.productionLogRotationLockFile,
            process.env.MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE
        ) ?? DEFAULT_LOCK_FILE,
        "MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE"
    );
}

async function ignoreRejection(promise: Promise<unknown> | undefined): Promise<void> {
    try {
        await promise;
    } catch {
        // Best-effort cleanup.
    }
}

async function ignoreMissingPath(promise: Promise<unknown>): Promise<void> {
    try {
        await promise;
    } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
            throw error;
        }
    }
}

export async function acquireLogRotationLock(
    isDryRun: boolean
): Promise<LogRotationLock | undefined> {
    if (isDryRun) return;
    const lockFile = resolveLogRotationLockFile();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const openLock = async () => {
        const handle = await fs.open(lockFile, "wx");
        try {
            await handle.writeFile(`${process.pid}\n`);
            return { file: handle, path: lockFile };
        } catch (error) {
            await ignoreRejection(handle.close());
            await ignoreRejection(fs.unlink(lockFile));
            throw error;
        }
    };
    try {
        return await openLock();
    } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
            return reclaimStaleLogRotationLock(lockFile, openLock);
        }
        throw error;
    }
}

async function reclaimStaleLogRotationLock(
    lockFile: string,
    openLock: () => Promise<LogRotationLock>
): Promise<LogRotationLock | undefined> {
    const reclaimDirectory = `${lockFile}.reclaim`;
    try {
        await fs.mkdir(reclaimDirectory);
    } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
            if (!(await removeStaleReclaimDirectory(reclaimDirectory))) {
                return;
            }
            try {
                await fs.mkdir(reclaimDirectory);
            } catch (reclaimError) {
                if (hasErrorCode(reclaimError, "EEXIST")) {
                    return;
                }
                throw reclaimError;
            }
        } else {
            throw error;
        }
    }
    try {
        let rawPid = "";
        let lockStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
        try {
            const handle = await fs.open(lockFile, "r");
            try {
                lockStat = await handle.stat();
                rawPid = await handle.readFile("utf8");
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (!hasErrorCode(error, "ENOENT")) {
                throw error;
            }
        }
        const pid = Number(rawPid.trim());
        const lockAgeMs = lockStat ? Date.now() - Number(lockStat.mtimeMs) : Infinity;
        if (
            Number.isSafeInteger(pid) &&
            pid > 0 &&
            isProcessRunning(pid) &&
            lockAgeMs < LOCK_STALE_MS
        ) {
            return;
        }
        await ignoreMissingPath(fs.unlink(lockFile));
        try {
            return await openLock();
        } catch (error) {
            if (hasErrorCode(error, "EEXIST")) {
                return;
            }
            throw error;
        }
    } finally {
        await ignoreRejection(fs.rmdir(reclaimDirectory));
    }
}

async function removeStaleReclaimDirectory(reclaimDirectory: string): Promise<boolean> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stat = await fs.stat(reclaimDirectory);
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
            return true;
        }
        throw error;
    }
    if (Date.now() - stat.mtimeMs < RECLAIM_DIR_STALE_MS) return false;
    await fs.rm(reclaimDirectory, { force: true, recursive: true });
    return true;
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return hasErrorCode(error, "EPERM");
    }
}

export async function releaseLogRotationLock(
    lock: LogRotationLock | undefined
): Promise<void> {
    if (!lock) return;
    try {
        const heldStat = await lock.file.stat();
        const pathStat = await fs.stat(lock.path);
        if (pathStat.dev === heldStat.dev && pathStat.ino === heldStat.ino) {
            await fs.unlink(lock.path);
        }
    } finally {
        await lock.file.close();
    }
}
