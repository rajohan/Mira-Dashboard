import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
    parseProductionActivationRecord,
    serializeProductionActivationRecord,
    type ProductionActivationRecord,
} from "../../src/shared/productionActivationRecord.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import { removeStalePrivateStateStage } from "./privateStateStageFile.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";

const activationStateFailureMessage = "Production activation state update failed";
const activationFileName = "activation.json";
const maximumActivationBytes = 64 * 1024;
const privateFileMode = 0o600;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const activationStateBrand: unique symbol = Symbol("ProductionActivationState");

interface FileIdentity {
    readonly ctimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mtimeNs: bigint;
    readonly size: bigint;
    readonly uid: bigint;
}

/** Stable compare-and-swap snapshot of the authoritative activation record. */
export interface ProductionActivationState {
    readonly [activationStateBrand]: true;
    readonly fileIdentity?: FileIdentity;
    readonly record?: ProductionActivationRecord;
    readonly stateDirectory: string;
}

/** Deterministic post-read boundary used only by adversarial tests. */
export interface ProductionActivationStateTestHooks {
    readonly afterRead?: () => Promise<void> | void;
}

function activationFailure(): Error {
    return new Error(activationStateFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function snapshotFile(status: BigIntStats, expectedDevice: bigint): FileIdentity {
    if (
        typeof process.getuid !== "function" ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        status.dev !== expectedDevice ||
        (status.mode & 0o7777n) !== 0o600n ||
        status.size <= 0n ||
        status.size > BigInt(maximumActivationBytes)
    ) {
        throw activationFailure();
    }
    return Object.freeze({
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
        uid: status.uid,
    });
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.ctimeNs === right.ctimeNs &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mtimeNs === right.mtimeNs &&
        left.size === right.size &&
        left.uid === right.uid
    );
}

function sameFileAcrossRename(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mtimeNs === right.mtimeNs &&
        left.size === right.size &&
        left.uid === right.uid
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

async function openStateDirectory(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths
): Promise<{ handle: FileHandle; identity: { dev: bigint; ino: bigint } }> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        lease.stateDirectory !== paths.stateDirectory
    ) {
        throw activationFailure();
    }
    let handle: FileHandle | undefined;
    try {
        handle = await open(paths.stateDirectory, directoryFlags);
        const [held, after, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(paths.stateDirectory, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== paths.stateDirectory ||
            !held.isDirectory() ||
            held.isSymbolicLink() ||
            held.uid !== BigInt(process.getuid()) ||
            (held.mode & 0o7777n) !== 0o700n ||
            after.dev !== held.dev ||
            after.ino !== held.ino
        ) {
            throw activationFailure();
        }
        return { handle, identity: { dev: held.dev, ino: held.ino } };
    } catch {
        await closeHandle(handle);
        throw activationFailure();
    }
}

async function readActivationFile(
    stateHandle: FileHandle,
    stateDevice: bigint,
    testHooks: ProductionActivationStateTestHooks = {}
): Promise<Pick<ProductionActivationState, "fileIdentity" | "record">> {
    const activationFile = path.join(
        `/proc/self/fd/${stateHandle.fd}`,
        activationFileName
    );
    let handle: FileHandle | undefined;
    let result: Pick<ProductionActivationState, "fileIdentity" | "record"> | undefined;
    try {
        handle = await open(activationFile, readFlags);
        const held = snapshotFile(await handle.stat({ bigint: true }), stateDevice);
        const text = await handle.readFile("utf8");
        const value: unknown = JSON.parse(text);
        const record = parseProductionActivationRecord(value);
        await testHooks.afterRead?.();
        const [heldAfter, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(activationFile, { bigint: true }),
        ]);
        const after = snapshotFile(heldAfter, stateDevice);
        const current = snapshotFile(pathAfter, stateDevice);
        if (!sameFile(held, after) || !sameFile(held, current)) {
            throw activationFailure();
        }
        result = Object.freeze({ fileIdentity: current, record });
    } catch (error) {
        if (!handle && errorCode(error) === "ENOENT") return Object.freeze({});
        throw activationFailure();
    } finally {
        const closed = await closeHandle(handle);
        if (!closed) result = undefined;
    }
    if (!result) throw activationFailure();
    return result;
}

/**
 * Reads one stable activation record under the active deployment lease.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @returns Branded absent or present compare-and-swap state.
 */
