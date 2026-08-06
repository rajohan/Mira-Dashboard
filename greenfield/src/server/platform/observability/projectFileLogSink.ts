import {
    closeSync,
    constants,
    fstatSync,
    fsyncSync,
    lstatSync,
    openSync,
    realpathSync,
    writeSync,
} from "node:fs";
import path from "node:path";

import type { StructuredLogLevel, StructuredLogSink } from "./structuredLogger.ts";

const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags =
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const permissionBits = 0o7777;
const maximumPrimaryLogBytes = 128 * 1024 * 1024;
const maximumFallbackLogBytes = 1024 * 1024;

/** Project-local logger sink and its independent direct-fallback writer. */
export interface ProjectFileLogDestination {
    readonly fallbackWrite: (line: string) => void;
    readonly sink: StructuredLogSink;
}

/** Synchronous deterministic mutation boundary used only by adversarial tests. */
export interface ProjectFileLogDestinationTestHooks {
    readonly afterDirectoryOpen?: () => void;
}

interface OpenedLogFile {
    readonly descriptor: number;
    readonly maximumBytes: number;
    writtenBytes: number;
}

function invalidProjectLogDestination(): Error {
    return new Error("Project-local log destination is invalid");
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw invalidProjectLogDestination();
    }
    return process.getuid();
}

function sameIdentity(
    left: ReturnType<typeof fstatSync>,
    right: ReturnType<typeof fstatSync>
): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function writeAll(file: OpenedLogFile, line: string): void {
    const bytes = Buffer.from(line, "utf8");
    if (file.writtenBytes + bytes.byteLength > file.maximumBytes) {
        throw new RangeError("Project-local log byte budget exhausted");
    }
    let written = 0;
    while (written < bytes.byteLength) {
        const count = writeSync(
            file.descriptor,
            bytes,
            written,
            bytes.byteLength - written,
            null
        );
        if (count <= 0) throw invalidProjectLogDestination();
        written += count;
    }
    file.writtenBytes += written;
}

function openLogFile(
    directoryDescriptor: number,
    canonicalDirectory: string,
    filename: string,
    userId: number,
    maximumBytes: number
): OpenedLogFile {
    const descriptor = openSync(
        path.join(`/proc/self/fd/${directoryDescriptor}`, filename),
        fileFlags,
        privateFileMode
    );
    try {
        const status = fstatSync(descriptor);
        const canonicalFile = realpathSync(`/proc/self/fd/${descriptor}`);
        const pathStatus = lstatSync(path.join(canonicalDirectory, filename));
        if (
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.nlink !== 1 ||
            status.uid !== userId ||
            (status.mode & permissionBits) !== privateFileMode ||
            status.size > maximumBytes ||
            path.dirname(canonicalFile) !== canonicalDirectory ||
            path.basename(canonicalFile) !== filename ||
            !pathStatus.isFile() ||
            pathStatus.isSymbolicLink() ||
            !sameIdentity(status, pathStatus)
        ) {
            throw invalidProjectLogDestination();
        }
        return { descriptor, maximumBytes, writtenBytes: status.size };
    } catch (error) {
        closeSync(descriptor);
        throw error;
    }
}

/**
 * Opens bounded append-only process logs beneath an already private state directory.
 * Runtime startup validates but never repairs directory or file permissions.
 * @param logsDirectory Canonical project-local `production/state/logs` path.
 * @param processRole Fixed process identity used for stable log filenames.
 * @param testHooks Deterministic adversarial hooks used only by tests.
 * @returns Synchronous logger sink and independent fallback writer.
 */
export function createProjectFileLogDestination(
    logsDirectory: string,
    processRole: "web" | "worker",
    testHooks: ProjectFileLogDestinationTestHooks = {}
): ProjectFileLogDestination {
    if (
        !path.isAbsolute(logsDirectory) ||
        logsDirectory.includes("\0") ||
        path.resolve(logsDirectory) !== logsDirectory
    ) {
        throw invalidProjectLogDestination();
    }
    const userId = currentUserId();
    let directoryDescriptor: number | undefined;
    let primary: OpenedLogFile | undefined;
    let fallback: OpenedLogFile | undefined;
    try {
        const before = lstatSync(logsDirectory);
        directoryDescriptor = openSync(logsDirectory, directoryFlags);
        const held = fstatSync(directoryDescriptor);
        const canonicalDirectory = realpathSync(`/proc/self/fd/${directoryDescriptor}`);
        testHooks.afterDirectoryOpen?.();
        const after = lstatSync(logsDirectory);
        if (
            canonicalDirectory !== logsDirectory ||
            !held.isDirectory() ||
            held.isSymbolicLink() ||
            held.uid !== userId ||
            (held.mode & permissionBits) !== privateDirectoryMode ||
            !before.isDirectory() ||
            before.isSymbolicLink() ||
            !after.isDirectory() ||
            after.isSymbolicLink() ||
            !sameIdentity(held, before) ||
            !sameIdentity(held, after)
        ) {
            throw invalidProjectLogDestination();
        }
        primary = openLogFile(
            directoryDescriptor,
            canonicalDirectory,
            `${processRole}.ndjson`,
            userId,
            maximumPrimaryLogBytes
        );
        fallback = openLogFile(
            directoryDescriptor,
            canonicalDirectory,
            `${processRole}-fallback.ndjson`,
            userId,
            maximumFallbackLogBytes
        );
    } catch {
        if (fallback) closeSync(fallback.descriptor);
        if (primary) closeSync(primary.descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
        throw invalidProjectLogDestination();
    }

    let closed = false;
    const destination = Object.freeze({
        fallbackWrite(line: string) {
            if (closed) throw invalidProjectLogDestination();
            writeAll(fallback, line);
            fsyncSync(fallback.descriptor);
        },
        sink: Object.freeze({
            flush(): undefined {
                if (closed) return undefined;
                closed = true;
                try {
                    fsyncSync(primary.descriptor);
                    fsyncSync(fallback.descriptor);
                } finally {
                    try {
                        closeSync(fallback.descriptor);
                    } finally {
                        try {
                            closeSync(primary.descriptor);
                        } finally {
                            closeSync(directoryDescriptor);
                        }
                    }
                }
                return undefined;
            },
            write(line: string, _level: StructuredLogLevel): undefined {
                if (closed) throw invalidProjectLogDestination();
                writeAll(primary, line);
                return undefined;
            },
        }),
    });
    return destination;
}
