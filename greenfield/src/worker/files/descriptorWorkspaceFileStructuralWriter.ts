import { createHash, timingSafeEqual } from "node:crypto";
import Fs from "node:fs";
import Path from "node:path";

import { workspaceFileLimits } from "../../contracts/files.ts";
import {
    linuxRenameExchange,
    linuxRenameNoReplace,
    type LinuxRenameExchange,
    type LinuxRenameNoReplace,
} from "./linuxRenameExchange.ts";
import {
    createWorkspaceFileReplaceIntent,
    readWorkspaceFileReplaceIntent,
    removeWorkspaceFileReplaceIntent,
    settleWorkspaceFileReplaceIntent,
    type LoadedWorkspaceFileReplaceIntent,
    type WorkspaceFileReplaceFingerprint,
    type WorkspaceFileReplaceIntent,
    type WorkspaceFileReplaceIntentStore,
    type WorkspaceFileReplaceStageIdentity,
} from "./workspaceFileReplaceIntent.ts";

const uuidV4Pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const mimeTypePattern =
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;
const rootIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const visibleDotNames: ReadonlySet<string> = new Set([
    ".env.example",
    ".environment.example",
]);
const copyChunkBytes = 64 * 1024;

export type WorkspaceFileStructuralWriteErrorReason =
    | "access-denied"
    | "conflict"
    | "invalid-input"
    | "not-found"
    | "too-large"
    | "unavailable";

/** Sanitized worker failure; host paths and filesystem diagnostics stay in the cause. */
export class WorkspaceFileStructuralWriteError extends Error {
    public readonly reason: WorkspaceFileStructuralWriteErrorReason;

    public constructor(reason: WorkspaceFileStructuralWriteErrorReason, cause?: unknown) {
        super(
            "Workspace file structural write failed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "WorkspaceFileStructuralWriteError";
        this.reason = reason;
    }
}

/** Serializable durable job payload mirrored by the server-side scheduler port. */
export interface WorkerWorkspaceFileWriteCommand {
    readonly expectedRevision?: string;
    readonly fileName: string;
    readonly locator: {
        readonly rootId: string;
        readonly segments: readonly string[];
    };
    readonly mimeType: string;
    readonly operation: "create" | "replace";
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly spoolId: string;
    readonly ticketId: string;
}

export interface WorkerWorkspaceFileRootConfiguration {
    readonly id: string;
    readonly path: string;
    readonly writable: boolean;
}

export interface DescriptorWorkspaceFileStructuralWriterOptions {
    readonly renameExchange?: LinuxRenameExchange;
    readonly renameNoReplace?: LinuxRenameNoReplace;
    readonly roots: readonly WorkerWorkspaceFileRootConfiguration[];
    readonly spoolRoot: string;
}

export interface DescriptorWorkspaceFileStructuralWriter {
    readonly apply: (
        command: WorkerWorkspaceFileWriteCommand,
        signal?: AbortSignal
    ) => Promise<{
        readonly modifiedAtMs: number;
        readonly revision: string;
        readonly sizeBytes: number;
    }>;
    readonly dispose: () => void;
    readonly removeSettledReplacementIntent: (
        command: WorkerWorkspaceFileWriteCommand
    ) => Promise<void>;
}

interface OpenRoot extends WorkerWorkspaceFileRootConfiguration {
    readonly device: bigint;
    readonly fd: number;
}

interface OpenDirectory {
    readonly close: () => Promise<void>;
    readonly fd: number;
    readonly root: OpenRoot;
}

interface OpenSpool {
    readonly handle: Fs.promises.FileHandle;
    readonly stat: Fs.BigIntStats;
}

interface HashedChild {
    readonly handle: Fs.promises.FileHandle;
    readonly sha256: string;
    readonly stat: Fs.BigIntStats;
}

type OpenReplacement = HashedChild;

function failure(
    reason: WorkspaceFileStructuralWriteErrorReason,
    cause?: unknown
): WorkspaceFileStructuralWriteError {
    return cause instanceof WorkspaceFileStructuralWriteError
        ? cause
        : new WorkspaceFileStructuralWriteError(reason, cause);
}

function classifiedFailure(error: unknown): WorkspaceFileStructuralWriteError {
    if (error instanceof WorkspaceFileStructuralWriteError) return error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return failure("not-found", error);
    if (code === "EEXIST") return failure("conflict", error);
    if (code === "EACCES" || code === "ELOOP" || code === "EPERM") {
        return failure("access-denied", error);
    }
    return failure("unavailable", error);
}

function abortIfRequested(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw (
            signal.reason ??
            new DOMException("Workspace file write aborted", "AbortError")
        );
    }
}

