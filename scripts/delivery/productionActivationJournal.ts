import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
    parseProductionActivationTransition,
    serializeProductionActivationTransition,
    type ProductionActivationPreviousDatabase,
    type ProductionActivationTransition,
} from "../../src/shared/productionActivationTransition.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import { removeStalePrivateStateStage } from "./privateStateStageFile.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";

const activationJournalFailureMessage = "Production activation journal update failed";
const journalFileName = "activation-transition.json";
const maximumJournalBytes = 128 * 1024;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface OpenedStateDirectory {
    readonly device: bigint;
    readonly handle: FileHandle;
}

/** Deterministic post-read boundary used only by adversarial tests. */
export interface ProductionActivationJournalTestHooks {
    readonly afterRead?: () => Promise<void> | void;
}

function journalFailure(): Error {
    return new Error(activationJournalFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function validJournalFile(status: BigIntStats, stateDevice: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === stateDevice &&
        (status.mode & 0o7777n) === 0o600n &&
        status.size > 0n &&
        status.size <= BigInt(maximumJournalBytes)
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
): Promise<OpenedStateDirectory> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        lease.stateDirectory !== paths.stateDirectory
    ) {
        throw journalFailure();
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
            throw journalFailure();
        }
        return Object.freeze({ device: held.dev, handle });
    } catch {
        await closeHandle(handle);
        throw journalFailure();
    }
}

async function readJournal(
    state: OpenedStateDirectory,
    testHooks: ProductionActivationJournalTestHooks = {}
): Promise<ProductionActivationTransition | undefined> {
    const journalFile = path.join(`/proc/self/fd/${state.handle.fd}`, journalFileName);
    let handle: FileHandle | undefined;
    let result: ProductionActivationTransition | undefined;
    let missing = false;
    let closed: boolean;
    try {
        handle = await open(journalFile, readFlags);
        const heldBefore = await handle.stat({ bigint: true });
        if (!validJournalFile(heldBefore, state.device)) {
            throw journalFailure();
        }
        const text = await handle.readFile("utf8");
        const value: unknown = JSON.parse(text);
        result = parseProductionActivationTransition(value);
        await testHooks.afterRead?.();
        const [heldAfter, pathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(journalFile, { bigint: true }),
        ]);
        if (
            heldAfter.dev !== heldBefore.dev ||
            heldAfter.ino !== heldBefore.ino ||
            heldAfter.ctimeNs !== heldBefore.ctimeNs ||
            heldAfter.mtimeNs !== heldBefore.mtimeNs ||
            heldAfter.size !== heldBefore.size ||
            !validJournalFile(pathAfter, state.device) ||
            pathAfter.dev !== heldBefore.dev ||
            pathAfter.ino !== heldBefore.ino ||
            pathAfter.ctimeNs !== heldBefore.ctimeNs ||
            pathAfter.mtimeNs !== heldBefore.mtimeNs ||
            pathAfter.size !== heldBefore.size
        ) {
            throw journalFailure();
        }
    } catch (error) {
        if (!handle && errorCode(error) === "ENOENT") {
            missing = true;
        } else {
            throw journalFailure();
        }
    } finally {
        closed = await closeHandle(handle);
    }
    if (!closed) throw journalFailure();
    return missing ? undefined : result;
}

async function writeJournalStage(
    stageFile: string,
    transition: ProductionActivationTransition
): Promise<void> {
    let handle: FileHandle | undefined;
    let failed = false;
    try {
        handle = await open(
            stageFile,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_WRONLY,
            0o600
        );
        const bytes = new TextEncoder().encode(
            serializeProductionActivationTransition(transition)
        );
        if (bytes.byteLength > maximumJournalBytes) throw journalFailure();
        await handle.writeFile(bytes);
        await handle.sync();
        const status = await handle.stat({ bigint: true });
        if (!validJournalFile(status, status.dev)) throw journalFailure();
    } catch {
        failed = true;
    }
    const closed = await closeHandle(handle);
    if (failed || !closed) throw journalFailure();
}

async function replaceJournal(
    state: OpenedStateDirectory,
    expected: ProductionActivationTransition | undefined,
    next: ProductionActivationTransition
): Promise<void> {
    const actual = await readJournal(state);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw journalFailure();
    const descriptorRoot = `/proc/self/fd/${state.handle.fd}`;
    const stageFile = path.join(
        descriptorRoot,
        `.activation-transition-${next.transitionId}.json`
    );
    const stageName = path.basename(stageFile);
    const finalFile = path.join(descriptorRoot, journalFileName);
    let stageOwned = false;
    try {
        await removeStalePrivateStateStage({
            directoryHandle: state.handle,
            expectedDevice: state.device,
            maximumBytes: maximumJournalBytes,
            stageName,
        });
        await writeJournalStage(stageFile, next);
        stageOwned = true;
        await rename(stageFile, finalFile);
        stageOwned = false;
        await state.handle.sync();
        const stored = await readJournal(state);
        if (JSON.stringify(stored) !== JSON.stringify(next)) throw journalFailure();
    } catch {
        if (stageOwned) {
            try {
                await unlink(stageFile);
            } catch {
                // Preserve the fixed journal failure and bounded private evidence.
            }
        }
        throw journalFailure();
    }
}

