import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
    managedLogManifest,
    type ManagedArchiveTarget,
    type ManagedLogFileTarget,
    type ManagedLogManifest,
    validateManagedLogManifest,
} from "./managedLogManifest.ts";

const stateVersion = 1;
const stateMaximumBytes = 1024 * 1024;
const lockMaximumBytes = 512;
const staleLockAgeMs = 2 * 60 * 60 * 1000;
const archiveEntryMaximum = 4096;
const privateFileMode = 0o600;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const createFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;

export type ManagedLogTargetAction =
    | "compressed"
    | "deleted"
    | "error"
    | "missing"
    | "rotated"
    | "skipped";

export interface ManagedLogTargetResult {
    readonly action: ManagedLogTargetAction;
    readonly reason:
        | "archive-only"
        | "cadence"
        | "empty"
        | "invalid-source"
        | "missing"
        | "not-due"
        | "retention"
        | "size";
    readonly targetId: string;
}

export interface ManagedLogRotationSummary {
    readonly checkedTargets: number;
    readonly dryRun: boolean;
    readonly finishedAtMs: number;
    readonly ok: boolean;
    readonly results: readonly ManagedLogTargetResult[];
    readonly startedAtMs: number;
}

export interface ManagedLogRotationStatus {
    readonly lastRun?: Omit<ManagedLogRotationSummary, "results">;
    readonly observedAtMs: number;
    readonly policyId: "docker-managed";
    readonly targetCount: number;
}

interface ManagedLogRotationState {
    readonly files: Readonly<Record<string, { readonly lastRotatedAtMs: number }>>;
    readonly lastRun?: Omit<ManagedLogRotationSummary, "results">;
    readonly version: typeof stateVersion;
}

interface OpenedDirectory {
    readonly handle: FileHandle;
    readonly path: string;
}

interface OpenedFile {
    readonly directory: OpenedDirectory;
    readonly fileName: string;
    readonly handle: FileHandle;
    readonly status: Stats;
}

interface ArchiveEntry {
    readonly fileName: string;
    readonly modifiedAtMs: number;
}

interface RotationLock {
    readonly directory: OpenedDirectory;
    readonly fileName: string;
    readonly handle: FileHandle;
    readonly status: Stats;
}

export interface ManagedLogRotationEngine {
    readonly run: (options?: {
        readonly dryRun?: boolean;
        readonly signal?: AbortSignal;
    }) => Promise<ManagedLogRotationSummary>;
    readonly status: () => Promise<ManagedLogRotationStatus>;
}

function sanitizedFailure(): Error {
    return new Error("Managed log maintenance failed");
}

function isErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function ownerIsTrusted(ownerId: number, trustedOwnerIds: readonly number[]): boolean {
    return trustedOwnerIds.includes(ownerId);
}

function fileStatusIsTrusted(status: Stats, trustedOwnerIds: readonly number[]): boolean {
    return (
        status.isFile() &&
        status.nlink === 1 &&
        ownerIsTrusted(status.uid, trustedOwnerIds) &&
        (status.mode & 0o022) === 0 &&
        Number.isSafeInteger(status.size) &&
        status.size >= 0
    );
}

function directoryStatusIsTrusted(
    status: Stats,
    trustedOwnerIds: readonly number[]
): boolean {
    return (
        status.isDirectory() &&
        ownerIsTrusted(status.uid, trustedOwnerIds) &&
        (status.mode & 0o002) === 0
    );
}

function runtimeOwnerIds(): readonly number[] {
    const ownerId = typeof process.getuid === "function" ? process.getuid() : 0;
    return ownerId === 0 ? [0] : [0, ownerId];
}

async function openDirectory(
    directoryPath: string,
    trustedOwnerIds: readonly number[]
): Promise<OpenedDirectory> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(directoryPath, directoryFlags);
        const status = await handle.stat();
        if (
            !directoryStatusIsTrusted(status, trustedOwnerIds) ||
            (await realpath(directoryPath)) !== directoryPath
        ) {
            throw sanitizedFailure();
        }
        return { handle, path: directoryPath };
    } catch {
        await handle?.close().catch(() => {});
        throw sanitizedFailure();
    }
}

function descriptorChild(directory: OpenedDirectory, fileName: string): string {
    if (
        fileName.length === 0 ||
        fileName.length > 255 ||
        fileName.includes("/") ||
        fileName.includes("\0") ||
        fileName === "." ||
        fileName === ".."
    ) {
        throw sanitizedFailure();
    }
    return `/proc/self/fd/${directory.handle.fd}/${fileName}`;
}