function runtimeOwnerId(): bigint {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw new TypeError("Workspace file structural writer requires Linux");
    }
    return BigInt(process.getuid());
}

function requiredDirectoryPath(value: string, label: string): string {
    if (!Path.isAbsolute(value) || value !== Path.normalize(value)) {
        throw new TypeError(`${label} must be an absolute normalized path`);
    }
    const resolved = Path.resolve(value);
    if (resolved === Path.parse(resolved).root) {
        throw new TypeError(`${label} cannot be a filesystem root`);
    }
    const canonical = Fs.realpathSync(resolved);
    if (canonical !== resolved || Fs.lstatSync(resolved).isSymbolicLink()) {
        throw new TypeError(`${label} must be canonical and non-symbolic`);
    }
    return resolved;
}

function isVisibleSegment(segment: string): boolean {
    return (
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("/") &&
        !segment.includes("\\") &&
        !segment.includes("\0") &&
        !/[\p{Cc}\p{Cf}]/u.test(segment) &&
        (!segment.startsWith(".") || visibleDotNames.has(segment)) &&
        new TextEncoder().encode(segment).byteLength <=
            workspaceFileLimits.maximumFileNameBytes
    );
}

function anchoredChild(fd: number, childName: string): string {
    return `/proc/self/fd/${fd}/${childName}`;
}

function stageName(spoolId: string): string {
    return `.mira-files-${spoolId}.stage`;
}

function spoolName(spoolId: string): string {
    return `${spoolId}.upload`;
}

function validateCommand(
    command: WorkerWorkspaceFileWriteCommand,
    roots: ReadonlyMap<string, OpenRoot>
): OpenRoot {
    if (typeof command !== "object" || command === null) {
        throw failure("invalid-input");
    }
    const locator = command.locator;
    if (
        typeof locator !== "object" ||
        locator === null ||
        typeof locator.rootId !== "string" ||
        !Array.isArray(locator.segments)
    ) {
        throw failure("invalid-input");
    }
    const root = roots.get(locator.rootId);
    if (
        root === undefined ||
        !root.writable ||
        (command.operation !== "create" && command.operation !== "replace") ||
        typeof command.spoolId !== "string" ||
        !uuidV4Pattern.test(command.spoolId) ||
        typeof command.ticketId !== "string" ||
        !uuidV4Pattern.test(command.ticketId) ||
        typeof command.sha256 !== "string" ||
        !sha256Pattern.test(command.sha256) ||
        typeof command.fileName !== "string" ||
        !isVisibleSegment(command.fileName) ||
        typeof command.mimeType !== "string" ||
        !mimeTypePattern.test(command.mimeType) ||
        locator.segments.length > 256 ||
        locator.segments.some(
            (segment) => typeof segment !== "string" || !isVisibleSegment(segment)
        ) ||
        !Number.isSafeInteger(command.sizeBytes) ||
        command.sizeBytes < 0 ||
        command.sizeBytes > workspaceFileLimits.maximumUploadBytes
    ) {
        throw failure("invalid-input");
    }
    if (
        (command.operation === "create" && command.expectedRevision !== undefined) ||
        (command.operation === "replace" &&
            (typeof command.expectedRevision !== "string" ||
                !sha256Pattern.test(command.expectedRevision) ||
                command.locator.segments.length === 0 ||
                command.locator.segments.at(-1) !== command.fileName))
    ) {
        throw failure("invalid-input");
    }
    return root;
}

async function openDirectory(
    root: OpenRoot,
    segments: readonly string[]
): Promise<OpenDirectory> {
    const handles: Fs.promises.FileHandle[] = [];
    let parentFd = root.fd;
    try {
        for (const segment of segments) {
            const handle = await Fs.promises.open(
                anchoredChild(parentFd, segment),
                Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW
            );
            const stat = await handle.stat({ bigint: true });
            if (!stat.isDirectory() || stat.dev !== root.device) {
                throw failure("access-denied");
            }
            handles.push(handle);
            parentFd = handle.fd;
        }
        return {
            close: async () => {
                await Promise.allSettled(
                    handles.toReversed().map((handle) => handle.close())
                );
            },
            fd: parentFd,
            root,
        };
    } catch (error) {
        await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
        throw classifiedFailure(error);
    }
}