export async function loadProductionActivationState(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    testHooks: ProductionActivationStateTestHooks = {}
): Promise<ProductionActivationState> {
    const state = await openStateDirectory(lease, paths);
    let result: ProductionActivationState | undefined;
    let failed = false;
    try {
        const observed = await readActivationFile(
            state.handle,
            state.identity.dev,
            testHooks
        );
        result = Object.freeze({
            [activationStateBrand]: true as const,
            ...observed,
            stateDirectory: paths.stateDirectory,
        });
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed || !result) throw activationFailure();
    return result;
}

function validateTransition(
    current: ProductionActivationState,
    next: ProductionActivationRecord
): void {
    if (current.record === undefined) {
        if (next.previous !== null) throw activationFailure();
        return;
    }
    if (
        next.previous === null ||
        next.previous.databaseSnapshotTransitionId !== next.transitionId ||
        next.previous.releaseId !== current.record.current.releaseId ||
        next.previous.runtimeRevision !== current.record.current.runtimeRevision
    ) {
        throw activationFailure();
    }
}

function stateMatches(
    actual: Pick<ProductionActivationState, "fileIdentity" | "record">,
    expected: ProductionActivationState
): boolean {
    return (
        JSON.stringify(actual.record) === JSON.stringify(expected.record) &&
        (actual.fileIdentity === undefined) === (expected.fileIdentity === undefined) &&
        (actual.fileIdentity === undefined ||
            expected.fileIdentity === undefined ||
            sameFile(actual.fileIdentity, expected.fileIdentity))
    );
}

function validateRollback(
    current: ProductionActivationState,
    previous: ProductionActivationRecord | undefined
): void {
    const currentRecord = current.record;
    if (!currentRecord) throw activationFailure();
    if (previous === undefined) {
        if (currentRecord.previous !== null) throw activationFailure();
        return;
    }
    if (
        currentRecord.previous === null ||
        currentRecord.previous.databaseSnapshotTransitionId !==
            currentRecord.transitionId ||
        currentRecord.previous.releaseId !== previous.current.releaseId ||
        currentRecord.previous.runtimeRevision !== previous.current.runtimeRevision
    ) {
        throw activationFailure();
    }
}