async function openFileTarget(
    filePath: string,
    trustedOwnerIds: readonly number[],
    maximumBytes: number,
    writable = false
): Promise<OpenedFile | undefined> {
    const directory = await openDirectory(path.dirname(filePath), trustedOwnerIds);
    const fileName = path.basename(filePath);
    let handle: FileHandle | undefined;
    try {
        handle = await open(
            descriptorChild(directory, fileName),
            writable
                ? constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
                : readFlags
        );
        const status = await handle.stat();
        if (!fileStatusIsTrusted(status, trustedOwnerIds) || status.size > maximumBytes) {
            throw sanitizedFailure();
        }
        return { directory, fileName, handle, status };
    } catch (error) {
        await handle?.close().catch(() => {});
        await directory.handle.close().catch(() => {});
        if (isErrorCode(error, "ENOENT")) return undefined;
        throw sanitizedFailure();
    }
}

async function closeOpenedFile(file: OpenedFile | undefined): Promise<void> {
    await file?.handle.close().catch(() => {});
    await file?.directory.handle.close().catch(() => {});
}

async function readExactFile(file: OpenedFile): Promise<Buffer> {
    const output = Buffer.alloc(file.status.size);
    let offset = 0;
    while (offset < output.length) {
        const result = await file.handle.read(
            output,
            offset,
            output.length - offset,
            offset
        );
        if (result.bytesRead === 0) throw sanitizedFailure();
        offset += result.bytesRead;
    }
    return output;
}

async function writeExact(handle: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset
        );
        if (result.bytesWritten === 0) throw sanitizedFailure();
        offset += result.bytesWritten;
    }
}

async function verifyIdentity(file: OpenedFile): Promise<void> {
    const descriptorStatus = await file.handle.stat();
    const pathStatus = await lstat(descriptorChild(file.directory, file.fileName));
    if (
        descriptorStatus.dev !== file.status.dev ||
        descriptorStatus.ino !== file.status.ino ||
        descriptorStatus.size !== file.status.size ||
        pathStatus.dev !== file.status.dev ||
        pathStatus.ino !== file.status.ino ||
        !fileStatusIsTrusted(pathStatus, [file.status.uid])
    ) {
        throw sanitizedFailure();
    }
}

function archiveStamp(nowMs: number): string {
    return new Date(nowMs).toISOString().replaceAll(":", "-");
}

function archiveName(fileName: string, nowMs: number, compressed: boolean): string {
    return `${fileName}.${archiveStamp(nowMs)}.${randomUUID()}${compressed ? ".gz" : ""}`;
}

function stageName(): string {
    return `.mira-log-maintenance-${randomUUID()}.tmp`;
}

async function createStage(
    directory: OpenedDirectory,
    bytes: Uint8Array,
    mode: number
): Promise<{ readonly fileName: string; readonly handle: FileHandle }> {
    const fileName = stageName();
    let handle: FileHandle | undefined;
    try {
        handle = await open(
            descriptorChild(directory, fileName),
            createFlags,
            privateFileMode
        );
        await handle.chmod(mode & 0o755);
        await writeExact(handle, bytes);
        await handle.sync();
        return { fileName, handle };
    } catch {
        await handle?.close().catch(() => {});
        await unlink(descriptorChild(directory, fileName)).catch(() => {});
        throw sanitizedFailure();
    }
}

async function commitStage(
    directory: OpenedDirectory,
    stage: { readonly fileName: string; readonly handle: FileHandle },
    destinationName: string,
    replaceExisting = false
): Promise<void> {
    await stage.handle.close();
    try {
        if (replaceExisting) {
            await rename(
                descriptorChild(directory, stage.fileName),
                descriptorChild(directory, destinationName)
            );
        } else {
            await link(
                descriptorChild(directory, stage.fileName),
                descriptorChild(directory, destinationName)
            );
            await unlink(descriptorChild(directory, stage.fileName));
        }
        await directory.handle.sync();
    } catch {
        await unlink(descriptorChild(directory, stage.fileName)).catch(() => {});
        throw sanitizedFailure();
    }
}