function privateSpoolFile(
    stat: Fs.BigIntStats,
    ownerId: bigint,
    spoolDevice: bigint
): boolean {
    return (
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.uid === ownerId &&
        stat.dev === spoolDevice &&
        (stat.mode & 0o777n) === 0o600n
    );
}

async function openSpool(
    spoolFd: number,
    spoolDevice: bigint,
    ownerId: bigint,
    command: WorkerWorkspaceFileWriteCommand
): Promise<OpenSpool> {
    let handle: Fs.promises.FileHandle | undefined;
    try {
        handle = await Fs.promises.open(
            anchoredChild(spoolFd, spoolName(command.spoolId)),
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const stat = await handle.stat({ bigint: true });
        if (
            !privateSpoolFile(stat, ownerId, spoolDevice) ||
            stat.size !== BigInt(command.sizeBytes)
        ) {
            throw failure("access-denied");
        }
        return { handle, stat };
    } catch (error) {
        await handle?.close().catch(() => {});
        throw classifiedFailure(error);
    }
}

function sameFileIdentity(left: Fs.BigIntStats, right: Fs.BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function sameStableIdentity(left: Fs.BigIntStats, right: Fs.BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.uid === right.uid &&
        left.gid === right.gid &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs
    );
}

function sameDigest(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, "hex");
    const rightBytes = Buffer.from(right, "hex");
    return (
        leftBytes.byteLength === rightBytes.byteLength &&
        timingSafeEqual(leftBytes, rightBytes)
    );
}

async function hashOpenFile(
    handle: Fs.promises.FileHandle,
    expected: Fs.BigIntStats,
    maximumBytes: number,
    signal?: AbortSignal
): Promise<string> {
    const sizeBytes = Number(expected.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maximumBytes) {
        throw failure("too-large");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(copyChunkBytes, Math.max(sizeBytes, 1)));
    let offset = 0;
    while (offset < sizeBytes) {
        abortIfRequested(signal);
        const requested = Math.min(buffer.byteLength, sizeBytes - offset);
        const { bytesRead } = await handle.read(buffer, 0, requested, offset);
        if (bytesRead < 1) throw failure("conflict");
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(expected, after)) throw failure("conflict");
    return digest.digest("hex");
}

function replaceCommandSha256(command: WorkerWorkspaceFileWriteCommand): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                1,
                command.expectedRevision ?? null,
                command.fileName,
                command.locator.rootId,
                [...command.locator.segments],
                command.mimeType,
                command.operation,
                command.sha256,
                command.sizeBytes,
                command.spoolId,
                command.ticketId,
            ])
        )
        .digest("hex");
}

function replaceFingerprint(
    stat: Fs.BigIntStats,
    sha256: string
): WorkspaceFileReplaceFingerprint {
    return Object.freeze({
        ctimeNs: stat.ctimeNs.toString(),
        dev: stat.dev.toString(),
        gid: stat.gid.toString(),
        ino: stat.ino.toString(),
        mode: stat.mode.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        nlink: stat.nlink.toString(),
        sha256,
        size: stat.size.toString(),
        uid: stat.uid.toString(),
    });
}

function replaceStageIdentity(stat: Fs.BigIntStats): WorkspaceFileReplaceStageIdentity {
    return Object.freeze({
        dev: stat.dev.toString(),
        gid: stat.gid.toString(),
        ino: stat.ino.toString(),
        mode: stat.mode.toString(),
        nlink: stat.nlink.toString(),
        uid: stat.uid.toString(),
    });
}

function matchesOldIdentity(
    stat: Fs.BigIntStats,
    expected: WorkspaceFileReplaceFingerprint
): boolean {
    return (
        matchesOldInode(stat, expected) &&
        stat.size.toString() === expected.size &&
        stat.mtimeNs.toString() === expected.mtimeNs &&
        stat.ctimeNs.toString() === expected.ctimeNs
    );
}

function matchesExchangedOldIdentity(
    stat: Fs.BigIntStats,
    expected: WorkspaceFileReplaceFingerprint
): boolean {
    // RENAME_EXCHANGE changes ctime; this matcher is only for the old inode after
    // the staged target has already been installed in its directory slot.
    return (
        matchesOldInode(stat, expected) &&
        stat.size.toString() === expected.size &&
        stat.mtimeNs.toString() === expected.mtimeNs
    );
}

