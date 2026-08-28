import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
    parseProductionDeliveryExecutorOwner,
    serializeProductionDeliveryExecutorOwner,
    type ProductionDeliveryExecutorOwner,
} from "../../src/shared/productionDeliveryExecutorOwner.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import { removeStalePrivateStateStage } from "./privateStateStageFile.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";

const failureMessage = "Production Delivery executor owner state failed";
const ownerFileName = "delivery-production-executor-owner.json";
const maximumOwnerBytes = 1024;
const privateFileMode = 0o600;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const ownerStateBrand: unique symbol = Symbol("ProductionDeliveryExecutorOwnerState");

interface FileIdentity {
    readonly ctimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mtimeNs: bigint;
    readonly size: bigint;
    readonly uid: bigint;
}

export interface ProductionDeliveryExecutorOwnerState {
    readonly [ownerStateBrand]: true;
    readonly fileIdentity?: FileIdentity;
    readonly owner?: ProductionDeliveryExecutorOwner;
    readonly stateDirectory: string;
}

export interface ProductionDeliveryExecutorOwnerStateTestHooks {
    readonly afterRead?: () => Promise<void> | void;
}

function failure(): Error {
    return new Error(failureMessage);
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
        status.size > BigInt(maximumOwnerBytes)
    ) {
        throw failure();
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
        lease.stateDirectory !== paths.stateDirectory ||
        !path.isAbsolute(paths.stateDirectory) ||
        path.resolve(paths.stateDirectory) !== paths.stateDirectory
    ) {
        throw failure();
    }
    let handle: FileHandle | undefined;
    try {
        handle = await open(paths.stateDirectory, directoryFlags);
        const [held, named, canonical] = await Promise.all([
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
            named.dev !== held.dev ||
            named.ino !== held.ino
        ) {
            throw failure();
        }
        return { handle, identity: { dev: held.dev, ino: held.ino } };
    } catch {
        await closeHandle(handle);
        throw failure();
    }
}

async function readOwnerFile(
    stateHandle: FileHandle,
    stateDevice: bigint,
    hooks: ProductionDeliveryExecutorOwnerStateTestHooks = {}
): Promise<Pick<ProductionDeliveryExecutorOwnerState, "fileIdentity" | "owner">> {
    const ownerFile = path.join(`/proc/self/fd/${stateHandle.fd}`, ownerFileName);
    let handle: FileHandle | undefined;
    let result:
        | Pick<ProductionDeliveryExecutorOwnerState, "fileIdentity" | "owner">
        | undefined;
    let missing = false;
    let failed = false;
    try {
        try {
            handle = await open(ownerFile, readFlags);
        } catch (error) {
            if (errorCode(error) === "ENOENT") {
                missing = true;
            } else {
                throw failure();
            }
        }
        if (!handle) return Object.freeze({});
        const before = snapshotFile(await handle.stat({ bigint: true }), stateDevice);
        const bytes = await handle.readFile();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const owner = parseProductionDeliveryExecutorOwner(JSON.parse(text) as unknown);
        await hooks.afterRead?.();
        const [heldAfter, namedAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(ownerFile, { bigint: true }),
        ]);
        const after = snapshotFile(heldAfter, stateDevice);
        const named = snapshotFile(namedAfter, stateDevice);
        if (!sameFile(before, after) || !sameFile(before, named)) throw failure();
        result = Object.freeze({ fileIdentity: named, owner });
    } catch {
        failed = true;
    }
    if (!(await closeHandle(handle))) failed = true;
    if (failed || (!missing && result === undefined)) throw failure();
    return result ?? Object.freeze({});
}

function stateMatches(
    actual: Pick<ProductionDeliveryExecutorOwnerState, "fileIdentity" | "owner">,
    expected: ProductionDeliveryExecutorOwnerState
): boolean {
    return (
        JSON.stringify(actual.owner) === JSON.stringify(expected.owner) &&
        (actual.fileIdentity === undefined) === (expected.fileIdentity === undefined) &&
        (actual.fileIdentity === undefined ||
            expected.fileIdentity === undefined ||
            sameFile(actual.fileIdentity, expected.fileIdentity))
    );
}