async function copyTruncate(
    file: OpenedFile,
    target: ManagedLogFileTarget,
    nowMs: number
): Promise<void> {
    const source = await readExactFile(file);
    await verifyIdentity(file);
    const archiveBytes = target.compress ? gzipSync(source) : source;
    if (archiveBytes.byteLength > target.maximumSourceBytes + 1024 * 1024) {
        throw sanitizedFailure();
    }
    const destinationName = archiveName(file.fileName, nowMs, target.compress);
    const stage = await createStage(
        file.directory,
        archiveBytes,
        file.status.mode & 0o777
    );
    await verifyIdentity(file);
    await commitStage(file.directory, stage, destinationName);
    await verifyIdentity(file);
    await file.handle.truncate(0);
    await file.handle.sync();
}

async function rotateRename(
    file: OpenedFile,
    target: ManagedLogFileTarget,
    nowMs: number
): Promise<void> {
    const replacement = await createStage(
        file.directory,
        new Uint8Array(),
        file.status.mode & 0o777
    );
    const archiveFileName = archiveName(file.fileName, nowMs, false);
    try {
        await verifyIdentity(file);
        await rename(
            descriptorChild(file.directory, file.fileName),
            descriptorChild(file.directory, archiveFileName)
        );
        await commitStage(file.directory, replacement, file.fileName);
    } catch {
        await replacement.handle.close().catch(() => {});
        await unlink(descriptorChild(file.directory, replacement.fileName)).catch(
            () => {}
        );
        try {
            await rename(
                descriptorChild(file.directory, archiveFileName),
                descriptorChild(file.directory, file.fileName)
            );
        } catch {
            // A replacement appeared; never overwrite it during rollback.
        }
        throw sanitizedFailure();
    }
    if (target.compress) {
        await compressArchive(
            file.directory,
            archiveFileName,
            target.trustedOwnerIds,
            target.maximumSourceBytes
        );
    }
}

