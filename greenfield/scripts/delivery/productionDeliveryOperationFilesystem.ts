import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    deliveryProductionOperationMaximumBytes,
    deliveryProductionPhaseCanAdvance,
    parseDeliveryProductionOperationCapsule,
    parseDeliveryProductionOperationRecord,
    retainedDeliveryProductionReceiptIds,
    serializeDeliveryProductionOperationRecord,
    serializeDeliveryProductionPayload,
    type DeliveryProductionOperationInspection,
    type DeliveryProductionOperationCapsule,
    type DeliveryProductionOperationPhase,
    type DeliveryProductionOperationRecord,
    type DeliveryProductionReceiptRetention,
    type DeliveryProductionTerminalRecord,
    type DeliveryProductionTerminalResult,
} from "../../src/shared/deliveryProductionOperation.ts";
import { lowercaseUuidV7Schema } from "../../src/shared/validation.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import { removeStalePrivateStateStage } from "./privateStateStageFile.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";

const filesystemFailureMessage = "Production delivery operation filesystem failed";
const operationDirectoryName = "delivery-production-operations";
const inFlightFileName = "in-flight.json";
const receiptNamePattern =
    /^receipt-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const maximumDirectoryEntries = 128;
const privateDirectoryMode = 0o700;
const privateDirectoryModeBigInt = 0o700n;
const privateFileModeBigInt = 0o600n;
const maximumDescriptorInfoBytes = 4 * 1024;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface OpenedDirectory {
    readonly canonicalPath: string;
    readonly device: bigint;
    readonly handle: FileHandle;
    readonly inode: bigint;
    readonly mountId: bigint;
}

type ReadRecord = DeliveryProductionOperationRecord | undefined;

export type { DeliveryProductionOperationInspection } from "../../src/shared/deliveryProductionOperation.ts";

/** Deterministic race boundaries exposed only to focused adversarial tests. */
export interface DeliveryProductionOperationFilesystemTestHooks {
    readonly afterRead?: (fileName: string) => Promise<void> | void;
    readonly afterReceiptStored?: (transitionId: string) => Promise<void> | void;
    readonly beforeReceiptRemoved?: (transitionId: string) => Promise<void> | void;
}

/** Raised for invalid paths, metadata, bytes, races, or stale CAS updates. */
export class DeliveryProductionOperationFilesystemError extends Error {
    override readonly name = "DeliveryProductionOperationFilesystemError";
}

function failure(): DeliveryProductionOperationFilesystemError {
    return new DeliveryProductionOperationFilesystemError(filesystemFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function receiptFileName(transitionId: string): string {
    if (!v.is(lowercaseUuidV7Schema(), transitionId)) throw failure();
    return `receipt-${transitionId}.json`;
}

function stageFileName(kind: "in-flight" | "receipt", transitionId: string): string {
    return `.stage-${kind}-${transitionId}.json`;
}

function sameIdentity(
    status: BigIntStats,
    expected: Pick<OpenedDirectory, "device" | "inode">
): boolean {
    return status.dev === expected.device && status.ino === expected.inode;
}

function validPrivateDirectory(status: BigIntStats, expectedDevice?: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
        (status.mode & 0o7777n) === privateDirectoryModeBigInt &&
        (expectedDevice === undefined || status.dev === expectedDevice)
    );
}

function validPrivateFile(status: BigIntStats, device: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === device &&
        (status.mode & 0o7777n) === privateFileModeBigInt &&
        status.size > 0n &&
        status.size <= BigInt(deliveryProductionOperationMaximumBytes)
    );
}

