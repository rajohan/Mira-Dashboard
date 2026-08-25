import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    deliveryReleasesSchema,
    type DeliveryRelease,
    type DeliveryReleases,
} from "../../contracts/delivery.ts";
import { jobRunIdSchema } from "../../contracts/jobModel.ts";
import {
    parseProductionActivationRecord,
    type ProductionActivationRecord,
} from "../../shared/productionActivationRecord.ts";
import {
    parseReleaseManifest,
    type ReleaseManifest,
} from "../../shared/releaseManifest.ts";
import type { DeliveryProductionReadPort } from "./overviewCollector.ts";
import type { DeliveryProductionAuthoritySnapshot } from "./overviewProjection.ts";

const activationFileName = "activation.json";
const manifestFileName = "release-manifest.json";
const activationMaximumBytes = 64 * 1024;
const manifestMaximumBytes = 4 * 1024 * 1024;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const productionProtocol = "delivery.production.v2";

interface FileIdentity {
    readonly ctimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly mtimeNs: bigint;
    readonly nlink: bigint;
    readonly size: bigint;
    readonly uid: bigint;
}

interface OpenedDirectory {
    readonly canonicalPath: string;
    readonly handle: FileHandle;
    readonly identity: FileIdentity;
    readonly mountId: number;
}

interface StableJsonRead {
    readonly identity: FileIdentity;
    readonly value: unknown;
}

export interface DeliveryProductionAuthorityReaderOptions {
    readonly readActionActive: (input: {
        readonly excludeRunId?: string;
        readonly signal?: AbortSignal;
    }) => Promise<boolean>;
    readonly releasesDirectory: string;
    readonly stateDirectory: string;
}

export interface DeliveryProductionAuthorityRead {
    readonly activation?: ProductionActivationRecord;
    readonly snapshot: DeliveryProductionAuthoritySnapshot;
}

export interface DeliveryProductionAuthorityReader extends DeliveryProductionReadPort {
    readonly readExact: (
        signal?: AbortSignal
    ) => Promise<DeliveryProductionAuthorityRead>;
    readonly readForOperation: (
        runId: string,
        signal?: AbortSignal
    ) => Promise<DeliveryProductionAuthoritySnapshot>;
}

export class DeliveryProductionAuthorityReaderError extends Error {
    override readonly name = "DeliveryProductionAuthorityReaderError";
}

function failure(): DeliveryProductionAuthorityReaderError {
    return new DeliveryProductionAuthorityReaderError(
        "Delivery production authority is unavailable"
    );
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw failure();
    }
    return process.getuid();
}

function identity(status: BigIntStats): FileIdentity {
    return Object.freeze({
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mode: status.mode & 0o7777n,
        mtimeNs: status.mtimeNs,
        nlink: status.nlink,
        size: status.size,
        uid: status.uid,
    });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.ctimeNs === right.ctimeNs &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.mtimeNs === right.mtimeNs &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.uid === right.uid
    );
}

function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.uid === right.uid
    );
}

async function mountId(handle: FileHandle): Promise<number> {
    const text = await readFile(`/proc/self/fdinfo/${String(handle.fd)}`, "utf8");
    if (text.length > 4096) throw failure();
    const values = [...text.matchAll(/^mnt_id:\s+(\d+)$/gmu)];
    const value = values.length === 1 ? Number(values[0]?.[1]) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1) throw failure();
    return value;
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

function validDirectory(
    status: BigIntStats,
    userId: number,
    mode: bigint,
    expectedDevice?: bigint
): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & 0o7777n) === mode &&
        (expectedDevice === undefined || status.dev === expectedDevice)
    );
}

async function openDirectory(input: {
    readonly canonicalPath: string;
    readonly expectedDevice?: bigint;
    readonly expectedMode: bigint;
    readonly expectedMountId?: number;
    readonly openPath?: string;
}): Promise<OpenedDirectory> {
    let handle: FileHandle | undefined;
    let result: OpenedDirectory | undefined;
    try {
        const userId = currentUserId();
        handle = await open(input.openPath ?? input.canonicalPath, directoryFlags);
        const [held, pathStatus, canonical, observedMountId] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(input.openPath ?? input.canonicalPath, { bigint: true }),
            realpath(`/proc/self/fd/${String(handle.fd)}`),
            mountId(handle),
        ]);
        const heldIdentity = identity(held);
        if (
            canonical !== input.canonicalPath ||
            !validDirectory(held, userId, input.expectedMode, input.expectedDevice) ||
            !sameDirectoryIdentity(heldIdentity, identity(pathStatus)) ||
            (input.expectedMountId !== undefined &&
                observedMountId !== input.expectedMountId)
        ) {
            throw failure();
        }
        result = Object.freeze({
            canonicalPath: input.canonicalPath,
            handle,
            identity: heldIdentity,
            mountId: observedMountId,
        });
    } catch {
        await close(handle);
        throw failure();
    }
    return result;
}

