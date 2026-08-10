import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import type { LogMaintenancePolicyId } from "../../contracts/logs.ts";
import {
    logMaintenanceAvailabilityProjectionFileName,
    logMaintenanceAvailabilityProjectionMaximumBytes,
    logMaintenanceAvailabilityProjectionSchema,
    logMaintenanceAvailabilityRefreshIntervalMs,
} from "../../shared/logMaintenanceAvailabilityProjection.ts";
import { logMaintenancePolicyIds } from "../../shared/logMaintenanceUnits.ts";

const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const createFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

export interface LogMaintenanceAvailabilityPublisherScheduler {
    readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface LogMaintenanceAvailabilityPublisher {
    readonly completion: Promise<void>;
    readonly stop: () => Promise<void>;
}

export interface LogMaintenanceAvailabilityPublisherOptions {
    readonly availablePolicies: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenancePolicyId[]>;
    readonly expectedUserId?: number;
    readonly logMaintenanceRoot: string;
    readonly nowMs?: () => number;
    readonly scheduler?: LogMaintenanceAvailabilityPublisherScheduler;
}

interface OpenedDirectory {
    readonly handle: FileHandle;
    readonly root: string;
    readonly status: Stats;
}

function publisherFailure(): Error {
    return new Error("Log maintenance availability publisher failed");
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw publisherFailure();
    }
    return process.getuid();
}

function validRootPath(root: string): boolean {
    return (
        path.isAbsolute(root) &&
        path.resolve(root) === root &&
        root !== path.parse(root).root &&
        !root.includes("\0") &&
        root.length <= 4096
    );
}

function sameIdentity(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function trustedDirectory(status: Stats, expectedUserId: number): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === expectedUserId &&
        (status.mode & 0o777) === privateDirectoryMode
    );
}

function trustedFile(status: Stats, expectedUserId: number, size: number): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1 &&
        status.uid === expectedUserId &&
        (status.mode & 0o777) === privateFileMode &&
        status.size === size
    );
}

function descriptorChild(directory: OpenedDirectory, fileName: string): string {
    if (
        fileName.length === 0 ||
        fileName.length > 255 ||
        fileName.includes("/") ||
        fileName.includes("\0") ||
        fileName === "." ||
        fileName === ".."
    ) {
        throw publisherFailure();
    }
    return `/proc/self/fd/${directory.handle.fd}/${fileName}`;
}

async function openDirectory(
    root: string,
    expectedUserId: number
): Promise<OpenedDirectory> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(root, directoryFlags);
        const descriptorRoot = `/proc/self/fd/${handle.fd}`;
        const [status, canonicalRoot, pathStatus] = await Promise.all([
            handle.stat(),
            realpath(descriptorRoot),
            lstat(root),
        ]);
        if (
            canonicalRoot !== root ||
            !trustedDirectory(status, expectedUserId) ||
            !sameIdentity(status, pathStatus)
        ) {
            throw publisherFailure();
        }
        return { handle, root, status };
    } catch {
        await handle?.close().catch(() => {});
        throw publisherFailure();
    }
}

async function directoryEntryStillMatches(
    directory: OpenedDirectory,
    expectedUserId: number
): Promise<boolean> {
    try {
        const [descriptorStatus, pathStatus] = await Promise.all([
            directory.handle.stat(),
            lstat(directory.root),
        ]);
        return (
            trustedDirectory(descriptorStatus, expectedUserId) &&
            trustedDirectory(pathStatus, expectedUserId) &&
            sameIdentity(descriptorStatus, directory.status) &&
            sameIdentity(pathStatus, directory.status)
        );
    } catch {
        return false;
    }
}

async function writeExact(handle: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset
        );
        if (result.bytesWritten === 0) throw publisherFailure();
        offset += result.bytesWritten;
    }
}

function canonicalPolicies(
    policies: readonly LogMaintenancePolicyId[]
): readonly LogMaintenancePolicyId[] {
    const projected = new Set<string>(policies);
    return Object.freeze(
        logMaintenancePolicyIds.filter((policyId) => projected.has(policyId))
    );
}