function escapeRegularExpression(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function rotatedArchivePattern(fileName: string): RegExp {
    return new RegExp(
        `^${escapeRegularExpression(fileName)}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.[0-9a-f-]{36}(?:\\.gz)?$`,
        "u"
    );
}

async function listDirectoryNames(
    directory: OpenedDirectory
): Promise<readonly string[]> {
    const stream = await opendir(`/proc/self/fd/${directory.handle.fd}`);
    const names: string[] = [];
    try {
        for await (const entry of stream) {
            names.push(entry.name);
            if (names.length > archiveEntryMaximum) throw sanitizedFailure();
        }
    } finally {
        await stream.close().catch(() => {});
    }
    return names;
}

async function trustedArchiveEntries(
    directory: OpenedDirectory,
    matches: (fileName: string) => boolean,
    trustedOwnerIds: readonly number[],
    maximumSourceBytes: number
): Promise<readonly ArchiveEntry[]> {
    const entries: ArchiveEntry[] = [];
    for (const fileName of await listDirectoryNames(directory)) {
        if (!matches(fileName)) continue;
        let handle: FileHandle | undefined;
        try {
            handle = await open(descriptorChild(directory, fileName), readFlags);
            const status = await handle.stat();
            if (
                !fileStatusIsTrusted(status, trustedOwnerIds) ||
                status.size > maximumSourceBytes
            ) {
                throw sanitizedFailure();
            }
            entries.push({ fileName, modifiedAtMs: Math.trunc(status.mtimeMs) });
        } finally {
            await handle?.close().catch(() => {});
        }
    }
    return entries;
}

async function applyRetention(
    directory: OpenedDirectory,
    matches: (fileName: string) => boolean,
    trustedOwnerIds: readonly number[],
    maximumSourceBytes: number,
    retentionCount: number,
    retentionAgeMs: number,
    nowMs: number,
    dryRun: boolean
): Promise<number> {
    const archiveEntries = await trustedArchiveEntries(
        directory,
        matches,
        trustedOwnerIds,
        maximumSourceBytes
    );
    const entries = archiveEntries.toSorted(
        (left, right) =>
            right.modifiedAtMs - left.modifiedAtMs ||
            right.fileName.localeCompare(left.fileName)
    );
    const expired = entries.filter(
        (entry, index) =>
            index >= retentionCount || nowMs - entry.modifiedAtMs > retentionAgeMs
    );
    if (!dryRun) {
        for (const entry of expired) {
            const verified = await openFileTarget(
                path.join(directory.path, entry.fileName),
                trustedOwnerIds,
                maximumSourceBytes
            );
            if (verified === undefined) continue;
            try {
                await verifyIdentity(verified);
                await unlink(descriptorChild(directory, entry.fileName));
            } finally {
                await closeOpenedFile(verified);
            }
        }
        if (expired.length > 0) await directory.handle.sync();
    }
    return expired.length;
}

async function compressArchive(
    directory: OpenedDirectory,
    fileName: string,
    trustedOwnerIds: readonly number[],
    maximumSourceBytes: number
): Promise<void> {
    const source = await openFileTarget(
        path.join(directory.path, fileName),
        trustedOwnerIds,
        maximumSourceBytes
    );
    if (source === undefined) return;
    try {
        const bytes = gzipSync(await readExactFile(source));
        await verifyIdentity(source);
        const stage = await createStage(directory, bytes, source.status.mode & 0o777);
        await commitStage(directory, stage, `${fileName}.gz`);
        await verifyIdentity(source);
        await unlink(descriptorChild(directory, fileName));
        await directory.handle.sync();
    } finally {
        await closeOpenedFile(source);
    }
}

async function processFileTarget(
    target: ManagedLogFileTarget,
    lastRotatedAtMs: number | undefined,
    nowMs: number,
    dryRun: boolean
): Promise<{
    readonly result: ManagedLogTargetResult;
    readonly rotated: boolean;
    readonly retentionDeleted: number;
}> {
    const file = await openFileTarget(
        target.filePath,
        target.trustedOwnerIds,
        target.maximumSourceBytes,
        true
    );
    if (file === undefined) {
        return {
            result: { action: "missing", reason: "missing", targetId: target.id },
            retentionDeleted: 0,
            rotated: false,
        };
    }
    try {
        const sizeDue = file.status.size >= target.maximumSizeBytes;
        const cadenceDue =
            target.cadenceMs !== undefined &&
            (lastRotatedAtMs === undefined ||
                nowMs - lastRotatedAtMs >= target.cadenceMs);
        const rotate = file.status.size > 0 && (sizeDue || cadenceDue);
        if (rotate && !dryRun) {
            await (target.strategy === "rename"
                ? rotateRename(file, target, nowMs)
                : copyTruncate(file, target, nowMs));
        }
        const deleted = await applyRetention(
            file.directory,
            (fileName) => rotatedArchivePattern(file.fileName).test(fileName),
            target.trustedOwnerIds,
            target.maximumSourceBytes + 1024 * 1024,
            target.retentionCount,
            target.retentionAgeMs,
            nowMs,
            dryRun
        );
        let reason: ManagedLogTargetResult["reason"] = "not-due";
        if (file.status.size === 0) reason = "empty";
        else if (sizeDue) reason = "size";
        else if (cadenceDue) reason = "cadence";
        return {
            result: {
                action: rotate ? "rotated" : "skipped",
                reason,
                targetId: target.id,
            },
            retentionDeleted: deleted,
            rotated: rotate,
        };
    } finally {
        await closeOpenedFile(file);
    }
}

const openClawDailyPattern = /^openclaw-\d{4}-\d{2}-\d{2}\.log(?:\.gz)?$/u;
const openClawUncompressedPattern = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/u;

async function processArchiveTarget(
    target: ManagedArchiveTarget,
    nowMs: number,
    dryRun: boolean
): Promise<readonly ManagedLogTargetResult[]> {
    const directory = await openDirectory(target.directoryPath, target.trustedOwnerIds);
    const results: ManagedLogTargetResult[] = [];
    try {
        const entries = await trustedArchiveEntries(
            directory,
            (fileName) =>
                target.kind === "openclaw-daily" && openClawDailyPattern.test(fileName),
            target.trustedOwnerIds,
            target.maximumSourceBytes
        );
        if (entries.length > target.maximumEntries) throw sanitizedFailure();
        for (const entry of entries) {
            if (
                !openClawUncompressedPattern.test(entry.fileName) ||
                nowMs - entry.modifiedAtMs < target.compressAfterMs
            ) {
                continue;
            }
            if (!dryRun) {
                await compressArchive(
                    directory,
                    entry.fileName,
                    target.trustedOwnerIds,
                    target.maximumSourceBytes
                );
            }
            results.push({
                action: "compressed",
                reason: "archive-only",
                targetId: target.id,
            });
        }
        const deleted = await applyRetention(
            directory,
            (fileName) => openClawDailyPattern.test(fileName),
            target.trustedOwnerIds,
            target.maximumSourceBytes + 1024 * 1024,
            target.retentionCount,
            target.retentionAgeMs,
            nowMs,
            dryRun
        );
        for (let index = 0; index < deleted; index += 1) {
            results.push({
                action: "deleted",
                reason: "retention",
                targetId: target.id,
            });
        }
        if (results.length === 0) {
            results.push({
                action: entries.length === 0 ? "missing" : "skipped",
                reason: entries.length === 0 ? "missing" : "not-due",
                targetId: target.id,
            });
        }
        return results;
    } finally {
        await directory.handle.close().catch(() => {});
    }
}

function emptyState(): ManagedLogRotationState {
    return { files: {}, version: stateVersion };
}

function stateIsValid(value: unknown): value is ManagedLogRotationState {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<ManagedLogRotationState>;
    if (candidate.version !== stateVersion || candidate.files === undefined) return false;
    if (candidate.files === null || typeof candidate.files !== "object") return false;
    return Object.entries(candidate.files).every(
        ([id, entry]) =>
            /^[a-z0-9][a-z0-9.-]{0,127}$/u.test(id) &&
            entry !== null &&
            typeof entry === "object" &&
            Number.isSafeInteger(
                (entry as { readonly lastRotatedAtMs?: unknown }).lastRotatedAtMs
            ) &&
            Number((entry as { readonly lastRotatedAtMs: unknown }).lastRotatedAtMs) >= 0
    );
}

async function readState(manifest: ManagedLogManifest): Promise<ManagedLogRotationState> {
    const trustedOwners = runtimeOwnerIds();
    let state: OpenedFile | undefined;
    try {
        state = await openFileTarget(
            manifest.statePath,
            trustedOwners,
            stateMaximumBytes
        );
        if (state === undefined) return emptyState();
        if ((state.status.mode & 0o777) !== privateFileMode) throw sanitizedFailure();
        const stateBytes = await readExactFile(state);
        const parsed = JSON.parse(stateBytes.toString("utf8")) as unknown;
        if (!stateIsValid(parsed)) throw sanitizedFailure();
        return parsed;
    } catch {
        throw sanitizedFailure();
    } finally {
        await closeOpenedFile(state);
    }
}

async function writeState(
    manifest: ManagedLogManifest,
    state: ManagedLogRotationState
): Promise<void> {
    const directory = await openDirectory(
        path.dirname(manifest.statePath),
        runtimeOwnerIds()
    );
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    if (bytes.byteLength > stateMaximumBytes) {
        await directory.handle.close();
        throw sanitizedFailure();
    }
    try {
        const stage = await createStage(directory, bytes, privateFileMode);
        await commitStage(directory, stage, path.basename(manifest.statePath), true);
    } finally {
        await directory.handle.close().catch(() => {});
    }
}

function processIsRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return isErrorCode(error, "EPERM");
    }
}