async function directoryStillMatches(directory: OpenedDirectory): Promise<boolean> {
    try {
        const [held, pathStatus, canonical, observedMountId] = await Promise.all([
            directory.handle.stat({ bigint: true }),
            lstat(directory.canonicalPath, { bigint: true }),
            realpath(`/proc/self/fd/${String(directory.handle.fd)}`),
            mountId(directory.handle),
        ]);
        return (
            canonical === directory.canonicalPath &&
            observedMountId === directory.mountId &&
            sameDirectoryIdentity(identity(held), directory.identity) &&
            sameDirectoryIdentity(identity(pathStatus), directory.identity)
        );
    } catch {
        return false;
    }
}

function validFile(
    status: BigIntStats,
    userId: number,
    expectedDevice: bigint,
    expectedMode: bigint,
    maximumBytes: number
): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(userId) &&
        status.dev === expectedDevice &&
        (status.mode & 0o7777n) === expectedMode &&
        status.size > 0n &&
        status.size <= BigInt(maximumBytes)
    );
}

async function readJsonFile(input: {
    readonly directory: OpenedDirectory;
    readonly fileName: string;
    readonly maximumBytes: number;
    readonly missingAllowed?: boolean;
    readonly mode: bigint;
}): Promise<StableJsonRead | undefined> {
    const descriptorPath = path.join(
        `/proc/self/fd/${String(input.directory.handle.fd)}`,
        input.fileName
    );
    const canonicalPath = path.join(input.directory.canonicalPath, input.fileName);
    let handle: FileHandle | undefined;
    let result: StableJsonRead | undefined;
    let missing = false;
    let failed = false;
    try {
        try {
            handle = await open(descriptorPath, fileFlags);
        } catch (error) {
            if (input.missingAllowed && errorCode(error) === "ENOENT") {
                missing = true;
            } else {
                throw error;
            }
        }
        if (handle !== undefined) {
            const userId = currentUserId();
            const [held, canonical, observedMountId] = await Promise.all([
                handle.stat({ bigint: true }),
                realpath(`/proc/self/fd/${String(handle.fd)}`),
                mountId(handle),
            ]);
            if (
                canonical !== canonicalPath ||
                observedMountId !== input.directory.mountId ||
                !validFile(
                    held,
                    userId,
                    input.directory.identity.dev,
                    input.mode,
                    input.maximumBytes
                )
            ) {
                throw failure();
            }
            const before = identity(held);
            const expectedBytes = Number(held.size);
            const bytes = Buffer.alloc(expectedBytes + 1);
            let offset = 0;
            while (offset < bytes.byteLength) {
                const read = await handle.read(
                    bytes,
                    offset,
                    bytes.byteLength - offset,
                    offset
                );
                if (read.bytesRead === 0) break;
                offset += read.bytesRead;
            }
            const [heldAfter, pathAfter] = await Promise.all([
                handle.stat({ bigint: true }),
                lstat(descriptorPath, { bigint: true }),
            ]);
            if (
                offset !== expectedBytes ||
                !sameIdentity(before, identity(heldAfter)) ||
                !sameIdentity(before, identity(pathAfter))
            ) {
                throw failure();
            }
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.subarray(0, offset)
            );
            const value: unknown = JSON.parse(text) as unknown;
            result = Object.freeze({ identity: before, value });
        }
    } catch {
        failed = true;
    }
    const closed = await close(handle);
    if (failed || !closed || (!missing && result === undefined)) throw failure();
    return result;
}