function matchesOldInode(
    stat: Fs.BigIntStats,
    expected: WorkspaceFileReplaceFingerprint
): boolean {
    return (
        stat.dev.toString() === expected.dev &&
        stat.ino.toString() === expected.ino &&
        stat.mode.toString() === expected.mode &&
        stat.nlink.toString() === expected.nlink &&
        stat.uid.toString() === expected.uid &&
        stat.gid.toString() === expected.gid
    );
}

function matchesStageIdentity(
    stat: Fs.BigIntStats,
    expected: WorkspaceFileReplaceStageIdentity
): boolean {
    return (
        stat.dev.toString() === expected.dev &&
        stat.ino.toString() === expected.ino &&
        stat.mode.toString() === expected.mode &&
        stat.nlink.toString() === expected.nlink &&
        stat.uid.toString() === expected.uid &&
        stat.gid.toString() === expected.gid
    );
}

async function writeExact(
    handle: Fs.promises.FileHandle,
    bytes: Uint8Array,
    position: number
): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            position + offset
        );
        if (bytesWritten < 1) throw failure("unavailable");
        offset += bytesWritten;
    }
}

async function copyVerifiedSpool(
    spool: OpenSpool,
    stage: Fs.promises.FileHandle,
    command: WorkerWorkspaceFileWriteCommand,
    signal?: AbortSignal
): Promise<void> {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(copyChunkBytes, Math.max(command.sizeBytes, 1)));
    let offset = 0;
    while (offset < command.sizeBytes) {
        abortIfRequested(signal);
        const requested = Math.min(buffer.byteLength, command.sizeBytes - offset);
        const { bytesRead } = await spool.handle.read(buffer, 0, requested, offset);
        if (bytesRead < 1) throw failure("conflict");
        const chunk = buffer.subarray(0, bytesRead);
        await writeExact(stage, chunk, offset);
        digest.update(chunk);
        offset += bytesRead;
    }
    const after = await spool.handle.stat({ bigint: true });
    if (!sameFileIdentity(spool.stat, after)) throw failure("conflict");
    const actual = Buffer.from(digest.digest("hex"), "hex");
    const expected = Buffer.from(command.sha256, "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
        throw failure("conflict");
    }
}

function revisionForStat(
    rootId: string,
    segments: readonly string[],
    stat: Fs.BigIntStats
): string {
    return createHash("sha256")
        .update(rootId)
        .update("\0")
        .update(segments.join("\0"))
        .update("\0")
        .update(stat.dev.toString())
        .update(":")
        .update(stat.ino.toString())
        .update(":")
        .update(stat.mode.toString())
        .update(":")
        .update(stat.size.toString())
        .update(":")
        .update(stat.mtimeNs.toString())
        .update(":")
        .update(stat.ctimeNs.toString())
        .digest("hex");
}

async function replacementStat(
    directory: OpenDirectory,
    command: WorkerWorkspaceFileWriteCommand,
    signal?: AbortSignal
): Promise<OpenReplacement> {
    let handle: Fs.promises.FileHandle | undefined;
    try {
        handle = await Fs.promises.open(
            anchoredChild(directory.fd, command.fileName),
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== directory.root.device) {
            throw failure("access-denied");
        }
        if (stat.size > BigInt(workspaceFileLimits.maximumDownloadBytes)) {
            throw failure("too-large");
        }
        if (
            revisionForStat(directory.root.id, command.locator.segments, stat) !==
            command.expectedRevision
        ) {
            throw failure("conflict");
        }
        const sha256 = await hashOpenFile(
            handle,
            stat,
            workspaceFileLimits.maximumDownloadBytes,
            signal
        );
        return { handle, sha256, stat };
    } catch (error) {
        await handle?.close().catch(() => {});
        throw classifiedFailure(error);
    }
}

async function verifyReplacementIdentity(
    directory: OpenDirectory,
    command: WorkerWorkspaceFileWriteCommand,
    expected: Fs.BigIntStats
): Promise<void> {
    const current = await Fs.promises.lstat(
        anchoredChild(directory.fd, command.fileName),
        { bigint: true }
    );
    if (
        !sameFileIdentity(current, expected) ||
        !current.isFile() ||
        current.nlink !== 1n ||
        current.dev !== directory.root.device ||
        revisionForStat(directory.root.id, command.locator.segments, current) !==
            command.expectedRevision
    ) {
        throw failure("conflict");
    }
}

