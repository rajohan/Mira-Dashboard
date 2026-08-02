import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
    type DashboardReleaseLayout,
    type DashboardReleaseManagerOptions,
    type ManagedDashboardRelease,
    RELEASE_TRANSITION_LOCK_FILE_NAME,
    RELEASE_TRANSITION_LOCK_PROGRAM,
    RELEASE_TRANSITION_LOCK_RETRY_MS,
} from "./managerModel.ts";

async function openReleaseTransitionLockFile(
    layout: DashboardReleaseLayout
): Promise<fs.promises.FileHandle> {
    const lockPath = path.join(layout.root, RELEASE_TRANSITION_LOCK_FILE_NAME);
    const file = await fsp.open(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_RDWR,
        0o600
    );
    const descriptorStat = await file.stat();
    const pathStat = await fsp.lstat(lockPath);
    if (
        !descriptorStat.isFile() ||
        descriptorStat.nlink !== 1 ||
        !pathStat.isFile() ||
        pathStat.isSymbolicLink() ||
        pathStat.nlink !== 1 ||
        descriptorStat.dev !== pathStat.dev ||
        descriptorStat.ino !== pathStat.ino
    ) {
        await file.close();
        throw new TypeError("Release transition lock must be a single-link regular file");
    }
    return file;
}

export function isReleaseTransitionLockAvailable(): boolean {
    try {
        fs.accessSync(RELEASE_TRANSITION_LOCK_PROGRAM, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function assertReleaseTransitionLockCommandSucceeded(
    error: NodeJS.ErrnoException | undefined,
    status: number | null | undefined,
    stderr: string
): void {
    if (error) {
        throw new Error(
            error.code === "ENOENT"
                ? `Managed release transitions require executable ${RELEASE_TRANSITION_LOCK_PROGRAM}`
                : `Managed release transition lock failed: ${error.message}`,
            { cause: error }
        );
    }
    if (status === 0) {
        return;
    }
    if (status === 75) {
        throw new Error("Another managed release transition is in progress");
    }
    const diagnostic = stderr.trim();
    throw new Error(
        `Managed release transition lock exited ${status ?? "by signal"}${
            diagnostic ? `: ${diagnostic.slice(0, 1000)}` : ""
        }`
    );
}

async function acquireReleaseTransitionLock(
    layout: DashboardReleaseLayout,
    lockMode: "exclusive" | "shared",
    waitTimeoutMs = 0,
    onContention?: () => void
): Promise<fs.promises.FileHandle> {
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
        throw new RangeError(
            "Managed release transition lock wait must be a finite non-negative number"
        );
    }
    const deadline = Date.now() + waitTimeoutMs;
    while (true) {
        const lockFile = await openReleaseTransitionLockFile(layout);
        const result = spawnSync(
            RELEASE_TRANSITION_LOCK_PROGRAM,
            [
                lockMode === "exclusive" ? "--exclusive" : "--shared",
                "--nonblock",
                "--conflict-exit-code",
                "75",
                "3",
            ],
            {
                stdio: ["ignore", "ignore", "pipe", lockFile.fd],
            }
        );
        if (result.status === 0 && !result.error) {
            return lockFile;
        }
        await lockFile.close();
        if (result.status === 75 && Date.now() < deadline) {
            onContention?.();
            await Bun.sleep(
                Math.min(RELEASE_TRANSITION_LOCK_RETRY_MS, deadline - Date.now())
            );
            continue;
        }
        assertReleaseTransitionLockCommandSucceeded(
            result.error,
            result.status,
            result.stderr?.toString("utf8") ?? ""
        );
    }
}

export async function withReleaseTransitionLock<T>(
    layout: DashboardReleaseLayout,
    lockMode: "exclusive" | "shared",
    transition: () => Promise<T>,
    waitTimeoutMs = 0,
    onContention?: () => void
): Promise<T> {
    const lockFile = await acquireReleaseTransitionLock(
        layout,
        lockMode,
        waitTimeoutMs,
        onContention
    );
    let result: T | undefined;
    let transitionError: Error | undefined;
    try {
        result = await transition();
    } catch (primaryError) {
        transitionError =
            primaryError instanceof Error
                ? primaryError
                : new Error("Managed release transition failed", {
                      cause: primaryError,
                  });
    }
    try {
        await lockFile.close();
    } catch (cleanupError) {
        if (transitionError !== undefined) {
            const transitionFailure = new AggregateError(
                [transitionError, cleanupError],
                "Managed release transition failed and its lock could not be released",
                { cause: transitionError }
            );
            throw transitionFailure;
        }
        throw cleanupError;
    }
    if (transitionError !== undefined) {
        throw transitionError;
    }
    return result as T;
}

export async function withPreparedReleaseTransition<T>(
    target: ManagedDashboardRelease,
    options: DashboardReleaseManagerOptions,
    transition: () => Promise<T>
): Promise<T> {
    const preparation = await options.prepareReleaseTransition?.(target);
    try {
        return await transition();
    } catch (transitionError) {
        if (!preparation) {
            throw transitionError;
        }
        try {
            await preparation.rollback();
        } catch (rollbackError) {
            const transitionFailure = new AggregateError(
                [transitionError, rollbackError],
                "Managed release transition and preparation rollback failed",
                { cause: transitionError }
            );
            throw transitionFailure;
        }
        throw transitionError;
    }
}
