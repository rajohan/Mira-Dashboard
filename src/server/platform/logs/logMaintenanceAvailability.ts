import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import type { LogMaintenancePolicyId } from "../../../contracts/logs.ts";
import {
    logMaintenanceAvailabilityFutureToleranceMs,
    logMaintenanceAvailabilityMaximumAgeMs,
    logMaintenanceAvailabilityProjectionFileName,
    logMaintenanceAvailabilityProjectionMaximumBytes,
    logMaintenanceAvailabilityProjectionSchema,
} from "../../../shared/logMaintenanceAvailabilityProjection.ts";

const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

export interface LogMaintenanceAvailabilityProbe {
    readonly availablePolicies: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenancePolicyId[]>;
}

export interface LogMaintenanceAvailabilityProbeOptions {
    readonly expectedUserId?: number;
    readonly logMaintenanceRoot: string;
    readonly nowMs?: () => number;
}

interface OpenedProjection {
    readonly directory: FileHandle;
    readonly directoryStatus: Stats;
    readonly file: FileHandle;
    readonly filePath: string;
    readonly root: string;
    readonly status: Stats;
}

function availabilityFailure(): Error {
    return new Error("Log maintenance availability is unavailable");
}

function requireActive(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw availabilityFailure();
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw availabilityFailure();
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

function trustedFile(status: Stats, expectedUserId: number): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1 &&
        status.uid === expectedUserId &&
        (status.mode & 0o777) === privateFileMode &&
        Number.isSafeInteger(status.size) &&
        status.size > 0 &&
        status.size <= logMaintenanceAvailabilityProjectionMaximumBytes
    );
}

async function openProjection(
    root: string,
    expectedUserId: number
): Promise<OpenedProjection> {
    let directory: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
        directory = await open(root, directoryFlags);
        const descriptorRoot = `/proc/self/fd/${directory.fd}`;
        const [directoryStatus, canonicalRoot, pathStatus] = await Promise.all([
            directory.stat(),
            realpath(descriptorRoot),
            lstat(root),
        ]);
        if (
            canonicalRoot !== root ||
            !trustedDirectory(directoryStatus, expectedUserId) ||
            !sameIdentity(directoryStatus, pathStatus)
        ) {
            throw availabilityFailure();
        }
        const filePath = `${descriptorRoot}/${logMaintenanceAvailabilityProjectionFileName}`;
        file = await open(filePath, readFlags);
        const status = await file.stat();
        if (!trustedFile(status, expectedUserId)) throw availabilityFailure();
        return {
            directory,
            directoryStatus,
            file,
            filePath,
            root,
            status,
        };
    } catch {
        await file?.close().catch(() => {});
        await directory?.close().catch(() => {});
        throw availabilityFailure();
    }
}

async function readExactProjection(opened: OpenedProjection): Promise<unknown> {
    const bytes = Buffer.alloc(opened.status.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await opened.file.read(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset
        );
        if (result.bytesRead === 0) throw availabilityFailure();
        offset += result.bytesRead;
    }
    const [descriptorStatus, pathStatus, directoryStatus, rootStatus] = await Promise.all(
        [
            opened.file.stat(),
            lstat(opened.filePath),
            opened.directory.stat(),
            lstat(opened.root),
        ]
    );
    if (
        !sameIdentity(directoryStatus, opened.directoryStatus) ||
        !sameIdentity(rootStatus, opened.directoryStatus) ||
        !trustedDirectory(directoryStatus, opened.directoryStatus.uid) ||
        !trustedDirectory(rootStatus, opened.directoryStatus.uid) ||
        !sameIdentity(descriptorStatus, opened.status) ||
        !sameIdentity(pathStatus, opened.status) ||
        descriptorStatus.size !== opened.status.size ||
        pathStatus.size !== opened.status.size ||
        !trustedFile(descriptorStatus, opened.status.uid) ||
        !trustedFile(pathStatus, opened.status.uid)
    ) {
        throw availabilityFailure();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
}

function projectionIsFresh(observedAtMs: number, nowMs: number): boolean {
    return (
        Number.isSafeInteger(nowMs) &&
        nowMs >= 0 &&
        observedAtMs <= nowMs + logMaintenanceAvailabilityFutureToleranceMs &&
        nowMs - observedAtMs <= logMaintenanceAvailabilityMaximumAgeMs
    );
}

/**
 * Creates the web-process side of the worker-owned availability boundary.
 * The reader accepts only one private, bounded, fresh fixed-policy projection and
 * never gains process execution or managed-rotation state authority.
 * @returns A fail-closed fixed-policy availability reader.
 */
export function createLogMaintenanceAvailabilityProbe(
    options: LogMaintenanceAvailabilityProbeOptions
): LogMaintenanceAvailabilityProbe {
    const expectedUserId = options.expectedUserId ?? currentUserId();
    const nowMs = options.nowMs ?? Date.now;
    if (
        !validRootPath(options.logMaintenanceRoot) ||
        !Number.isSafeInteger(expectedUserId) ||
        expectedUserId < 0
    ) {
        throw availabilityFailure();
    }

    return Object.freeze({
        async availablePolicies(signal?: AbortSignal) {
            requireActive(signal);
            let opened: OpenedProjection | undefined;
            try {
                opened = await openProjection(options.logMaintenanceRoot, expectedUserId);
                requireActive(signal);
                const projection = v.parse(
                    logMaintenanceAvailabilityProjectionSchema,
                    await readExactProjection(opened)
                );
                requireActive(signal);
                return projectionIsFresh(projection.observedAtMs, nowMs())
                    ? Object.freeze([...projection.policies])
                    : [];
            } catch {
                requireActive(signal);
                return [];
            } finally {
                await opened?.file.close().catch(() => {});
                await opened?.directory.close().catch(() => {});
            }
        },
    });
}
