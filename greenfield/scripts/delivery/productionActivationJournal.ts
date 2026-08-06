import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
    parseProductionActivationTransition,
    serializeProductionActivationTransition,
    type ProductionActivationTransition,
} from "../../src/shared/productionActivationTransition.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
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
        const before = await lstat(paths.stateDirectory, { bigint: true });
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
            before.dev !== held.dev ||
            before.ino !== held.ino ||
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
    state: OpenedStateDirectory
): Promise<ProductionActivationTransition | undefined> {
    const journalFile = path.join(`/proc/self/fd/${state.handle.fd}`, journalFileName);
    let handle: FileHandle | undefined;
    let result: ProductionActivationTransition | undefined;
    let missing = false;
    let closed: boolean;
    try {
        handle = await open(journalFile, readFlags);
        const before = await lstat(journalFile, { bigint: true });
        const heldBefore = await handle.stat({ bigint: true });
        if (
            !validJournalFile(before, state.device) ||
            !validJournalFile(heldBefore, state.device) ||
            before.dev !== heldBefore.dev ||
            before.ino !== heldBefore.ino ||
            before.ctimeNs !== heldBefore.ctimeNs ||
            before.mtimeNs !== heldBefore.mtimeNs ||
            before.size !== heldBefore.size
        ) {
            throw journalFailure();
        }
        const text = await handle.readFile("utf8");
        const value: unknown = JSON.parse(text);
        result = parseProductionActivationTransition(value);
        const heldAfter = await handle.stat({ bigint: true });
        if (
            heldAfter.dev !== heldBefore.dev ||
            heldAfter.ino !== heldBefore.ino ||
            heldAfter.ctimeNs !== heldBefore.ctimeNs ||
            heldAfter.mtimeNs !== heldBefore.mtimeNs ||
            heldAfter.size !== heldBefore.size
        ) {
            throw journalFailure();
        }
    } catch (error) {
        if (errorCode(error) === "ENOENT") {
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
    const finalFile = path.join(descriptorRoot, journalFileName);
    let stageOwned = false;
    try {
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
    paths: PreparedProductionDeliveryPaths
): Promise<ProductionActivationTransition | undefined> {
    const state = await openStateDirectory(lease, paths);
    let journal: ProductionActivationTransition | undefined;
    let failed = false;
    try {
        journal = await readJournal(state);
    } catch {
        failed = true;
    }
    const closed = await closeHandle(state.handle);
    if (failed || !closed) throw journalFailure();
    return journal;
}

/**
 * Creates the prepared recovery journal before database promotion.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param untrustedTransition Verified transition identity and snapshot pairing.
 * @returns Parsed durable prepared journal.
 */
export async function createProductionActivationJournal(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    untrustedTransition: ProductionActivationTransition
): Promise<ProductionActivationTransition> {
    const transition = parseProductionActivationTransition(untrustedTransition);
    if (transition.phase !== "prepared") throw journalFailure();
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
): Promise<ProductionActivationTransition> {
    if (expected.phase !== "prepared") throw journalFailure();
    const next = parseProductionActivationTransition({
        ...expected,
        phase: "database-promoted",
    });
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