function releaseProjection(
    manifest: ReleaseManifest,
    releaseId: string,
    runtimeRevision: string
): Readonly<{ release: DeliveryRelease; supportsProductionProtocol: boolean }> {
    if (
        manifest.source.commitSha !== releaseId ||
        manifest.runtime.revision !== runtimeRevision
    ) {
        throw failure();
    }
    return Object.freeze({
        release: Object.freeze({
            builtAtMs: manifest.display.builtAtMs,
            commitTitle: manifest.display.commitTitle,
            commitUrl: `https://github.com/rajohan/Mira-Dashboard/commit/${releaseId}`,
            releaseId,
            runtimeRevision,
            schemaTarget: manifest.display.schemaTarget,
        }),
        supportsProductionProtocol:
            manifest.deliveryProtocols.includes(productionProtocol) &&
            manifest.processRoles.includes("production-delivery"),
    });
}

async function readRelease(
    releases: OpenedDirectory,
    releaseId: string,
    runtimeRevision: string
): Promise<Readonly<{ release: DeliveryRelease; supportsProductionProtocol: boolean }>> {
    const releasePath = path.join(releases.canonicalPath, releaseId);
    const release = await openDirectory({
        canonicalPath: releasePath,
        expectedDevice: releases.identity.dev,
        expectedMode: 0o500n,
        expectedMountId: releases.mountId,
        openPath: path.join(`/proc/self/fd/${String(releases.handle.fd)}`, releaseId),
    });
    let projected:
        | Readonly<{ release: DeliveryRelease; supportsProductionProtocol: boolean }>
        | undefined;
    let failed = false;
    try {
        const stored = await readJsonFile({
            directory: release,
            fileName: manifestFileName,
            maximumBytes: manifestMaximumBytes,
            mode: 0o400n,
        });
        if (stored === undefined) throw failure();
        projected = releaseProjection(
            parseReleaseManifest(stored.value),
            releaseId,
            runtimeRevision
        );
        if (!(await directoryStillMatches(release))) throw failure();
    } catch {
        failed = true;
    }
    const closed = await close(release.handle);
    if (failed || !closed || projected === undefined) throw failure();
    return projected;
}

function activationRevision(input: {
    readonly current?: DeliveryRelease;
    readonly previous?: DeliveryRelease;
    readonly record: ReturnType<typeof parseProductionActivationRecord> | undefined;
}): string {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex");
}

function rollbackProjection(
    record: ProductionActivationRecord | undefined,
    actionActive: boolean,
    previousSupportsProductionProtocol: boolean
): DeliveryReleases["rollback"] {
    if (record?.previous === null || record?.previous === undefined) {
        return Object.freeze({
            actor: "mira",
            available: false,
            reason: "no-previous-release",
        });
    }
    if (actionActive) {
        return Object.freeze({
            actor: "mira",
            available: false,
            reason: "action-active",
        });
    }
    if (!previousSupportsProductionProtocol) {
        return Object.freeze({
            actor: "mira",
            available: false,
            reason: "incompatible",
        });
    }
    return Object.freeze({
        actor: "mira",
        available: true,
        target: Object.freeze({
            databaseSnapshotTransitionId: record.previous.databaseSnapshotTransitionId,
            releaseId: record.previous.releaseId,
            runtimeRevision: record.previous.runtimeRevision,
        }),
    });
}

function assertLayout(stateDirectory: string, releasesDirectory: string): void {
    const productionDirectory = path.dirname(stateDirectory);
    if (
        stateDirectory.includes("\0") ||
        releasesDirectory.includes("\0") ||
        !path.isAbsolute(stateDirectory) ||
        !path.isAbsolute(releasesDirectory) ||
        path.resolve(stateDirectory) !== stateDirectory ||
        path.resolve(releasesDirectory) !== releasesDirectory ||
        path.basename(stateDirectory) !== "state" ||
        path.basename(releasesDirectory) !== "releases" ||
        path.dirname(releasesDirectory) !== productionDirectory ||
        path.basename(productionDirectory) !== "production"
    ) {
        throw failure();
    }
}

async function readActionActive(
    reader: DeliveryProductionAuthorityReaderOptions["readActionActive"],
    excludeRunId?: string,
    signal?: AbortSignal
): Promise<boolean> {
    try {
        const value = await reader({
            ...(excludeRunId === undefined ? {} : { excludeRunId }),
            ...(signal === undefined ? {} : { signal }),
        });
        if (typeof value !== "boolean") throw failure();
        return value;
    } catch {
        signal?.throwIfAborted();
        throw failure();
    }
}

/**
 * Creates the worker-only reader for immutable production release authority.
 * @returns A descriptor-, inode-, and mount-fenced Delivery production port.
 */