async function closeHandle(handle: FileHandle | undefined): Promise<boolean> {
    if (!handle) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

async function readMountId(fileDescriptor: number): Promise<bigint> {
    try {
        const text = await Bun.file(`/proc/self/fdinfo/${fileDescriptor}`).text();
        if (text.length <= 0 || text.length > maximumDescriptorInfoBytes) throw failure();
        const matches = [...text.matchAll(/^mnt_id:\s*(\d+)$/gmu)];
        if (matches.length !== 1 || !matches[0]?.[1]) throw failure();
        const mountId = BigInt(matches[0][1]);
        if (mountId <= 0n) throw failure();
        return mountId;
    } catch {
        throw failure();
    }
}

async function openStableDirectory(
    requestedPath: string,
    canonicalPath: string,
    expectedDevice?: bigint,
    expectedMountId?: bigint
): Promise<OpenedDirectory> {
    if (process.platform !== "linux") throw failure();
    let handle: FileHandle | undefined;
    try {
        handle = await open(requestedPath, directoryFlags);
        const [held, named, observedCanonical, mountId] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(canonicalPath, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
            readMountId(handle.fd),
        ]);
        if (
            observedCanonical !== canonicalPath ||
            !validPrivateDirectory(held, expectedDevice) ||
            !validPrivateDirectory(named, expectedDevice) ||
            held.dev !== named.dev ||
            held.ino !== named.ino ||
            (expectedMountId !== undefined && mountId !== expectedMountId)
        ) {
            throw failure();
        }
        return Object.freeze({
            canonicalPath,
            device: held.dev,
            handle,
            inode: held.ino,
            mountId,
        });
    } catch {
        await closeHandle(handle);
        throw failure();
    }
}

async function revalidateDirectory(directory: OpenedDirectory): Promise<void> {
    try {
        const [held, named, canonical, mountId] = await Promise.all([
            directory.handle.stat({ bigint: true }),
            lstat(directory.canonicalPath, { bigint: true }),
            realpath(`/proc/self/fd/${directory.handle.fd}`),
            readMountId(directory.handle.fd),
        ]);
        if (
            canonical !== directory.canonicalPath ||
            !validPrivateDirectory(held, directory.device) ||
            !validPrivateDirectory(named, directory.device) ||
            !sameIdentity(held, directory) ||
            !sameIdentity(named, directory) ||
            mountId !== directory.mountId
        ) {
            throw failure();
        }
    } catch {
        throw failure();
    }
}

async function openStateDirectory(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths
): Promise<OpenedDirectory> {
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        !path.isAbsolute(paths.stateDirectory) ||
        path.resolve(paths.stateDirectory) !== paths.stateDirectory
    ) {
        throw failure();
    }
    return openStableDirectory(paths.stateDirectory, paths.stateDirectory);
}

async function openOperationDirectory(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    create: boolean
): Promise<OpenedDirectory | undefined> {
    const state = await openStateDirectory(lease, paths);
    const canonicalPath = path.join(paths.stateDirectory, operationDirectoryName);
    const anchoredPath = path.join(
        `/proc/self/fd/${state.handle.fd}`,
        operationDirectoryName
    );
    let operation: OpenedDirectory | undefined;
    let missing = false;
    let failed = false;
    try {
        if (create) {
            try {
                await mkdir(anchoredPath, { mode: privateDirectoryMode });
                await state.handle.sync();
            } catch (error) {
                if (errorCode(error) !== "EEXIST") throw failure();
            }
        } else {
            try {
                await lstat(anchoredPath, { bigint: true });
            } catch (error) {
                if (errorCode(error) === "ENOENT") {
                    missing = true;
                } else {
                    throw failure();
                }
            }
        }
        if (!missing) {
            operation = await openStableDirectory(
                anchoredPath,
                canonicalPath,
                state.device,
                state.mountId
            );
        }
        await revalidateDirectory(state);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) {
        await closeHandle(operation?.handle);
        throw failure();
    }
    return missing ? undefined : operation;
}