async function openHashedChild(
    directory: OpenDirectory,
    childName: string,
    signal?: AbortSignal
): Promise<HashedChild | undefined> {
    let handle: Fs.promises.FileHandle | undefined;
    try {
        handle = await Fs.promises.open(
            anchoredChild(directory.fd, childName),
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== directory.root.device) {
            throw failure("access-denied");
        }
        const sha256 = await hashOpenFile(
            handle,
            stat,
            workspaceFileLimits.maximumDownloadBytes,
            signal
        );
        return { handle, sha256, stat };
    } catch (error) {
        await handle?.close().catch(() => {});
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw classifiedFailure(error);
    }
}

async function unlinkExactChild(
    directory: OpenDirectory,
    childName: string,
    expected: Fs.BigIntStats
): Promise<void> {
    const path = anchoredChild(directory.fd, childName);
    const current = await Fs.promises.lstat(path, { bigint: true });
    if (!sameFileIdentity(current, expected)) throw failure("unavailable");
    await Fs.promises.unlink(path);
    Fs.fsyncSync(directory.fd);
}

async function closeHashedChildren(
    ...children: readonly (HashedChild | undefined)[]
): Promise<void> {
    await Promise.allSettled(
        children
            .map((child) => child?.handle.close())
            .filter((value) => value !== undefined)
    );
}

function intentMatchesCommand(
    intent: WorkspaceFileReplaceIntent,
    command: WorkerWorkspaceFileWriteCommand,
    temporaryName: string
): boolean {
    return (
        intent.commandSha256 === replaceCommandSha256(command) &&
        intent.newSha256 === command.sha256 &&
        intent.newSizeBytes === command.sizeBytes &&
        intent.stageName === temporaryName &&
        intent.target.expectedRevision === command.expectedRevision &&
        intent.target.fileName === command.fileName &&
        intent.target.rootId === command.locator.rootId &&
        intent.target.ticketId === command.ticketId &&
        intent.target.segments.length === command.locator.segments.length &&
        intent.target.segments.every(
            (segment, index) => segment === command.locator.segments[index]
        )
    );
}

function childMatchesOld(
    child: HashedChild | undefined,
    intent: WorkspaceFileReplaceIntent
): boolean {
    return (
        child !== undefined &&
        matchesOldIdentity(child.stat, intent.old) &&
        sameDigest(child.sha256, intent.old.sha256)
    );
}

function childMatchesExchangedOld(
    child: HashedChild | undefined,
    intent: WorkspaceFileReplaceIntent
): boolean {
    return (
        child !== undefined &&
        matchesExchangedOldIdentity(child.stat, intent.old) &&
        sameDigest(child.sha256, intent.old.sha256)
    );
}

function childMatchesStage(
    child: HashedChild | undefined,
    intent: WorkspaceFileReplaceIntent
): boolean {
    return (
        child !== undefined &&
        matchesStageIdentity(child.stat, intent.stage) &&
        child.stat.size === BigInt(intent.newSizeBytes) &&
        sameDigest(child.sha256, intent.newSha256)
    );
}

