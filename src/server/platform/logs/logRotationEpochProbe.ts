import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    logRotationEpochProjectionFileName,
    logRotationEpochProjectionMaximumBytes,
    logRotationEpochProjectionSchema,
} from "../../../shared/logRotationEpochProjection.ts";

const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

export interface LogRotationEpochProbe {
    readonly epoch: (sourceId: string) => Promise<string | undefined>;
}

interface OpenedProjection {
    readonly directory: FileHandle;
    readonly directoryStatus: Stats;
    readonly file: FileHandle;
    readonly filePath: string;
    readonly root: string;
    readonly status: Stats;
}

function probeFailure(): Error {
    return new Error("Log rotation epoch is unavailable");
}

function sameIdentity(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function sameFileObservation(left: Stats, right: Stats): boolean {
    return (
        sameIdentity(left, right) &&
        left.ctimeMs === right.ctimeMs &&
        left.mtimeMs === right.mtimeMs &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.uid === right.uid
    );
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
        status.size <= logRotationEpochProjectionMaximumBytes
    );
}

function validRoot(root: string): boolean {
    return (
        path.isAbsolute(root) &&
        path.resolve(root) === root &&
        root !== path.parse(root).root &&
        !root.includes("\0") &&
        root.length <= 4096
    );
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw probeFailure();
    }
    return process.getuid();
}

async function openProjection(
    root: string,
    expectedUserId: number
): Promise<OpenedProjection | undefined> {
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
            throw probeFailure();
        }
        const filePath = `${descriptorRoot}/${logRotationEpochProjectionFileName}`;
        try {
            file = await open(filePath, readFlags);
        } catch (error) {
            if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
                await directory.close();
                return undefined;
            }
            throw error;
        }
        const status = await file.stat();
        if (!trustedFile(status, expectedUserId)) throw probeFailure();
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
        throw probeFailure();
    }
}

async function readProjection(opened: OpenedProjection): Promise<unknown> {
    const bytes = Buffer.alloc(opened.status.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await opened.file.read(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset
        );
        if (result.bytesRead === 0) throw probeFailure();
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
        !sameFileObservation(descriptorStatus, opened.status) ||
        !sameFileObservation(pathStatus, opened.status) ||
        !trustedFile(descriptorStatus, opened.status.uid) ||
        !trustedFile(pathStatus, opened.status.uid)
    ) {
        throw probeFailure();
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

/**
 * Creates the read-only web side of the worker-owned copytruncate marker boundary.
 * @param options Exact private projection root and expected worker user identity.
 * @returns A bounded exact-source epoch reader; a missing marker means no managed rotation yet.
 * A source being copytruncated fails closed until the worker commits its new generation.
 */
export function createLogRotationEpochProbe(options: {
    readonly expectedUserId?: number;
    readonly logMaintenanceRoot: string;
}): LogRotationEpochProbe {
    const expectedUserId = options.expectedUserId ?? currentUserId();
    if (
        !validRoot(options.logMaintenanceRoot) ||
        !Number.isSafeInteger(expectedUserId) ||
        expectedUserId < 0
    ) {
        throw probeFailure();
    }
    return Object.freeze({
        async epoch(sourceId: string) {
            let opened: OpenedProjection | undefined;
            try {
                opened = await openProjection(options.logMaintenanceRoot, expectedUserId);
                if (opened === undefined) return;
                const projection = v.parse(
                    logRotationEpochProjectionSchema,
                    await readProjection(opened)
                );
                const entry = projection.entries.find(
                    (candidate) => candidate.sourceId === sourceId
                );
                if (entry === undefined) return;
                if (entry.state !== "committed") throw probeFailure();
                return entry.epoch;
            } catch {
                throw probeFailure();
            } finally {
                await opened?.file.close().catch(() => {});
                await opened?.directory.close().catch(() => {});
            }
        },
    });
}