export function createDeliveryProductionAuthorityReader(
    options: DeliveryProductionAuthorityReaderOptions
): DeliveryProductionAuthorityReader {
    assertLayout(options.stateDirectory, options.releasesDirectory);
    const readAuthority = async (
        excludeRunId?: string,
        signal?: AbortSignal
    ): Promise<DeliveryProductionAuthorityRead> => {
        signal?.throwIfAborted();
        const actionActiveBefore = await readActionActive(
            options.readActionActive,
            excludeRunId,
            signal
        );
        const state = await openDirectory({
            canonicalPath: options.stateDirectory,
            expectedMode: 0o700n,
        });
        let releases: OpenedDirectory | undefined;
        let result: DeliveryProductionAuthorityRead | undefined;
        let failed = false;
        try {
            releases = await openDirectory({
                canonicalPath: options.releasesDirectory,
                expectedDevice: state.identity.dev,
                expectedMode: 0o700n,
                expectedMountId: state.mountId,
            });
            const firstActivation = await readJsonFile({
                directory: state,
                fileName: activationFileName,
                maximumBytes: activationMaximumBytes,
                missingAllowed: true,
                mode: 0o600n,
            });
            const record =
                firstActivation === undefined
                    ? undefined
                    : parseProductionActivationRecord(firstActivation.value);
            const currentProjection =
                record === undefined
                    ? undefined
                    : await readRelease(
                          releases,
                          record.current.releaseId,
                          record.current.runtimeRevision
                      );
            if (
                currentProjection !== undefined &&
                !currentProjection.supportsProductionProtocol
            ) {
                throw failure();
            }
            const previousProjection =
                record?.previous === null || record?.previous === undefined
                    ? undefined
                    : await readRelease(
                          releases,
                          record.previous.releaseId,
                          record.previous.runtimeRevision
                      );
            signal?.throwIfAborted();
            const [secondActivation, actionActiveAfter] = await Promise.all([
                readJsonFile({
                    directory: state,
                    fileName: activationFileName,
                    maximumBytes: activationMaximumBytes,
                    missingAllowed: true,
                    mode: 0o600n,
                }),
                readActionActive(options.readActionActive, excludeRunId, signal),
            ]);
            if (
                actionActiveAfter !== actionActiveBefore ||
                JSON.stringify(secondActivation?.value) !==
                    JSON.stringify(firstActivation?.value) ||
                (firstActivation === undefined) !== (secondActivation === undefined) ||
                (firstActivation !== undefined &&
                    secondActivation !== undefined &&
                    !sameIdentity(firstActivation.identity, secondActivation.identity)) ||
                !(await directoryStillMatches(state)) ||
                !(await directoryStillMatches(releases))
            ) {
                throw failure();
            }
            const releasesProjection: DeliveryReleases = {
                activationRevision: activationRevision({
                    ...(currentProjection === undefined
                        ? {}
                        : { current: currentProjection.release }),
                    ...(previousProjection === undefined
                        ? {}
                        : { previous: previousProjection.release }),
                    record,
                }),
                ...(currentProjection === undefined
                    ? {}
                    : { current: currentProjection.release }),
                ...(previousProjection === undefined
                    ? {}
                    : { previous: previousProjection.release }),
                rollback: rollbackProjection(
                    record,
                    actionActiveAfter,
                    previousProjection?.supportsProductionProtocol === true
                ),
            };
            result = Object.freeze({
                ...(record === undefined ? {} : { activation: record }),
                snapshot: Object.freeze({
                    actionActive: actionActiveAfter,
                    releases: v.parse(deliveryReleasesSchema, releasesProjection),
                }),
            });
        } catch {
            failed = true;
        }
        const releasesClosed = await close(releases?.handle);
        const stateClosed = await close(state.handle);
        signal?.throwIfAborted();
        if (failed || !releasesClosed || !stateClosed || result === undefined) {
            throw failure();
        }
        return result;
    };
    const readExact = (signal?: AbortSignal) => readAuthority(undefined, signal);
    return Object.freeze({
        read: async (signal?: AbortSignal) => {
            const authority = await readExact(signal);
            return authority.snapshot;
        },
        readExact,
        readForOperation: async (untrustedRunId: string, signal?: AbortSignal) => {
            const runId = v.parse(jobRunIdSchema, untrustedRunId);
            const authority = await readAuthority(runId, signal);
            return authority.snapshot;
        },
    });
}