async function recoverWorkspaceFileReplacement(
    directory: OpenDirectory,
    command: WorkerWorkspaceFileWriteCommand,
    loaded: LoadedWorkspaceFileReplaceIntent,
    intentStore: WorkspaceFileReplaceIntentStore,
    renameExchange: LinuxRenameExchange,
    signal?: AbortSignal
): Promise<Fs.BigIntStats> {
    const { intent } = loaded;
    const temporaryName = stageName(command.spoolId);
    if (!intentMatchesCommand(intent, command, temporaryName)) {
        throw failure("access-denied");
    }

    let target: HashedChild | undefined;
    let temporary: HashedChild | undefined;
    try {
        target = await openHashedChild(directory, command.fileName, signal);
        temporary = await openHashedChild(directory, temporaryName, signal);
        const targetIsOld = childMatchesOld(target, intent);
        const temporaryIsStage = childMatchesStage(temporary, intent);

        if (targetIsOld && temporaryIsStage) {
            await closeHashedChildren(target, temporary);
            target = undefined;
            temporary = undefined;
            renameExchange(directory.fd, temporaryName, command.fileName);
            Fs.fsyncSync(directory.fd);
            target = await openHashedChild(directory, command.fileName, signal);
            temporary = await openHashedChild(directory, temporaryName, signal);
        }

        if (childMatchesStage(target, intent)) {
            if (target === undefined) throw failure("unavailable");
            if (temporary === undefined) return target.stat;
            if (childMatchesExchangedOld(temporary, intent)) {
                await unlinkExactChild(directory, temporaryName, temporary.stat);
                return target.stat;
            }
            if (matchesOldInode(temporary.stat, intent.old)) {
                await closeHashedChildren(target, temporary);
                target = undefined;
                temporary = undefined;
                renameExchange(directory.fd, temporaryName, command.fileName);
                Fs.fsyncSync(directory.fd);
                target = await openHashedChild(directory, command.fileName, signal);
                temporary = await openHashedChild(directory, temporaryName, signal);
                if (
                    target !== undefined &&
                    matchesOldInode(target.stat, intent.old) &&
                    temporary !== undefined &&
                    childMatchesStage(temporary, intent)
                ) {
                    await unlinkExactChild(directory, temporaryName, temporary.stat);
                    await removeWorkspaceFileReplaceIntent(
                        intentStore,
                        command.spoolId,
                        loaded
                    );
                    throw failure("conflict");
                }
            }
            throw failure("unavailable");
        }

        if (
            target !== undefined &&
            matchesOldInode(target.stat, intent.old) &&
            temporary !== undefined &&
            childMatchesStage(temporary, intent)
        ) {
            await unlinkExactChild(directory, temporaryName, temporary.stat);
            await removeWorkspaceFileReplaceIntent(intentStore, command.spoolId, loaded);
            throw failure("conflict");
        }
        throw failure("unavailable");
    } finally {
        await closeHashedChildren(target, temporary);
    }
}

function replacementIntent(
    command: WorkerWorkspaceFileWriteCommand,
    replacement: OpenReplacement,
    stagedStat: Fs.BigIntStats,
    temporaryName: string
): WorkspaceFileReplaceIntent {
    if (command.expectedRevision === undefined) throw failure("invalid-input");
    return Object.freeze({
        commandSha256: replaceCommandSha256(command),
        newSha256: command.sha256,
        newSizeBytes: command.sizeBytes,
        old: replaceFingerprint(replacement.stat, replacement.sha256),
        stage: replaceStageIdentity(stagedStat),
        stageName: temporaryName,
        target: Object.freeze({
            expectedRevision: command.expectedRevision,
            fileName: command.fileName,
            rootId: command.locator.rootId,
            segments: Object.freeze([...command.locator.segments]),
            ticketId: command.ticketId,
        }),
        version: 1,
    });
}

async function removeAbandonedStage(
    directory: OpenDirectory,
    childName: string,
    ownerId: bigint
): Promise<void> {
    let handle: Fs.promises.FileHandle | undefined;
    try {
        handle = await Fs.promises.open(
            anchoredChild(directory.fd, childName),
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const stat = await handle.stat({ bigint: true });
        if (
            !stat.isFile() ||
            stat.nlink !== 1n ||
            stat.dev !== directory.root.device ||
            stat.uid !== ownerId ||
            stat.size > BigInt(workspaceFileLimits.maximumUploadBytes) ||
            (stat.mode & 0o022n) !== 0n
        ) {
            throw failure("access-denied");
        }
        await unlinkExactChild(directory, childName, stat);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw classifiedFailure(error);
        }
    } finally {
        await handle?.close().catch(() => {});
    }
}

async function removeSettledSpool(spoolFd: number, spoolId: string): Promise<void> {
    try {
        await Fs.promises.unlink(anchoredChild(spoolFd, spoolName(spoolId)));
        Fs.fsyncSync(spoolFd);
    } catch {
        // Private stale bytes are reclaimed by the bounded spool sweep.
    }
}

function writeResult(
    root: OpenRoot,
    command: WorkerWorkspaceFileWriteCommand,
    stat: Fs.BigIntStats
): {
    readonly modifiedAtMs: number;
    readonly revision: string;
    readonly sizeBytes: number;
} {
    return {
        modifiedAtMs: modifiedAtMs(stat),
        revision: revisionForStat(
            root.id,
            command.operation === "create"
                ? [...command.locator.segments, command.fileName]
                : command.locator.segments,
            stat
        ),
        sizeBytes: command.sizeBytes,
    };
}

function modifiedAtMs(stat: Fs.BigIntStats): number {
    const value = Number(stat.mtimeNs / 1_000_000n);
    if (!Number.isSafeInteger(value) || value < 0) throw failure("unavailable");
    return value;
}

