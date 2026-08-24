import { randomUUID } from "node:crypto";
import Fs from "node:fs";

import type { LinuxRenameNoReplace } from "./linuxRenameExchange.ts";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const uuidV4Pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const decimalPattern = /^(?:0|[1-9][0-9]*)$/u;
const childNamePattern = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/u;
const maximumIntentBytes = 128 * 1024;
const maximumIntentEntries = 256;
const maximumIntentTotalBytes = 8 * 1024 * 1024;
const maximumSpoolDirectoryEntries = 1024;
const intentArtifactPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:replace-intent(?:-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)?|replace-settled)$/u;

export interface WorkspaceFileReplaceFingerprint {
    readonly ctimeNs: string;
    readonly dev: string;
    readonly gid: string;
    readonly ino: string;
    readonly mode: string;
    readonly mtimeNs: string;
    readonly nlink: string;
    readonly sha256: string;
    readonly size: string;
    readonly uid: string;
}

export interface WorkspaceFileReplaceStageIdentity {
    readonly dev: string;
    readonly gid: string;
    readonly ino: string;
    readonly mode: string;
    readonly nlink: string;
    readonly uid: string;
}

export interface WorkspaceFileReplaceIntent {
    readonly commandSha256: string;
    readonly newSha256: string;
    readonly newSizeBytes: number;
    readonly old: WorkspaceFileReplaceFingerprint;
    readonly stage: WorkspaceFileReplaceStageIdentity;
    readonly stageName: string;
    readonly target: {
        readonly expectedRevision: string;
        readonly fileName: string;
        readonly rootId: string;
        readonly segments: readonly string[];
        readonly ticketId: string;
    };
    readonly version: 1;
}

export interface LoadedWorkspaceFileReplaceIntent {
    readonly intent: WorkspaceFileReplaceIntent;
    readonly state: "pending" | "settled";
    readonly stat: Fs.BigIntStats;
}

export interface WorkspaceFileReplaceIntentStore {
    readonly ownerId: bigint;
    readonly renameNoReplace: LinuxRenameNoReplace;
    readonly spoolDevice: bigint;
    readonly spoolFd: number;
}

function intentName(spoolId: string): string {
    if (!uuidV4Pattern.test(spoolId)) {
        throw new TypeError("Workspace file replace intent id is invalid");
    }
    return `${spoolId}.replace-intent`;
}

function settledIntentName(spoolId: string): string {
    intentName(spoolId);
    return `${spoolId}.replace-settled`;
}

function temporaryIntentName(spoolId: string): string {
    intentName(spoolId);
    return `${spoolId}.replace-intent-${randomUUID()}.tmp`;
}

function anchoredChild(directoryFd: number, childName: string): string {
    return `/proc/self/fd/${directoryFd}/${childName}`;
}

function isExactObject(
    value: unknown,
    expectedKeys: readonly string[]
): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value).toSorted();
    return (
        keys.length === expectedKeys.length &&
        keys.every((key, index) => key === expectedKeys[index])
    );
}

function decimal(value: unknown): value is string {
    return typeof value === "string" && decimalPattern.test(value);
}

function parseFingerprint(value: unknown): WorkspaceFileReplaceFingerprint {
    const keys = [
        "ctimeNs",
        "dev",
        "gid",
        "ino",
        "mode",
        "mtimeNs",
        "nlink",
        "sha256",
        "size",
        "uid",
    ];
    if (
        !isExactObject(value, keys) ||
        !decimal(value.ctimeNs) ||
        !decimal(value.dev) ||
        !decimal(value.gid) ||
        !decimal(value.ino) ||
        !decimal(value.mode) ||
        !decimal(value.mtimeNs) ||
        !decimal(value.nlink) ||
        typeof value.sha256 !== "string" ||
        !sha256Pattern.test(value.sha256) ||
        !decimal(value.size) ||
        !decimal(value.uid)
    ) {
        throw new TypeError("Workspace file replace intent fingerprint is invalid");
    }
    return Object.freeze({
        ctimeNs: value.ctimeNs,
        dev: value.dev,
        gid: value.gid,
        ino: value.ino,
        mode: value.mode,
        mtimeNs: value.mtimeNs,
        nlink: value.nlink,
        sha256: value.sha256,
        size: value.size,
        uid: value.uid,
    });
}