async function acquireLock(
    manifest: ManagedLogManifest,
    nowMs: number
): Promise<RotationLock> {
    const directory = await openDirectory(
        path.dirname(manifest.lockPath),
        runtimeOwnerIds()
    );
    const fileName = path.basename(manifest.lockPath);
    const attempt = async (): Promise<RotationLock> => {
        const handle = await open(
            descriptorChild(directory, fileName),
            createFlags,
            privateFileMode
        );
        await writeExact(
            handle,
            Buffer.from(JSON.stringify({ pid: process.pid, startedAtMs: nowMs }), "utf8")
        );
        await handle.sync();
        await directory.handle.sync();
        return { directory, fileName, handle, status: await handle.stat() };
    };
    try {
        return await attempt();
    } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
            await directory.handle.close().catch(() => {});
            throw sanitizedFailure();
        }
    }

    let existing: FileHandle | undefined;
    try {
        existing = await open(descriptorChild(directory, fileName), readFlags);
        const status = await existing.stat();
        if (
            !fileStatusIsTrusted(status, runtimeOwnerIds()) ||
            (status.mode & 0o777) !== privateFileMode ||
            status.size > lockMaximumBytes
        ) {
            throw sanitizedFailure();
        }
        const lockBytes = await readExactFile({
            directory,
            fileName,
            handle: existing,
            status,
        });
        const parsed = JSON.parse(lockBytes.toString("utf8")) as {
            readonly pid?: unknown;
            readonly startedAtMs?: unknown;
        };
        const pid = Number(parsed.pid);
        const startedAtMs = Number(parsed.startedAtMs);
        const stale =
            Number.isSafeInteger(startedAtMs) &&
            nowMs - startedAtMs >= staleLockAgeMs &&
            (!Number.isSafeInteger(pid) || pid <= 0 || !processIsRunning(pid));
        if (!stale) throw sanitizedFailure();
        const pathStatus = await lstat(descriptorChild(directory, fileName));
        if (pathStatus.dev !== status.dev || pathStatus.ino !== status.ino) {
            throw sanitizedFailure();
        }
        await existing.close();
        existing = undefined;
        await unlink(descriptorChild(directory, fileName));
        await directory.handle.sync();
        return await attempt();
    } catch {
        await existing?.close().catch(() => {});
        await directory.handle.close().catch(() => {});
        throw sanitizedFailure();
    }
}