/**
 * Creates the worker-only descriptor-rooted create/replace executor. Upload bytes
 * are copied into a private stage, fsynced, then atomically committed within the target directory.
 * @param options Reviewed workspace roots and the private upload spool directory.
 * @returns Worker-owned structural writer with explicit descriptor disposal.
 */
export function createDescriptorWorkspaceFileStructuralWriter(
    options: DescriptorWorkspaceFileStructuralWriterOptions
): DescriptorWorkspaceFileStructuralWriter {
    const ownerId = runtimeOwnerId();
    if (
        options.roots.length === 0 ||
        options.roots.length > workspaceFileLimits.maximumConfiguredRoots
    ) {
        throw new TypeError("Workspace file writer root count is invalid");
    }
    const roots = new Map<string, OpenRoot>();
    let spoolFd: number | undefined;
    try {
        for (const configuration of options.roots) {
            if (
                typeof configuration.id !== "string" ||
                !rootIdPattern.test(configuration.id) ||
                typeof configuration.writable !== "boolean"
            ) {
                throw new TypeError("Workspace file writer root metadata is invalid");
            }
            if (roots.has(configuration.id)) {
                throw new TypeError("Workspace file writer root ids must be unique");
            }
            const rootPath = requiredDirectoryPath(
                configuration.path,
                "Workspace file writer root"
            );
            const fd = Fs.openSync(
                rootPath,
                Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW
            );
            const stat = Fs.fstatSync(fd, { bigint: true });
            if (
                !stat.isDirectory() ||
                stat.uid !== ownerId ||
                (stat.mode & 0o022n) !== 0n
            ) {
                Fs.closeSync(fd);
                throw new TypeError(
                    "Workspace file writer root owner or mode is invalid"
                );
            }
            roots.set(configuration.id, {
                ...configuration,
                device: stat.dev,
                fd,
                path: rootPath,
            });
        }
        const spoolPath = requiredDirectoryPath(
            options.spoolRoot,
            "Workspace file writer spool"
        );
        spoolFd = Fs.openSync(
            spoolPath,
            Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW
        );
        const spoolStat = Fs.fstatSync(spoolFd, { bigint: true });
        if (
            !spoolStat.isDirectory() ||
            spoolStat.uid !== ownerId ||
            (spoolStat.mode & 0o077n) !== 0n
        ) {
            throw new TypeError("Workspace file writer spool owner or mode is invalid");
        }
    } catch (error) {
        for (const root of roots.values()) Fs.closeSync(root.fd);
        if (spoolFd !== undefined) Fs.closeSync(spoolFd);
        throw error;
    }
    const requiredSpoolFd = spoolFd;
    const spoolStat = Fs.fstatSync(requiredSpoolFd, { bigint: true });
    const renameExchange = options.renameExchange ?? linuxRenameExchange;
    const renameNoReplace = options.renameNoReplace ?? linuxRenameNoReplace;
    const intentStore: WorkspaceFileReplaceIntentStore = Object.freeze({
        ownerId,
        renameNoReplace,
        spoolDevice: spoolStat.dev,
        spoolFd: requiredSpoolFd,
    });
    let disposed = false;

    return Object.freeze<DescriptorWorkspaceFileStructuralWriter>({
        async apply(command, signal) {
            if (disposed) throw failure("unavailable");
            abortIfRequested(signal);
            const root = validateCommand(command, roots);
            const parentSegments =
                command.operation === "create"
                    ? command.locator.segments
                    : command.locator.segments.slice(0, -1);
            const temporaryName = stageName(command.spoolId);
            const directory = await openDirectory(root, parentSegments);
            const temporaryPath = anchoredChild(directory.fd, temporaryName);
            let spool: OpenSpool | undefined;
            let stage: Fs.promises.FileHandle | undefined;
            let replacement: OpenReplacement | undefined;
            let committed = false;
            let preserveTemporary = false;
            try {
                if (command.operation === "replace") {
                    const existingIntent = await readWorkspaceFileReplaceIntent(
                        intentStore,
                        command.spoolId
                    );
                    if (existingIntent !== undefined) {
                        preserveTemporary = true;
                        const recovered = await recoverWorkspaceFileReplacement(
                            directory,
                            command,
                            existingIntent,
                            intentStore,
                            renameExchange,
                            undefined
                        );
                        await settleWorkspaceFileReplaceIntent(
                            intentStore,
                            command.spoolId,
                            existingIntent
                        );
                        committed = true;
                        await removeSettledSpool(requiredSpoolFd, command.spoolId);
                        return writeResult(root, command, recovered);
                    }
                }
                await removeAbandonedStage(directory, temporaryName, ownerId);
                spool = await openSpool(requiredSpoolFd, spoolStat.dev, ownerId, command);
                if (command.operation === "replace") {
                    replacement = await replacementStat(directory, command, signal);
                }
                stage = await Fs.promises.open(
                    temporaryPath,
                    Fs.constants.O_CREAT |
                        Fs.constants.O_EXCL |
                        Fs.constants.O_NOFOLLOW |
                        Fs.constants.O_RDWR,
                    0o600
                );
                if (replacement !== undefined) {
                    await stage.chmod(Number(replacement.stat.mode & 0o777n));
                }
                await copyVerifiedSpool(spool, stage, command, signal);
                await stage.sync();
                const stagedStat = await stage.stat({ bigint: true });
                if (
                    !stagedStat.isFile() ||
                    stagedStat.nlink !== 1n ||
                    stagedStat.dev !== root.device ||
                    stagedStat.size !== BigInt(command.sizeBytes)
                ) {
                    throw failure("unavailable");
                }
                abortIfRequested(signal);
                if (replacement === undefined) {
                    try {
                        renameNoReplace(directory.fd, temporaryName, command.fileName);
                    } catch (error) {
                        throw classifiedFailure(error);
                    }
                    committed = true;
                } else {
                    await verifyReplacementIdentity(directory, command, replacement.stat);
                    Fs.fsyncSync(directory.fd);
                    const loadedIntent = await createWorkspaceFileReplaceIntent(
                        intentStore,
                        command.spoolId,
                        replacementIntent(command, replacement, stagedStat, temporaryName)
                    );
                    preserveTemporary = true;
                    await verifyReplacementIdentity(directory, command, replacement.stat);
                    const recovered = await recoverWorkspaceFileReplacement(
                        directory,
                        command,
                        loadedIntent,
                        intentStore,
                        renameExchange,
                        undefined
                    );
                    await settleWorkspaceFileReplaceIntent(
                        intentStore,
                        command.spoolId,
                        loadedIntent
                    );
                    committed = true;
                    if (!sameStableIdentity(recovered, stagedStat)) {
                        throw failure("unavailable");
                    }
                }
                await replacement?.handle.close();
                replacement = undefined;
                const stat = await stage.stat({ bigint: true });
                if (
                    !stat.isFile() ||
                    stat.nlink !== 1n ||
                    stat.dev !== root.device ||
                    stat.dev !== stagedStat.dev ||
                    stat.ino !== stagedStat.ino ||
                    stat.size !== BigInt(command.sizeBytes)
                ) {
                    throw failure("unavailable");
                }
                Fs.fsyncSync(directory.fd);
                await removeSettledSpool(requiredSpoolFd, command.spoolId);
                return writeResult(root, command, stat);
            } catch (error) {
                if (signal?.aborted === true) {
                    throw signal.reason ?? error;
                }
                throw classifiedFailure(error);
            } finally {
                await stage?.close().catch(() => {});
                await replacement?.handle.close().catch(() => {});
                await spool?.handle.close().catch(() => {});
                if (!committed && !preserveTemporary) {
                    await Fs.promises.unlink(temporaryPath).catch(() => {});
                }
                await directory.close();
            }
        },
        async removeSettledReplacementIntent(command) {
            if (disposed) throw failure("unavailable");
            try {
                validateCommand(command, roots);
                if (command.operation !== "replace") {
                    throw failure("invalid-input");
                }
                const loaded = await readWorkspaceFileReplaceIntent(
                    intentStore,
                    command.spoolId
                );
                if (loaded === undefined) return;
                if (
                    loaded.state !== "settled" ||
                    !intentMatchesCommand(
                        loaded.intent,
                        command,
                        stageName(command.spoolId)
                    )
                ) {
                    throw failure("access-denied");
                }
                await removeWorkspaceFileReplaceIntent(
                    intentStore,
                    command.spoolId,
                    loaded
                );
            } catch (error) {
                throw classifiedFailure(error);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const root of roots.values()) Fs.closeSync(root.fd);
            roots.clear();
            Fs.closeSync(requiredSpoolFd);
        },
    });
}