/**
 * Loads the durable activation recovery journal under the deployment lease.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @returns Parsed journal, or undefined when no transition is active.
 */
export async function loadProductionActivationJournal(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    testHooks: ProductionActivationJournalTestHooks = {}
): Promise<ProductionActivationTransition | undefined> {
    const state = await openStateDirectory(lease, paths);
    let journal: ProductionActivationTransition | undefined;
    let failed = false;
    try {
        journal = await readJournal(state, testHooks);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) throw journalFailure();
    return journal;
}

/**
 * Records activation intent before any active service can be stopped.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param untrustedTransition Verified candidate and prior activation identity.
 * @returns Parsed durable service-stop-requested journal.
 */
export async function createProductionActivationJournal(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    untrustedTransition: ProductionActivationTransition
): Promise<Extract<ProductionActivationTransition, { phase: "service-stop-requested" }>> {
    const transition = parseProductionActivationTransition(untrustedTransition);
    if (transition.phase !== "service-stop-requested") throw journalFailure();
    const state = await openStateDirectory(lease, paths);
    let failed = false;
    try {
        await replaceJournal(state, undefined, transition);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) throw journalFailure();
    return transition;
}

/**
 * Records the exact stopped-writer database snapshot before candidate preparation.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Durable service-stop-requested journal.
 * @param untrustedPreviousDatabase Verified absent state or immutable snapshot identity.
 * @returns Durable prepared journal paired with the pre-activation database.
 */
export async function markProductionSnapshotPrepared(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionActivationTransition,
    untrustedPreviousDatabase: ProductionActivationPreviousDatabase
): Promise<Extract<ProductionActivationTransition, { phase: "prepared" }>> {
    if (expected.phase !== "service-stop-requested") throw journalFailure();
    const next = parseProductionActivationTransition({
        ...expected,
        phase: "prepared",
        previousDatabase: untrustedPreviousDatabase,
    });
    if (next.phase !== "prepared") throw journalFailure();
    const state = await openStateDirectory(lease, paths);
    let failed = false;
    try {
        await replaceJournal(state, expected, next);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) throw journalFailure();
    return next;
}

/**
 * Advances the recovery journal after atomic database promotion.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Durable prepared journal.
 * @returns Durable database-promoted journal.
 */
export async function markProductionDatabasePromoted(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionActivationTransition
): Promise<Extract<ProductionActivationTransition, { phase: "database-promoted" }>> {
    if (expected.phase !== "prepared") throw journalFailure();
    const next = parseProductionActivationTransition({
        ...expected,
        phase: "database-promoted",
    });
    if (next.phase !== "database-promoted") throw journalFailure();
    const state = await openStateDirectory(lease, paths);
    let failed = false;
    try {
        await replaceJournal(state, expected, next);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) throw journalFailure();
    return next;
}

/**
 * Durably records that a committed candidate failed to become ready and must roll back.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Durable database-promoted journal.
 * @returns Durable rollback-required journal.
 */
export async function markProductionRollbackRequired(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionActivationTransition
): Promise<Extract<ProductionActivationTransition, { phase: "rollback-required" }>> {
    if (expected.phase !== "database-promoted") throw journalFailure();
    const next = parseProductionActivationTransition({
        ...expected,
        phase: "rollback-required",
    });
    if (next.phase !== "rollback-required") throw journalFailure();
    const state = await openStateDirectory(lease, paths);
    let failed = false;
    try {
        await replaceJournal(state, expected, next);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) throw journalFailure();
    return next;
}

/**
 * Deletes the exact completed or rolled-back journal and fsyncs state.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param expected Exact journal being finalized.
 * @returns Completion after the journal entry is absent.
 */
export async function clearProductionActivationJournal(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionActivationTransition
): Promise<void> {
    const state = await openStateDirectory(lease, paths);
    let failed = false;
    try {
        const actual = await readJournal(state);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw journalFailure();
        await unlink(path.join(`/proc/self/fd/${state.handle.fd}`, journalFileName));
        await state.handle.sync();
        if ((await readJournal(state)) !== undefined) {
            throw journalFailure();
        }
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) throw journalFailure();
}