async function commitOwner(
    stateHandle: FileHandle,
    stateDevice: bigint,
    owner: ProductionDeliveryExecutorOwner
): Promise<void> {
    const descriptorRoot = `/proc/self/fd/${stateHandle.fd}`;
    const stageName = `.delivery-executor-owner-${owner.transitionId}.json`;
    const stageFile = path.join(descriptorRoot, stageName);
    const ownerFile = path.join(descriptorRoot, ownerFileName);
    let handle: FileHandle | undefined;
    let stageOwned = false;
    let failed = false;
    try {
        await removeStalePrivateStateStage({
            directoryHandle: stateHandle,
            expectedDevice: stateDevice,
            maximumBytes: maximumOwnerBytes,
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
            serializeProductionDeliveryExecutorOwner(owner)
        );
        if (bytes.byteLength > maximumOwnerBytes) throw failure();
        await handle.writeFile(bytes);
        await handle.sync();
        const staged = snapshotFile(await handle.stat({ bigint: true }), stateDevice);
        await rename(stageFile, ownerFile);
        stageOwned = false;
        await stateHandle.sync();
        const [heldAfter, namedAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(ownerFile, { bigint: true }),
        ]);
        if (
            !sameFileAcrossRename(staged, snapshotFile(heldAfter, stateDevice)) ||
            !sameFile(
                snapshotFile(heldAfter, stateDevice),
                snapshotFile(namedAfter, stateDevice)
            )
        ) {
            throw failure();
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
    if (!(await closeHandle(handle))) failed = true;
    if (failed) throw failure();
}

/**
 * Reads the durable executor generation that owns recovery for one active transition.
 * @returns Stable absent or present compare-and-swap state.
 */
export async function loadProductionDeliveryExecutorOwnerState(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    hooks: ProductionDeliveryExecutorOwnerStateTestHooks = {}
): Promise<ProductionDeliveryExecutorOwnerState> {
    const state = await openStateDirectory(lease, paths);
    let result: ProductionDeliveryExecutorOwnerState | undefined;
    try {
        const observed = await readOwnerFile(state.handle, state.identity.dev, hooks);
        result = Object.freeze({
            [ownerStateBrand]: true as const,
            ...observed,
            stateDirectory: paths.stateDirectory,
        });
    } finally {
        if (!(await closeHandle(state.handle))) result = undefined;
    }
    if (!result) throw failure();
    return result;
}

/**
 * Atomically initializes or transfers recovery ownership with exact compare-and-swap.
 * @returns Newly loaded authoritative owner state.
 */
export async function commitProductionDeliveryExecutorOwner(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionDeliveryExecutorOwnerState,
    untrustedNext: ProductionDeliveryExecutorOwner
): Promise<ProductionDeliveryExecutorOwnerState> {
    const next = parseProductionDeliveryExecutorOwner(untrustedNext);
    if (
        expected[ownerStateBrand] !== true ||
        expected.stateDirectory !== paths.stateDirectory ||
        (expected.owner !== undefined &&
            expected.owner.transitionId !== next.transitionId)
    ) {
        throw failure();
    }
    const state = await openStateDirectory(lease, paths);
    let committed: ProductionDeliveryExecutorOwnerState | undefined;
    let failed = false;
    try {
        const actual = await readOwnerFile(state.handle, state.identity.dev);
        if (!stateMatches(actual, expected)) throw failure();
        await commitOwner(state.handle, state.identity.dev, next);
        const observed = await readOwnerFile(state.handle, state.identity.dev);
        if (JSON.stringify(observed.owner) !== JSON.stringify(next)) throw failure();
        committed = Object.freeze({
            [ownerStateBrand]: true as const,
            ...observed,
            stateDirectory: paths.stateDirectory,
        });
    } catch {
        failed = true;
    }
    if (!(await closeHandle(state.handle))) failed = true;
    if (failed || !committed) throw failure();
    return committed;
}

/**
 * Removes the exact terminal transition owner with compare-and-swap semantics.
 * @returns Completion after durable absence has been verified.
 */
export async function clearProductionDeliveryExecutorOwner(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionDeliveryExecutorOwnerState
): Promise<void> {
    if (
        expected[ownerStateBrand] !== true ||
        expected.stateDirectory !== paths.stateDirectory ||
        expected.owner === undefined ||
        expected.fileIdentity === undefined
    ) {
        throw failure();
    }
    const state = await openStateDirectory(lease, paths);
    let failed = false;
    try {
        const actual = await readOwnerFile(state.handle, state.identity.dev);
        if (!stateMatches(actual, expected)) throw failure();
        await unlink(path.join(`/proc/self/fd/${state.handle.fd}`, ownerFileName));
        await state.handle.sync();
        const observed = await readOwnerFile(state.handle, state.identity.dev);
        if (observed.owner !== undefined || observed.fileIdentity !== undefined) {
            throw failure();
        }
    } catch {
        failed = true;
    }
    if (!(await closeHandle(state.handle))) failed = true;
    if (failed) throw failure();
}