async function releaseLock(lock: RotationLock): Promise<void> {
    try {
        const current = await lstat(descriptorChild(lock.directory, lock.fileName));
        if (current.dev === lock.status.dev && current.ino === lock.status.ino) {
            await unlink(descriptorChild(lock.directory, lock.fileName));
            await lock.directory.handle.sync();
        }
    } finally {
        await lock.handle.close().catch(() => {});
        await lock.directory.handle.close().catch(() => {});
    }
}

/**
 * Creates the worker-only custom rotation engine for the reviewed application manifest.
 * @param options Fixed manifest and replaceable clock used by worker composition.
 * @returns Bounded status and execution operations with no dynamic path input.
 */
export function createManagedLogRotationEngine(
    options: {
        readonly manifest?: ManagedLogManifest;
        readonly now?: () => number;
    } = {}
): ManagedLogRotationEngine {
    const manifest = options.manifest ?? managedLogManifest;
    const now = options.now ?? Date.now;
    validateManagedLogManifest(manifest);

    const engine: ManagedLogRotationEngine = {
        async run(runOptions = {}) {
            const startedAtMs = now();
            const dryRun = runOptions.dryRun ?? false;
            const state = await readState(manifest);
            const lock = dryRun ? undefined : await acquireLock(manifest, startedAtMs);
            const results: ManagedLogTargetResult[] = [];
            const files = { ...state.files };
            try {
                for (const target of manifest.fileTargets) {
                    if (runOptions.signal?.aborted === true) throw sanitizedFailure();
                    try {
                        const outcome = await processFileTarget(
                            target,
                            files[target.id]?.lastRotatedAtMs,
                            startedAtMs,
                            dryRun
                        );
                        results.push(outcome.result);
                        for (
                            let index = 0;
                            index < outcome.retentionDeleted;
                            index += 1
                        ) {
                            results.push({
                                action: "deleted",
                                reason: "retention",
                                targetId: target.id,
                            });
                        }
                        if (outcome.rotated && !dryRun) {
                            files[target.id] = { lastRotatedAtMs: startedAtMs };
                        }
                    } catch {
                        results.push({
                            action: "error",
                            reason: "invalid-source",
                            targetId: target.id,
                        });
                    }
                }
                for (const target of manifest.archiveTargets) {
                    if (runOptions.signal?.aborted === true) throw sanitizedFailure();
                    try {
                        results.push(
                            ...(await processArchiveTarget(target, startedAtMs, dryRun))
                        );
                    } catch {
                        results.push({
                            action: "error",
                            reason: "invalid-source",
                            targetId: target.id,
                        });
                    }
                }
                const finishedAtMs = now();
                const summary: ManagedLogRotationSummary = Object.freeze({
                    checkedTargets:
                        manifest.fileTargets.length + manifest.archiveTargets.length,
                    dryRun,
                    finishedAtMs,
                    ok: results.every(({ action }) => action !== "error"),
                    results: Object.freeze(results),
                    startedAtMs,
                });
                if (!dryRun) {
                    await writeState(manifest, {
                        files,
                        lastRun: {
                            checkedTargets: summary.checkedTargets,
                            dryRun: false,
                            finishedAtMs,
                            ok: summary.ok,
                            startedAtMs,
                        },
                        version: stateVersion,
                    });
                }
                return summary;
            } finally {
                if (lock !== undefined) await releaseLock(lock);
            }
        },
        async status() {
            const state = await readState(manifest);
            return Object.freeze({
                ...(state.lastRun === undefined ? {} : { lastRun: state.lastRun }),
                observedAtMs: now(),
                policyId: "docker-managed" as const,
                targetCount: manifest.fileTargets.length + manifest.archiveTargets.length,
            });
        },
    };
    return Object.freeze(engine);
}