function parseStageIdentity(value: unknown): WorkspaceFileReplaceStageIdentity {
    const keys = ["dev", "gid", "ino", "mode", "nlink", "uid"];
    if (
        !isExactObject(value, keys) ||
        !decimal(value.dev) ||
        !decimal(value.gid) ||
        !decimal(value.ino) ||
        !decimal(value.mode) ||
        !decimal(value.nlink) ||
        !decimal(value.uid)
    ) {
        throw new TypeError("Workspace file replace intent stage identity is invalid");
    }
    return Object.freeze({
        dev: value.dev,
        gid: value.gid,
        ino: value.ino,
        mode: value.mode,
        nlink: value.nlink,
        uid: value.uid,
    });
}

function parseIntent(value: unknown): WorkspaceFileReplaceIntent {
    if (
        !isExactObject(value, [
            "commandSha256",
            "newSha256",
            "newSizeBytes",
            "old",
            "stage",
            "stageName",
            "target",
            "version",
        ]) ||
        value.version !== 1 ||
        typeof value.commandSha256 !== "string" ||
        !sha256Pattern.test(value.commandSha256) ||
        typeof value.newSha256 !== "string" ||
        !sha256Pattern.test(value.newSha256) ||
        !Number.isSafeInteger(value.newSizeBytes) ||
        (value.newSizeBytes as number) < 0 ||
        typeof value.stageName !== "string" ||
        !childNamePattern.test(value.stageName) ||
        !isExactObject(value.target, [
            "expectedRevision",
            "fileName",
            "rootId",
            "segments",
            "ticketId",
        ]) ||
        typeof value.target.expectedRevision !== "string" ||
        !sha256Pattern.test(value.target.expectedRevision) ||
        typeof value.target.fileName !== "string" ||
        !childNamePattern.test(value.target.fileName) ||
        typeof value.target.rootId !== "string" ||
        value.target.rootId.length === 0 ||
        value.target.rootId.length > 64 ||
        !Array.isArray(value.target.segments) ||
        value.target.segments.length === 0 ||
        value.target.segments.length > 256 ||
        value.target.segments.some(
            (segment) => typeof segment !== "string" || !childNamePattern.test(segment)
        ) ||
        typeof value.target.ticketId !== "string" ||
        !uuidV4Pattern.test(value.target.ticketId)
    ) {
        throw new TypeError("Workspace file replace intent is invalid");
    }
    const segments = (value.target.segments as unknown[]).map((segment) => {
        if (typeof segment !== "string") {
            throw new TypeError("Workspace file replace intent segment is invalid");
        }
        return segment;
    });
    return Object.freeze({
        commandSha256: value.commandSha256,
        newSha256: value.newSha256,
        newSizeBytes: value.newSizeBytes as number,
        old: parseFingerprint(value.old),
        stage: parseStageIdentity(value.stage),
        stageName: value.stageName,
        target: Object.freeze({
            expectedRevision: value.target.expectedRevision,
            fileName: value.target.fileName,
            rootId: value.target.rootId,
            segments: Object.freeze(segments),
            ticketId: value.target.ticketId,
        }),
        version: 1,
    });
}

function isPrivateIntentFile(
    stat: Fs.BigIntStats,
    store: WorkspaceFileReplaceIntentStore
): boolean {
    return (
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.uid === store.ownerId &&
        stat.dev === store.spoolDevice &&
        (stat.mode & 0o777n) === 0o600n &&
        stat.size > 0n &&
        stat.size <= BigInt(maximumIntentBytes)
    );
}

function isPrivateIntentArtifact(
    stat: Fs.BigIntStats,
    store: WorkspaceFileReplaceIntentStore
): boolean {
    return (
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.uid === store.ownerId &&
        stat.dev === store.spoolDevice &&
        (stat.mode & 0o777n) === 0o600n &&
        stat.size >= 0n &&
        stat.size <= BigInt(maximumIntentBytes)
    );
}

function assertIntentCapacity(
    store: WorkspaceFileReplaceIntentStore,
    pendingBytes: number
): void {
    const directory = Fs.opendirSync(`/proc/self/fd/${store.spoolFd}`);
    let inspected = 0;
    let intentEntries = 0;
    let intentBytes = 0;
    try {
        while (true) {
            const entry = directory.readSync();
            if (entry === null) break;
            inspected += 1;
            if (inspected > maximumSpoolDirectoryEntries) {
                throw new TypeError(
                    "Workspace file spool directory capacity is exceeded"
                );
            }
            if (!intentArtifactPattern.test(entry.name)) continue;
            const fd = Fs.openSync(
                anchoredChild(store.spoolFd, entry.name),
                Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
            );
            try {
                const stat = Fs.fstatSync(fd, { bigint: true });
                const sizeBytes = Number(stat.size);
                if (
                    !isPrivateIntentArtifact(stat, store) ||
                    !Number.isSafeInteger(sizeBytes)
                ) {
                    throw new TypeError(
                        "Workspace file replace intent capacity state is invalid"
                    );
                }
                intentEntries += 1;
                intentBytes += sizeBytes;
            } finally {
                Fs.closeSync(fd);
            }
        }
    } finally {
        directory.closeSync();
    }
    if (
        intentEntries >= maximumIntentEntries ||
        intentBytes > maximumIntentTotalBytes - pendingBytes
    ) {
        throw new TypeError("Workspace file replace intent capacity is exceeded");
    }
}

