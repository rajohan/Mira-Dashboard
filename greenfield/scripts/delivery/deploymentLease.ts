import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { withExclusiveProcessLock } from "./exclusiveProcessLock.ts";

const deploymentLeaseDeadlineMs = 2 * 60 * 1000;
const deploymentLeaseRetryMs = 25;
const deploymentLockFileName = ".deployment.lock";
const deploymentLeaseFailureMessage = "Dashboard deployment lease failed";
const deploymentLeaseBrand: unique symbol = Symbol("DashboardDeploymentLease");

/** Unforgeable proof that one callback currently owns the project deployment lease. */
export interface DashboardDeploymentLease {
    readonly [deploymentLeaseBrand]: true;
    readonly stateDirectory: string;
}

interface StateDirectorySnapshot {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly uid: bigint;
}

function deploymentLeaseFailure(): Error {
    return new Error(deploymentLeaseFailureMessage);
}

function sameStateDirectory(
    expected: StateDirectorySnapshot,
    actual: StateDirectorySnapshot
): boolean {
    return (
        expected.dev === actual.dev &&
        expected.ino === actual.ino &&
        expected.mode === actual.mode &&
        expected.uid === actual.uid
    );
}

function stateDirectorySnapshot(status: BigIntStats): StateDirectorySnapshot {
    if (
        typeof process.getuid !== "function" ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o7777n) !== 0o700n
    ) {
        throw deploymentLeaseFailure();
    }
    return Object.freeze({
        dev: status.dev,
        ino: status.ino,
        mode: status.mode,
        uid: status.uid,
    });
}

async function validateStateDirectory(
    stateDirectory: string
): Promise<StateDirectorySnapshot> {
    if (
        !path.isAbsolute(stateDirectory) ||
        stateDirectory.includes("\0") ||
        path.resolve(stateDirectory) !== stateDirectory ||
        path.parse(stateDirectory).root === stateDirectory
    ) {
        throw deploymentLeaseFailure();
    }
    try {
        const [canonical, status] = await Promise.all([
            realpath(stateDirectory),
            lstat(stateDirectory, { bigint: true }),
        ]);
        if (canonical !== stateDirectory) throw deploymentLeaseFailure();
        return stateDirectorySnapshot(status);
    } catch {
        throw deploymentLeaseFailure();
    }
}

/**
 * Serializes one complete production release/database transition below private state.
 * @param stateDirectory Canonical current-user-owned `0700` production state directory.
 * @param operation Complete transition; callers must keep services stopped until it settles.
 * @returns Operation result after the lease and state identity are revalidated.
 */
export async function withDeploymentLease<T>(
    stateDirectory: string,
    operation: (lease: DashboardDeploymentLease) => Promise<T>
): Promise<T> {
    const initial = await validateStateDirectory(stateDirectory);
    const lockPath = path.join(stateDirectory, deploymentLockFileName);
    return withExclusiveProcessLock(
        {
            deadlineMs: deploymentLeaseDeadlineMs,
            failureMessage: deploymentLeaseFailureMessage,
            lockPath,
            retryMs: deploymentLeaseRetryMs,
        },
        async () => {
            const before = await validateStateDirectory(stateDirectory);
            if (!sameStateDirectory(initial, before)) {
                throw deploymentLeaseFailure();
            }
            const lease = Object.freeze({
                [deploymentLeaseBrand]: true as const,
                stateDirectory,
            });
            const result = await operation(lease);
            const after = await validateStateDirectory(stateDirectory);
            if (!sameStateDirectory(initial, after)) {
                throw deploymentLeaseFailure();
            }
            return result;
        }
    );
}