async function publishProjection(options: {
    readonly expectedUserId: number;
    readonly logMaintenanceRoot: string;
    readonly observedAtMs: number;
    readonly policies: readonly LogMaintenancePolicyId[];
}): Promise<void> {
    let projection: v.InferOutput<typeof logMaintenanceAvailabilityProjectionSchema>;
    try {
        projection = v.parse(logMaintenanceAvailabilityProjectionSchema, {
            observedAtMs: options.observedAtMs,
            policies: canonicalPolicies(options.policies),
            version: 1,
        });
    } catch {
        throw publisherFailure();
    }
    const bytes = Buffer.from(`${JSON.stringify(projection)}\n`, "utf8");
    if (
        bytes.byteLength === 0 ||
        bytes.byteLength > logMaintenanceAvailabilityProjectionMaximumBytes
    ) {
        throw publisherFailure();
    }

    const directory = await openDirectory(
        options.logMaintenanceRoot,
        options.expectedUserId
    );
    const stageName = `.mira-log-availability-${randomUUID()}.tmp`;
    const stagePath = descriptorChild(directory, stageName);
    const destinationPath = descriptorChild(
        directory,
        logMaintenanceAvailabilityProjectionFileName
    );
    let stage: FileHandle | undefined;
    let renamed = false;
    try {
        stage = await open(stagePath, createFlags, privateFileMode);
        await stage.chmod(privateFileMode);
        await writeExact(stage, bytes);
        await stage.sync();
        const stageStatus = await stage.stat();
        if (!trustedFile(stageStatus, options.expectedUserId, bytes.byteLength)) {
            throw publisherFailure();
        }
        await stage.close();
        stage = undefined;
        if (!(await directoryEntryStillMatches(directory, options.expectedUserId))) {
            throw publisherFailure();
        }
        await rename(stagePath, destinationPath);
        renamed = true;
        await directory.handle.sync();
        const destinationStatus = await lstat(destinationPath);
        if (
            !trustedFile(destinationStatus, options.expectedUserId, bytes.byteLength) ||
            !sameIdentity(destinationStatus, stageStatus)
        ) {
            throw publisherFailure();
        }
    } catch {
        throw publisherFailure();
    } finally {
        await stage?.close().catch(() => {});
        if (!renamed) await unlink(stagePath).catch(() => {});
        await directory.handle.close().catch(() => {});
    }
}

const defaultScheduler: LogMaintenanceAvailabilityPublisherScheduler = Object.freeze({
    wait(delayMs: number, signal: AbortSignal) {
        return new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
                clearTimeout(handle);
                reject(publisherFailure());
            };
            const handle = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, delayMs);
            handle.unref?.();
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
        });
    },
});

/**
 * Starts the worker-owned, serial availability heartbeat after publishing one
 * initial snapshot. A failed refresh rejects completion so process supervision
 * cannot silently leave a permanently queueable projection behind.
 * @returns The periodic publisher lifecycle with idempotent fail-closed stop.
 */
export async function startLogMaintenanceAvailabilityPublisher(
    options: LogMaintenanceAvailabilityPublisherOptions
): Promise<LogMaintenanceAvailabilityPublisher> {
    const expectedUserId = options.expectedUserId ?? currentUserId();
    const nowMs = options.nowMs ?? Date.now;
    const scheduler = options.scheduler ?? defaultScheduler;
    if (
        !validRootPath(options.logMaintenanceRoot) ||
        !Number.isSafeInteger(expectedUserId) ||
        expectedUserId < 0
    ) {
        throw publisherFailure();
    }

    const controller = new AbortController();
    const refresh = async (): Promise<void> => {
        try {
            const policies = await options.availablePolicies(controller.signal);
            if (controller.signal.aborted) throw publisherFailure();
            await publishProjection({
                expectedUserId,
                logMaintenanceRoot: options.logMaintenanceRoot,
                observedAtMs: nowMs(),
                policies,
            });
        } catch {
            throw publisherFailure();
        }
    };
    await refresh();

    const completion = (async (): Promise<void> => {
        while (!controller.signal.aborted) {
            try {
                await scheduler.wait(
                    logMaintenanceAvailabilityRefreshIntervalMs,
                    controller.signal
                );
            } catch {
                if (controller.signal.aborted) return;
                throw publisherFailure();
            }
            if (controller.signal.aborted) return;
            try {
                await refresh();
            } catch {
                if (controller.signal.aborted) return;
                throw publisherFailure();
            }
        }
    })();
    void completion.catch(() => {});

    let stopPromise: Promise<void> | undefined;
    return Object.freeze({
        completion,
        stop() {
            stopPromise ??= (async () => {
                controller.abort();
                let loopFailure: unknown;
                try {
                    await completion;
                } catch (error) {
                    loopFailure = error;
                }
                try {
                    await publishProjection({
                        expectedUserId,
                        logMaintenanceRoot: options.logMaintenanceRoot,
                        observedAtMs: nowMs(),
                        policies: [],
                    });
                } catch {
                    throw publisherFailure();
                }
                if (loopFailure !== undefined) throw publisherFailure();
            })();
            return stopPromise;
        },
    });
}