function sameIntentFile(left: Fs.BigIntStats, right: Fs.BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.uid === right.uid &&
        left.gid === right.gid &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function sameQuarantinedIntentFile(left: Fs.BigIntStats, right: Fs.BigIntStats): boolean {
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

async function readExact(
    handle: Fs.promises.FileHandle,
    sizeBytes: number
): Promise<Buffer> {
    const bytes = Buffer.alloc(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
        const { bytesRead } = await handle.read(
            bytes,
            offset,
            sizeBytes - offset,
            offset
        );
        if (bytesRead < 1) {
            throw new TypeError("Workspace file replace intent is truncated");
        }
        offset += bytesRead;
    }
    return bytes;
}

async function writeExact(
    handle: Fs.promises.FileHandle,
    bytes: Uint8Array
): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset
        );
        if (bytesWritten < 1) {
            throw new TypeError("Workspace file replace intent could not be written");
        }
        offset += bytesWritten;
    }
}

async function removeExactFile(
    store: WorkspaceFileReplaceIntentStore,
    childName: string,
    expected: Fs.BigIntStats
): Promise<void> {
    const path = anchoredChild(store.spoolFd, childName);
    const spoolId = childName.slice(0, 36);
    const quarantineName = temporaryIntentName(spoolId);
    const quarantinePath = anchoredChild(store.spoolFd, quarantineName);
    let handle: Fs.promises.FileHandle | undefined;
    let quarantine: Fs.promises.FileHandle | undefined;
    let moved = false;
    try {
        handle = await Fs.promises.open(
            path,
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const current = await handle.stat({ bigint: true });
        if (!sameIntentFile(current, expected) || !isPrivateIntentFile(current, store)) {
            throw new TypeError("Workspace file replace intent identity changed");
        }
        store.renameNoReplace(store.spoolFd, childName, quarantineName);
        moved = true;
        Fs.fsyncSync(store.spoolFd);
        quarantine = await Fs.promises.open(
            quarantinePath,
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const quarantined = await quarantine.stat({ bigint: true });
        if (
            !sameQuarantinedIntentFile(quarantined, expected) ||
            !sameQuarantinedIntentFile(quarantined, current) ||
            !isPrivateIntentFile(quarantined, store)
        ) {
            try {
                store.renameNoReplace(store.spoolFd, quarantineName, childName);
                moved = false;
                Fs.fsyncSync(store.spoolFd);
            } catch {
                // Preserve both names for bounded orphan recovery when restoration races.
            }
            throw new TypeError("Workspace file replace intent quarantine changed");
        }
        await Fs.promises.unlink(quarantinePath);
        moved = false;
        Fs.fsyncSync(store.spoolFd);
    } finally {
        await quarantine?.close().catch(() => {});
        await handle?.close().catch(() => {});
        if (moved) Fs.fsyncSync(store.spoolFd);
    }
}

async function readNamedIntent(
    store: WorkspaceFileReplaceIntentStore,
    childName: string,
    state: LoadedWorkspaceFileReplaceIntent["state"]
): Promise<LoadedWorkspaceFileReplaceIntent | undefined> {
    const path = anchoredChild(store.spoolFd, childName);
    let handle: Fs.promises.FileHandle | undefined;
    try {
        handle = await Fs.promises.open(
            path,
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const before = await handle.stat({ bigint: true });
        if (!isPrivateIntentFile(before, store)) {
            throw new TypeError("Workspace file replace intent file is invalid");
        }
        const sizeBytes = Number(before.size);
        const bytes = await readExact(handle, sizeBytes);
        const after = await handle.stat({ bigint: true });
        if (!sameIntentFile(before, after)) {
            throw new TypeError("Workspace file replace intent changed during read");
        }
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        return Object.freeze({ intent: parseIntent(value), stat: after, state });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    } finally {
        await handle?.close().catch(() => {});
    }
}

/**
 * Reads one exact durable replace intent without following a path supplied by a job.
 * @returns Parsed pending or settled intent, or undefined when neither exists.
 */
export async function readWorkspaceFileReplaceIntent(
    store: WorkspaceFileReplaceIntentStore,
    spoolId: string
): Promise<LoadedWorkspaceFileReplaceIntent | undefined> {
    const pending = await readNamedIntent(store, intentName(spoolId), "pending");
    const settled = await readNamedIntent(store, settledIntentName(spoolId), "settled");
    if (pending !== undefined && settled !== undefined) {
        throw new TypeError("Workspace file replace intent state is ambiguous");
    }
    return pending ?? settled;
}

/**
 * Publishes a complete fsynced intent atomically beneath the private spool root.
 * @returns The exact published intent and inode identity.
 */
export async function createWorkspaceFileReplaceIntent(
    store: WorkspaceFileReplaceIntentStore,
    spoolId: string,
    intent: WorkspaceFileReplaceIntent
): Promise<LoadedWorkspaceFileReplaceIntent> {
    const parsed = parseIntent(intent);
    const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
    if (bytes.byteLength > maximumIntentBytes) {
        throw new TypeError("Workspace file replace intent is too large");
    }
    assertIntentCapacity(store, bytes.byteLength);
    const temporaryName = temporaryIntentName(spoolId);
    const temporaryPath = anchoredChild(store.spoolFd, temporaryName);
    let handle: Fs.promises.FileHandle | undefined;
    let published = false;
    try {
        handle = await Fs.promises.open(
            temporaryPath,
            Fs.constants.O_WRONLY |
                Fs.constants.O_CREAT |
                Fs.constants.O_EXCL |
                Fs.constants.O_NOFOLLOW,
            0o600
        );
        await writeExact(handle, bytes);
        await handle.sync();
        const temporaryStat = await handle.stat({ bigint: true });
        if (!isPrivateIntentFile(temporaryStat, store)) {
            throw new TypeError("Workspace file replace intent file is invalid");
        }
        await handle.close();
        handle = undefined;
        store.renameNoReplace(store.spoolFd, temporaryName, intentName(spoolId));
        Fs.fsyncSync(store.spoolFd);
        published = true;
        const loaded = await readWorkspaceFileReplaceIntent(store, spoolId);
        if (loaded === undefined) {
            throw new TypeError("Workspace file replace intent publication was lost");
        }
        return loaded;
    } finally {
        await handle?.close().catch(() => {});
        if (!published) await Fs.promises.unlink(temporaryPath).catch(() => {});
    }
}

/**
 * Marks a fully verified filesystem replacement as safe for later inactive-job cleanup.
 * @returns The same intent with its exact settled inode identity after durable rename.
 */
export async function settleWorkspaceFileReplaceIntent(
    store: WorkspaceFileReplaceIntentStore,
    spoolId: string,
    loaded: LoadedWorkspaceFileReplaceIntent
): Promise<LoadedWorkspaceFileReplaceIntent> {
    if (loaded.state === "settled") return loaded;
    const pendingName = intentName(spoolId);
    const pendingPath = anchoredChild(store.spoolFd, pendingName);
    let handle: Fs.promises.FileHandle | undefined;
    try {
        handle = await Fs.promises.open(
            pendingPath,
            Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK
        );
        const current = await handle.stat({ bigint: true });
        if (
            !sameIntentFile(current, loaded.stat) ||
            !isPrivateIntentFile(current, store)
        ) {
            throw new TypeError("Workspace file replace intent identity changed");
        }
        store.renameNoReplace(store.spoolFd, pendingName, settledIntentName(spoolId));
        Fs.fsyncSync(store.spoolFd);
    } finally {
        await handle?.close().catch(() => {});
    }
    const settled = await readWorkspaceFileReplaceIntent(store, spoolId);
    if (
        settled?.state !== "settled" ||
        !sameQuarantinedIntentFile(settled.stat, loaded.stat)
    ) {
        throw new TypeError("Workspace file replace intent settlement was lost");
    }
    return settled;
}

/**
 * Removes only the exact previously-read intent inode and durably settles the spool directory.
 * @returns Completion after the verified inode is quarantined, unlinked, and fsynced.
 */
export function removeWorkspaceFileReplaceIntent(
    store: WorkspaceFileReplaceIntentStore,
    spoolId: string,
    loaded: LoadedWorkspaceFileReplaceIntent
): Promise<void> {
    return removeExactFile(
        store,
        loaded.state === "settled" ? settledIntentName(spoolId) : intentName(spoolId),
        loaded.stat
    );
}