async function readRecord(
    directory: OpenedDirectory,
    fileName: string,
    hooks: DeliveryProductionOperationFilesystemTestHooks = {}
): Promise<ReadRecord> {
    const anchored = path.join(`/proc/self/fd/${directory.handle.fd}`, fileName);
    let handle: FileHandle | undefined;
    let result: ReadRecord;
    let missing = false;
    let failed = false;
    try {
        try {
            handle = await open(anchored, readFlags);
        } catch (error) {
            if (errorCode(error) === "ENOENT") {
                missing = true;
            } else {
                throw failure();
            }
        }
        if (handle) {
            const [heldBefore, mountId] = await Promise.all([
                handle.stat({ bigint: true }),
                readMountId(handle.fd),
            ]);
            if (
                !validPrivateFile(heldBefore, directory.device) ||
                mountId !== directory.mountId
            ) {
                throw failure();
            }
            const bytes = await handle.readFile();
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const value: unknown = JSON.parse(text);
            result = parseDeliveryProductionOperationRecord(value);
            if (!payloadDigestMatches(result)) throw failure();
            await hooks.afterRead?.(fileName);
            const [heldAfter, namedAfter] = await Promise.all([
                handle.stat({ bigint: true }),
                lstat(anchored, { bigint: true }),
            ]);
            if (
                !validPrivateFile(heldAfter, directory.device) ||
                !validPrivateFile(namedAfter, directory.device) ||
                heldAfter.dev !== heldBefore.dev ||
                heldAfter.ino !== heldBefore.ino ||
                heldAfter.ctimeNs !== heldBefore.ctimeNs ||
                heldAfter.mtimeNs !== heldBefore.mtimeNs ||
                heldAfter.size !== heldBefore.size ||
                namedAfter.dev !== heldBefore.dev ||
                namedAfter.ino !== heldBefore.ino ||
                namedAfter.ctimeNs !== heldBefore.ctimeNs ||
                namedAfter.mtimeNs !== heldBefore.mtimeNs ||
                namedAfter.size !== heldBefore.size
            ) {
                throw failure();
            }
            await revalidateDirectory(directory);
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw failure();
    return missing ? undefined : result;
}

async function writeStage(
    directory: OpenedDirectory,
    stageName: string,
    record: DeliveryProductionOperationRecord
): Promise<void> {
    const stagePath = path.join(`/proc/self/fd/${directory.handle.fd}`, stageName);
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(
            stagePath,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            0o600
        );
        const bytes = new TextEncoder().encode(
            serializeDeliveryProductionOperationRecord(record)
        );
        if (bytes.byteLength > deliveryProductionOperationMaximumBytes) throw failure();
        await handle.writeFile(bytes);
        await handle.sync();
        const [status, mountId] = await Promise.all([
            handle.stat({ bigint: true }),
            readMountId(handle.fd),
        ]);
        if (
            !validPrivateFile(status, directory.device) ||
            mountId !== directory.mountId
        ) {
            throw failure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw failure();
}

function recordsEqual(
    left: DeliveryProductionOperationRecord | undefined,
    right: DeliveryProductionOperationRecord | undefined
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function payloadDigestMatches(record: DeliveryProductionOperationRecord): boolean {
    return (
        new Bun.CryptoHasher("sha256")
            .update(serializeDeliveryProductionPayload(record.capsule.enqueue.payload))
            .digest("hex") === record.capsule.enqueue.payloadSha256
    );
}

async function replaceInFlight(
    directory: OpenedDirectory,
    expected: DeliveryProductionOperationRecord | undefined,
    next: DeliveryProductionOperationRecord
): Promise<void> {
    const actual = await readRecord(directory, inFlightFileName);
    if (recordsEqual(actual, next)) return;
    if (!recordsEqual(actual, expected)) throw failure();
    const stageName = stageFileName("in-flight", next.capsule.transitionId);
    const descriptorRoot = `/proc/self/fd/${directory.handle.fd}`;
    const stagePath = path.join(descriptorRoot, stageName);
    const finalPath = path.join(descriptorRoot, inFlightFileName);
    let stageOwned = false;
    try {
        await removeStalePrivateStateStage({
            directoryHandle: directory.handle,
            expectedDevice: directory.device,
            maximumBytes: deliveryProductionOperationMaximumBytes,
            stageName,
        });
        await writeStage(directory, stageName, next);
        stageOwned = true;
        await rename(stagePath, finalPath);
        stageOwned = false;
        await directory.handle.sync();
        if (!recordsEqual(await readRecord(directory, inFlightFileName), next)) {
            throw failure();
        }
    } catch {
        if (stageOwned) {
            try {
                await unlink(stagePath);
                await directory.handle.sync();
            } catch {
                // Preserve the fixed fail-closed error and private bounded evidence.
            }
        }
        throw failure();
    }
}

async function storeReceipt(
    directory: OpenedDirectory,
    receipt: DeliveryProductionTerminalRecord
): Promise<void> {
    const fileName = receiptFileName(receipt.capsule.transitionId);
    const existing = await readRecord(directory, fileName);
    if (existing !== undefined) {
        if (existing.phase !== "terminal" || !recordsEqual(existing, receipt)) {
            throw failure();
        }
        return;
    }
    const stageName = stageFileName("receipt", receipt.capsule.transitionId);
    const descriptorRoot = `/proc/self/fd/${directory.handle.fd}`;
    const stagePath = path.join(descriptorRoot, stageName);
    const finalPath = path.join(descriptorRoot, fileName);
    let stageOwned = false;
    try {
        await removeStalePrivateStateStage({
            directoryHandle: directory.handle,
            expectedDevice: directory.device,
            maximumBytes: deliveryProductionOperationMaximumBytes,
            stageName,
        });
        await writeStage(directory, stageName, receipt);
        stageOwned = true;
        if ((await readRecord(directory, fileName)) !== undefined) throw failure();
        await rename(stagePath, finalPath);
        stageOwned = false;
        await directory.handle.sync();
        if (!recordsEqual(await readRecord(directory, fileName), receipt))
            throw failure();
    } catch {
        if (stageOwned) {
            try {
                await unlink(stagePath);
                await directory.handle.sync();
            } catch {
                // Preserve the fixed fail-closed error and private bounded evidence.
            }
        }
        throw failure();
    }
}

function terminalFrom(
    capsule: DeliveryProductionOperationCapsule,
    result: DeliveryProductionTerminalResult
): DeliveryProductionTerminalRecord {
    const record = parseDeliveryProductionOperationRecord({
        capsule,
        phase: "terminal",
        result,
        updatedAtMs: result.completedAtMs,
    });
    if (record.phase !== "terminal" || !payloadDigestMatches(record)) throw failure();
    return record;
}

async function inspectionFromDirectory(
    directory: OpenedDirectory,
    transitionId?: string,
    hooks: DeliveryProductionOperationFilesystemTestHooks = {}
): Promise<DeliveryProductionOperationInspection> {
    const active = await readRecord(directory, inFlightFileName, hooks);
    const selectedTransitionId = transitionId ?? active?.capsule.transitionId;
    if (!selectedTransitionId) return Object.freeze({ state: "missing" });
    const receipt = await readRecord(
        directory,
        receiptFileName(selectedTransitionId),
        hooks
    );
    if (receipt !== undefined && receipt.phase !== "terminal") {
        return Object.freeze({ state: "conflict", transitionId: selectedTransitionId });
    }
    const activeMatches = active?.capsule.transitionId === selectedTransitionId;
    if (receipt?.phase === "terminal") {
        if (
            activeMatches &&
            (active.capsule.runId !== receipt.capsule.runId ||
                JSON.stringify(active.capsule) !== JSON.stringify(receipt.capsule) ||
                (active.phase === "terminal" && !recordsEqual(active, receipt)))
        ) {
            return Object.freeze({
                state: "conflict",
                transitionId: selectedTransitionId,
            });
        }
        return Object.freeze({
            record: receipt,
            state: "terminal",
            transitionId: selectedTransitionId,
        });
    }
    if (!activeMatches) {
        return active === undefined || transitionId !== undefined
            ? Object.freeze({ state: "missing", transitionId: selectedTransitionId })
            : Object.freeze({ state: "conflict", transitionId: selectedTransitionId });
    }
    if (active.phase === "terminal") {
        return Object.freeze({ state: "conflict", transitionId: selectedTransitionId });
    }
    return Object.freeze({
        record: active,
        state: "in-progress",
        transitionId: selectedTransitionId,
    });
}

async function closeDirectory<T>(
    directory: OpenedDirectory | undefined,
    operation: (directory: OpenedDirectory) => Promise<T>,
    missing: T
): Promise<T> {
    if (!directory) return missing;
    let result: T | undefined;
    let failed = false;
    try {
        result = await operation(directory);
        await revalidateDirectory(directory);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(directory.handle);
    if (failed || !closed || result === undefined) throw failure();
    return result;
}

/**
 * Inspects the one globally active cutover, including a receipt-first crash boundary.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param hooks Deterministic adversarial read hooks.
 * @returns Missing, in-progress, terminal, or conflicting state.
 */
export async function inspectDeliveryProductionOperation(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    hooks: DeliveryProductionOperationFilesystemTestHooks = {}
): Promise<DeliveryProductionOperationInspection> {
    const directory = await openOperationDirectory(lease, paths, false);
    return closeDirectory(
        directory,
        (opened) => inspectionFromDirectory(opened, undefined, hooks),
        Object.freeze({ state: "missing" })
    );
}

/**
 * Inspects one historical receipt used by paired-rollback Job rehydration.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param transitionId Exact historical Job-run and transition identity.
 * @param hooks Deterministic adversarial read hooks.
 * @returns Missing, terminal, or conflicting state.
 */
export async function inspectDeliveryProductionReceipt(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    transitionId: string,
    hooks: DeliveryProductionOperationFilesystemTestHooks = {}
): Promise<DeliveryProductionOperationInspection> {
    const canonicalTransitionId = v.parse(lowercaseUuidV7Schema(), transitionId);
    const directory = await openOperationDirectory(lease, paths, false);
    return closeDirectory(
        directory,
        (opened) => inspectionFromDirectory(opened, canonicalTransitionId, hooks),
        Object.freeze({ state: "missing", transitionId: canonicalTransitionId })
    );
}

/**
 * Creates the exact fsynced intent before any production service can be stopped.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param untrustedCapsule Secret-free rehydration capsule.
 * @param recordedAtMs Durable intent timestamp.
 * @returns Exact durable initial record.
 */
export async function createDeliveryProductionOperation(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    untrustedCapsule: DeliveryProductionOperationCapsule,
    recordedAtMs: number
): Promise<Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>> {
    const capsule = parseDeliveryProductionOperationCapsule(untrustedCapsule);
    const record = parseDeliveryProductionOperationRecord({
        capsule,
        phase: "intent-recorded",
        updatedAtMs: recordedAtMs,
    });
    if (record.phase === "terminal" || !payloadDigestMatches(record)) throw failure();
    const directory = await openOperationDirectory(lease, paths, true);
    if (!directory) throw failure();
    return closeDirectory(
        directory,
        async (opened) => {
            const active = await inspectionFromDirectory(opened);
            if (active.state !== "missing") throw failure();
            const historical = await inspectionFromDirectory(
                opened,
                capsule.transitionId
            );
            if (historical.state !== "missing") throw failure();
            await replaceInFlight(opened, undefined, record);
            return record;
        },
        record
    );
}

/**
 * CAS-advances one exact adjacent durable phase.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Exact currently durable record.
 * @param nextPhase Adjacent requested phase.
 * @param updatedAtMs Durable update timestamp.
 * @returns Exact durable next record.
 */
export async function advanceDeliveryProductionOperation(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    nextPhase: DeliveryProductionOperationPhase,
    updatedAtMs: number
): Promise<Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>> {
    const current = parseDeliveryProductionOperationRecord(expected);
    if (
        current.phase === "terminal" ||
        !payloadDigestMatches(current) ||
        updatedAtMs < current.updatedAtMs ||
        !deliveryProductionPhaseCanAdvance(current.phase, nextPhase)
    ) {
        throw failure();
    }
    const next = parseDeliveryProductionOperationRecord({
        capsule: current.capsule,
        phase: nextPhase,
        updatedAtMs,
    });
    if (next.phase === "terminal") throw failure();
    const directory = await openOperationDirectory(lease, paths, false);
    if (!directory) throw failure();
    return closeDirectory(
        directory,
        async (opened) => {
            const receipt = await readRecord(
                opened,
                receiptFileName(current.capsule.transitionId)
            );
            if (receipt !== undefined) throw failure();
            await replaceInFlight(opened, current, next);
            return next;
        },
        next
    );
}

/**
 * Stores an immutable receipt before replacing the in-flight journal terminally.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Exact currently durable record.
 * @param result Sanitized terminal result.
 * @param hooks Deterministic adversarial completion hooks.
 * @returns Immutable terminal receipt.
 */
export async function completeDeliveryProductionOperation(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    result: DeliveryProductionTerminalResult,
    hooks: DeliveryProductionOperationFilesystemTestHooks = {}
): Promise<DeliveryProductionTerminalRecord> {
    const current = parseDeliveryProductionOperationRecord(expected);
    if (
        current.phase === "terminal" ||
        !payloadDigestMatches(current) ||
        result.completedAtMs < current.updatedAtMs
    ) {
        throw failure();
    }
    const receipt = terminalFrom(current.capsule, result);
    const directory = await openOperationDirectory(lease, paths, false);
    if (!directory) throw failure();
    return closeDirectory(
        directory,
        async (opened) => {
            await storeReceipt(opened, receipt);
            await hooks.afterReceiptStored?.(current.capsule.transitionId);
            const active = await readRecord(opened, inFlightFileName);
            if (recordsEqual(active, receipt)) return receipt;
            await replaceInFlight(opened, current, receipt);
            return receipt;
        },
        receipt
    );
}

/**
 * Clears only an exact receipt-backed in-flight entry; the receipt remains immutable.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Exact terminal receipt.
 * @returns Completion after the active entry is absent.
 */
export async function clearDeliveryProductionOperation(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: DeliveryProductionTerminalRecord
): Promise<void> {
    const receipt = parseDeliveryProductionOperationRecord(expected);
    if (receipt.phase !== "terminal") throw failure();
    const directory = await openOperationDirectory(lease, paths, false);
    if (!directory) throw failure();
    await closeDirectory(
        directory,
        async (opened) => {
            const inspection = await inspectionFromDirectory(
                opened,
                receipt.capsule.transitionId
            );
            if (
                inspection.state !== "terminal" ||
                !recordsEqual(inspection.record, receipt)
            ) {
                throw failure();
            }
            const active = await readRecord(opened, inFlightFileName);
            if (active === undefined) return true;
            if (
                active.capsule.transitionId !== receipt.capsule.transitionId ||
                JSON.stringify(active.capsule) !== JSON.stringify(receipt.capsule)
            ) {
                throw failure();
            }
            await unlink(
                path.join(`/proc/self/fd/${opened.handle.fd}`, inFlightFileName)
            );
            await opened.handle.sync();
            if ((await readRecord(opened, inFlightFileName)) !== undefined)
                throw failure();
            return true;
        },
        true
    );
}

async function unlinkPinnedReceipt(
    directory: OpenedDirectory,
    transitionId: string,
    hooks: DeliveryProductionOperationFilesystemTestHooks
): Promise<void> {
    const fileName = receiptFileName(transitionId);
    const anchored = path.join(`/proc/self/fd/${directory.handle.fd}`, fileName);
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(anchored, readFlags);
        const [held, mountId] = await Promise.all([
            handle.stat({ bigint: true }),
            readMountId(handle.fd),
        ]);
        if (!validPrivateFile(held, directory.device) || mountId !== directory.mountId) {
            throw failure();
        }
        await hooks.beforeReceiptRemoved?.(transitionId);
        const named = await lstat(anchored, { bigint: true });
        if (
            !validPrivateFile(named, directory.device) ||
            held.dev !== named.dev ||
            held.ino !== named.ino ||
            held.ctimeNs !== named.ctimeNs ||
            held.mtimeNs !== named.mtimeNs ||
            held.size !== named.size
        ) {
            throw failure();
        }
        await unlink(anchored);
        await directory.handle.sync();
        const after = await handle.stat({ bigint: true });
        if (after.dev !== held.dev || after.ino !== held.ino || after.nlink !== 0n) {
            throw failure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw failure();
}

/**
 * Retains only receipts referenced by current, previous, or in-flight activation state.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param input Current, previous, and in-flight receipt identities.
 * @param hooks Deterministic adversarial deletion hooks.
 * @returns Completion after exact inode-pinned retention.
 */
export async function retainDeliveryProductionReceipts(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    input: DeliveryProductionReceiptRetention,
    hooks: DeliveryProductionOperationFilesystemTestHooks = {}
): Promise<void> {
    const protectedIds = new Set(retainedDeliveryProductionReceiptIds(input));
    const directory = await openOperationDirectory(lease, paths, false);
    await closeDirectory(
        directory,
        async (opened) => {
            const active = await readRecord(opened, inFlightFileName);
            if ((active?.capsule.transitionId ?? null) !== input.inFlightTransitionId) {
                throw failure();
            }
            const entries = await readdir(`/proc/self/fd/${opened.handle.fd}`, {
                withFileTypes: true,
            });
            if (entries.length > maximumDirectoryEntries) throw failure();
            const receiptIds: string[] = [];
            for (const entry of entries) {
                if (entry.name === inFlightFileName && entry.isFile()) continue;
                const match = receiptNamePattern.exec(entry.name);
                if (!entry.isFile() || !match?.[1]) throw failure();
                const receipt = await readRecord(opened, entry.name);
                if (
                    receipt?.phase !== "terminal" ||
                    receipt.capsule.transitionId !== match[1]
                ) {
                    throw failure();
                }
                receiptIds.push(match[1]);
            }
            for (const transitionId of receiptIds) {
                if (!protectedIds.has(transitionId)) {
                    await unlinkPinnedReceipt(opened, transitionId, hooks);
                }
            }
            return true;
        },
        true
    );
}
