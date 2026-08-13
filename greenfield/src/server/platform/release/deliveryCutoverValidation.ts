import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
    deliveryProductionOperationMaximumBytes,
    parseDeliveryProductionOperationRecord,
    type DeliveryProductionOperationRecord,
} from "../../../shared/deliveryProductionOperation.ts";

const operationDirectoryName = "delivery-production-operations";
const inFlightFileName = "in-flight.json";
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.ctimeNs === right.ctimeNs &&
        left.mtimeNs === right.mtimeNs &&
        left.size === right.size &&
        left.uid === right.uid &&
        left.mode === right.mode
    );
}

async function close(handle: FileHandle | undefined): Promise<boolean> {
    if (handle === undefined) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

/**
 * Reads one exact protected active production cutover marker without taking its lease.
 * @param stateDirectory Canonical production state directory.
 * @returns Exact active record, or null when no marker exists.
 */
export async function readActiveProductionCutoverRecord(
    stateDirectory: string
): Promise<DeliveryProductionOperationRecord | null> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        !path.isAbsolute(stateDirectory) ||
        path.resolve(stateDirectory) !== stateDirectory
    ) {
        throw new Error("Production cutover validation state is unavailable");
    }
    const operationDirectory = path.join(stateDirectory, operationDirectoryName);
    const recordPath = path.join(operationDirectory, inFlightFileName);
    let directory: FileHandle | undefined;
    let file: FileHandle | undefined;
    let missing = false;
    let result: DeliveryProductionOperationRecord | null = null;
    let failed = false;
    try {
        try {
            directory = await open(operationDirectory, directoryFlags);
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
                missing = true;
            } else {
                throw error;
            }
        }
        if (!missing && directory !== undefined) {
            const [heldDirectory, namedDirectory, canonicalDirectory] = await Promise.all(
                [
                    directory.stat({ bigint: true }),
                    lstat(operationDirectory, { bigint: true }),
                    realpath(`/proc/self/fd/${String(directory.fd)}`),
                ]
            );
            if (
                canonicalDirectory !== operationDirectory ||
                !heldDirectory.isDirectory() ||
                heldDirectory.isSymbolicLink() ||
                heldDirectory.uid !== BigInt(process.getuid()) ||
                (heldDirectory.mode & 0o7777n) !== 0o700n ||
                heldDirectory.dev !== namedDirectory.dev ||
                heldDirectory.ino !== namedDirectory.ino
            ) {
                throw new Error("Production cutover operation directory is invalid");
            }
            try {
                file = await open(
                    path.join(`/proc/self/fd/${String(directory.fd)}`, inFlightFileName),
                    fileFlags
                );
            } catch (error) {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    (error as NodeJS.ErrnoException).code === "ENOENT"
                ) {
                    missing = true;
                } else {
                    throw error;
                }
            }
            if (!missing && file !== undefined) {
                const [before, canonical] = await Promise.all([
                    file.stat({ bigint: true }),
                    realpath(`/proc/self/fd/${String(file.fd)}`),
                ]);
                if (
                    canonical !== recordPath ||
                    !before.isFile() ||
                    before.isSymbolicLink() ||
                    before.nlink !== 1n ||
                    before.uid !== BigInt(process.getuid()) ||
                    before.dev !== heldDirectory.dev ||
                    (before.mode & 0o7777n) !== 0o600n ||
                    before.size <= 0n ||
                    before.size > BigInt(deliveryProductionOperationMaximumBytes)
                ) {
                    throw new Error("Production cutover operation record is invalid");
                }
                const bytes = await file.readFile();
                const [after, named] = await Promise.all([
                    file.stat({ bigint: true }),
                    lstat(recordPath, { bigint: true }),
                ]);
                if (
                    bytes.byteLength !== Number(before.size) ||
                    !sameFile(before, after) ||
                    !sameFile(before, named)
                ) {
                    throw new Error("Production cutover operation record changed");
                }
                const record = parseDeliveryProductionOperationRecord(
                    JSON.parse(
                        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
                    ) as unknown
                );
                result = record;
            }
        }
    } catch {
        failed = true;
    }
    const [fileClosed, directoryClosed] = await Promise.all([
        close(file),
        close(directory),
    ]);
    if (failed || !fileClosed || !directoryClosed) {
        throw new Error("Production cutover validation state is unavailable");
    }
    return result;
}

/**
 * Returns true only for an exact protected, nonterminal production cutover marker.
 * @param stateDirectory Canonical production state directory.
 * @returns Whether target processes must enter cutover smoke mode.
 */
export async function productionCutoverRequiresValidationMode(
    stateDirectory: string
): Promise<boolean> {
    const record = await readActiveProductionCutoverRecord(stateDirectory);
    return record !== null && record.phase !== "terminal";
}