async function writeAndCommitStagedRecord(
    stateHandle: FileHandle,
    stageFile: string,
    activationFile: string,
    record: ProductionActivationRecord,
    expectedDevice: bigint
): Promise<void> {
    const stageName = path.basename(stageFile);
    let handle: FileHandle | undefined;
    let stageOwned = false;
    let failed = false;
    try {
        await removeStalePrivateStateStage({
            directoryHandle: stateHandle,
            expectedDevice,
            maximumBytes: maximumActivationBytes,
            stageName,
        });
        handle = await open(
            stageFile,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_RDWR,
            privateFileMode
        );
        stageOwned = true;
        const bytes = new TextEncoder().encode(
            serializeProductionActivationRecord(record)
        );
        if (bytes.byteLength > maximumActivationBytes) throw activationFailure();
        await handle.writeFile(bytes);
        await handle.sync();
        const storedBytes = Buffer.alloc(bytes.byteLength + 1);
        let offset = 0;
        while (offset < storedBytes.byteLength) {
            const read = await handle.read(
                storedBytes,
                offset,
                storedBytes.byteLength - offset,
                offset
            );
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
        }
        const status = await handle.stat({ bigint: true });
        const [stateDirectory, descriptorPath] = await Promise.all([
            realpath(`/proc/self/fd/${stateHandle.fd}`),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            typeof process.getuid !== "function" ||
            descriptorPath !== path.join(stateDirectory, path.basename(stageFile)) ||
            offset !== bytes.byteLength ||
            !status.isFile() ||
            status.nlink !== 1n ||
            status.uid !== BigInt(process.getuid()) ||
            status.dev !== expectedDevice ||
            status.size !== BigInt(bytes.byteLength) ||
            (status.mode & 0o7777n) !== BigInt(privateFileMode)
        ) {
            throw activationFailure();
        }
        const stagedIdentity = snapshotFile(status, expectedDevice);
        const storedText = new TextDecoder("utf-8", { fatal: true }).decode(
            storedBytes.subarray(0, offset)
        );
        const stored: unknown = JSON.parse(storedText);
        if (
            JSON.stringify(parseProductionActivationRecord(stored)) !==
            JSON.stringify(record)
        ) {
            throw activationFailure();
        }
        await rename(stageFile, activationFile);
        stageOwned = false;
        await stateHandle.sync();
        const [heldAfter, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(activationFile, { bigint: true }),
        ]);
        const heldIdentity = snapshotFile(heldAfter, expectedDevice);
        const pathIdentity = snapshotFile(pathAfter, expectedDevice);
        if (
            !sameFileAcrossRename(stagedIdentity, heldIdentity) ||
            !sameFile(heldIdentity, pathIdentity)
        ) {
            throw activationFailure();
        }
    } catch {
        failed = true;
    }
    if (stageOwned) {
        try {
            await unlink(stageFile);
        } catch (error) {
            if (errorCode(error) !== "ENOENT") failed = true;
        }
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw activationFailure();
}

/**
 * Atomically commits one current/previous release and database pairing.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Previously loaded compare-and-swap state.
 * @param untrustedNext Next activation record derived from the verified transition.
 * @returns Newly loaded authoritative state after directory fsync.
 */
export async function commitProductionActivationState(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionActivationState,
    untrustedNext: ProductionActivationRecord
): Promise<ProductionActivationState> {
    const next = parseProductionActivationRecord(untrustedNext);
    if (
        expected[activationStateBrand] !== true ||
        expected.stateDirectory !== paths.stateDirectory
    ) {
        throw activationFailure();
    }
    validateTransition(expected, next);
    const state = await openStateDirectory(lease, paths);
    const stageName = `.activation-${next.transitionId}.json`;
    const descriptorRoot = `/proc/self/fd/${state.handle.fd}`;
    const stageFile = path.join(descriptorRoot, stageName);
    const activationFile = path.join(descriptorRoot, activationFileName);
    let committed: ProductionActivationState | undefined;
    let failed = false;
    try {
        const actual = await readActivationFile(state.handle, state.identity.dev);
        if (!stateMatches(actual, expected)) {
            throw activationFailure();
        }
        await writeAndCommitStagedRecord(
            state.handle,
            stageFile,
            activationFile,
            next,
            state.identity.dev
        );
        const observed = await readActivationFile(state.handle, state.identity.dev);
        if (JSON.stringify(observed.record) !== JSON.stringify(next)) {
            throw activationFailure();
        }
        committed = Object.freeze({
            [activationStateBrand]: true as const,
            ...observed,
            stateDirectory: paths.stateDirectory,
        });
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed || !committed) throw activationFailure();
    return committed;
}

/**
 * Restores the immediate pre-transition activation state after candidate failure.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expectedCurrent Exact committed candidate compare-and-swap state.
 * @param untrustedPrevious Immediate predecessor from the durable transition journal.
 * @returns Newly loaded authoritative predecessor state after directory fsync.
 */
export async function restorePreviousProductionActivationState(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expectedCurrent: ProductionActivationState,
    untrustedPrevious: ProductionActivationRecord | null
): Promise<ProductionActivationState> {
    const previous =
        untrustedPrevious === null
            ? undefined
            : parseProductionActivationRecord(untrustedPrevious);
    if (
        expectedCurrent[activationStateBrand] !== true ||
        expectedCurrent.stateDirectory !== paths.stateDirectory
    ) {
        throw activationFailure();
    }
    validateRollback(expectedCurrent, previous);
    const currentRecord = expectedCurrent.record;
    if (!currentRecord) throw activationFailure();
    const state = await openStateDirectory(lease, paths);
    const descriptorRoot = `/proc/self/fd/${state.handle.fd}`;
    const activationFile = path.join(descriptorRoot, activationFileName);
    let restored: ProductionActivationState | undefined;
    let failed = false;
    try {
        const actual = await readActivationFile(state.handle, state.identity.dev);
        if (!stateMatches(actual, expectedCurrent)) throw activationFailure();
        if (previous === undefined) {
            await unlink(activationFile);
            await state.handle.sync();
        } else {
            await writeAndCommitStagedRecord(
                state.handle,
                path.join(
                    descriptorRoot,
                    `.activation-rollback-${currentRecord.transitionId}.json`
                ),
                activationFile,
                previous,
                state.identity.dev
            );
        }
        const observed = await readActivationFile(state.handle, state.identity.dev);
        if (JSON.stringify(observed.record) !== JSON.stringify(previous)) {
            throw activationFailure();
        }
        restored = Object.freeze({
            [activationStateBrand]: true as const,
            ...observed,
            stateDirectory: paths.stateDirectory,
        });
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed || !restored) throw activationFailure();
    return restored;
}
