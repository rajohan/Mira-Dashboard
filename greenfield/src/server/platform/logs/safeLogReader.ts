import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";

import {
    logReadWindowMaximumBytes,
    logRowMaximum,
    logSourceMaximum,
    type LogLine,
    type LogSnapshotOutput,
    type SearchLogsInput,
    type TailLogsInput,
} from "../../../contracts/logs.ts";
import type { LogRotationEpochProbe } from "./logRotationEpochProbe.ts";
import { classifyLogSeverity, parseLogTimestamp, redactLogLine } from "./redaction.ts";
import type { LogSourceCatalog, LogSourceReference } from "./sourceCatalog.ts";

export type SafeLogReaderFailureReason = "not-found" | "source-changed" | "unavailable";

const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

/** Sanitized reader failure that never retains a host path or filesystem cause. */
export class SafeLogReaderError extends Error {
    readonly reason: SafeLogReaderFailureReason;

    constructor(reason: SafeLogReaderFailureReason) {
        super(`Log source is ${reason}`);
        this.name = "SafeLogReaderError";
        this.reason = reason;
    }

    toJSON() {
        return Object.freeze({ name: this.name, reason: this.reason });
    }

    [inspectSymbol](): ReturnType<SafeLogReaderError["toJSON"]> {
        return this.toJSON();
    }
}

interface PhysicalLine {
    readonly bytes: Buffer;
    readonly offset: number;
    readonly redacted?: string;
}

interface ReadWindow {
    readonly checkpoint: LogSourceCheckpoint;
    readonly content: Buffer;
    readonly contentStart: number;
    readonly observation: LogSourceObservation;
    readonly previousCheckpointMatches?: boolean;
    readonly revision: string;
    readonly scannedBytes: number;
    readonly startedAfterBeginning: boolean;
}

interface LogSourceCheckpoint {
    readonly digest: Buffer;
    readonly length: number;
    readonly offset: number;
}

interface LogSourceObservation {
    readonly birthTimeNs: bigint;
    readonly changeTimeNs: bigint;
    readonly device: bigint;
    readonly inode: bigint;
    readonly modifiedTimeNs: bigint;
    readonly size: number;
}

interface LogSourceGenerationState extends LogSourceObservation {
    readonly checkpoint: LogSourceCheckpoint;
    readonly generation: string;
    readonly identity: string;
}

const logSourceCheckpointMaximumBytes = 4 * 1024;
/** Maximum physical lines whose redacted form may be inspected by one search. */
export const logSearchMaximumInspectedLines = logRowMaximum * 8;

function sha256(...values: readonly (Buffer | string)[]): string {
    const hash = new Bun.CryptoHasher("sha256");
    for (const value of values) hash.update(value);
    return hash.digest("hex");
}

function framedSha256(domain: string, ...values: readonly string[]): string {
    const hash = new Bun.CryptoHasher("sha256").update(domain);
    const length = Buffer.allocUnsafe(8);
    for (const value of values) {
        const bytes = Buffer.from(value, "utf8");
        length.writeBigUInt64BE(BigInt(bytes.byteLength));
        hash.update(length);
        hash.update(bytes);
    }
    return hash.digest("hex");
}

function openFlags(): number {
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

async function observeFile(file: Awaited<ReturnType<typeof open>>) {
    const status = await file.stat({ bigint: true });
    const size = Number(status.size);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new SafeLogReaderError("unavailable");
    }
    return {
        birthTimeNs: status.birthtimeNs,
        changeTimeNs: status.ctimeNs,
        device: status.dev,
        inode: status.ino,
        isFile: status.isFile(),
        linkCount: Number(status.nlink),
        mode: Number(status.mode),
        modifiedTimeNs: status.mtimeNs,
        ownerId: Number(status.uid),
        size,
    };
}

function sameObservation(
    left: Awaited<ReturnType<typeof observeFile>>,
    right: Awaited<ReturnType<typeof observeFile>>
): boolean {
    return (
        left.birthTimeNs === right.birthTimeNs &&
        left.changeTimeNs === right.changeTimeNs &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.isFile === right.isFile &&
        left.linkCount === right.linkCount &&
        left.mode === right.mode &&
        left.modifiedTimeNs === right.modifiedTimeNs &&
        left.ownerId === right.ownerId &&
        left.size === right.size
    );
}

function sourceGenerationIdentity(
    sourceId: string,
    observation: LogSourceObservation,
    rotationEpoch: string | undefined
): string {
    return sha256(
        "mira-log-source-generation-v2\0",
        sourceId,
        "\0",
        observation.device.toString(),
        "\0",
        observation.inode.toString(),
        "\0",
        observation.birthTimeNs.toString(),
        "\0",
        rotationEpoch ?? "unmanaged"
    );
}

function checkpointDigest(key: Buffer, bytes: Buffer): Buffer {
    return new Bun.CryptoHasher("sha256", key).update(bytes).digest();
}

function checkpointsMatch(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && timingSafeEqual(left, right);
}

// Keeps one bounded incarnation high-water mark per catalog source.
function createSourceGenerationTracker() {
    const states = new Map<string, LogSourceGenerationState>();
    return Object.freeze({
        previousCheckpoint(sourceId: string): LogSourceCheckpoint | undefined {
            return states.get(sourceId)?.checkpoint;
        },
        record(
            sourceId: string,
            readResult: ReadWindow,
            rotationEpoch: string | undefined
        ): string {
            const { observation } = readResult;
            const identity = sourceGenerationIdentity(
                sourceId,
                observation,
                rotationEpoch
            );
            const previous = states.get(sourceId);
            const changedWithoutAppend =
                previous?.identity === identity &&
                (observation.size < previous.size ||
                    (observation.size === previous.size &&
                        (observation.changeTimeNs !== previous.changeTimeNs ||
                            observation.modifiedTimeNs !== previous.modifiedTimeNs)) ||
                    readResult.previousCheckpointMatches === false);
            const generation =
                previous?.identity === identity && !changedWithoutAppend
                    ? previous.generation
                    : sha256(
                          "mira-log-source-generation-epoch-v2\0",
                          previous?.identity === identity
                              ? previous.generation
                              : identity,
                          "\0",
                          observation.changeTimeNs.toString(),
                          "\0",
                          observation.modifiedTimeNs.toString(),
                          "\0",
                          observation.size.toString()
                      );
            states.delete(sourceId);
            states.set(sourceId, {
                ...observation,
                checkpoint: readResult.checkpoint,
                generation,
                identity,
            });
            if (states.size > logSourceMaximum) {
                const oldestSourceId = states.keys().next().value;
                if (oldestSourceId !== undefined) states.delete(oldestSourceId);
            }
            return generation;
        },
    });
}

// Serializes same-source observations so a late read cannot rewind the high-water mark.
function createSourceReadCoordinator() {
    const pending = new Map<string, Promise<void>>();
    return async <Result>(
        sourceId: string,
        operation: () => Promise<Result>
    ): Promise<Result> => {
        const predecessor = pending.get(sourceId) ?? Promise.resolve();
        const completion = Promise.withResolvers<void>();
        pending.set(sourceId, completion.promise);
        try {
            await predecessor;
            return await operation();
        } finally {
            completion.resolve();
            if (pending.get(sourceId) === completion.promise) pending.delete(sourceId);
        }
    };
}

interface SelectedPhysicalLines {
    readonly hasEarlier: boolean;
    readonly lines: readonly PhysicalLine[];
}

function selectPhysicalLines(
    buffer: Buffer,
    absoluteStart: number,
    limit: number,
    accepts: (start: number, end: number) => boolean
): SelectedPhysicalLines {
    const retainedStarts = new Uint32Array(limit);
    const retainedEnds = new Uint32Array(limit);
    let matched = 0;
    let nextSlot = 0;
    let lineStart = 0;
    const retain = (end: number): void => {
        if (!accepts(lineStart, end)) return;
        retainedStarts[nextSlot] = lineStart;
        retainedEnds[nextSlot] = end;
        nextSlot = (nextSlot + 1) % limit;
        matched += 1;
    };
    for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 10) continue;
        const end = index > lineStart && buffer[index - 1] === 13 ? index - 1 : index;
        retain(end);
        lineStart = index + 1;
    }
    if (lineStart < buffer.length) retain(buffer.length);

    const retained = Math.min(matched, limit);
    const firstSlot = matched > limit ? nextSlot : 0;
    const lines: PhysicalLine[] = [];
    for (let index = 0; index < retained; index += 1) {
        const slot = (firstSlot + index) % limit;
        const start = retainedStarts[slot]!;
        lines.push({
            bytes: buffer.subarray(start, retainedEnds[slot]),
            offset: absoluteStart + start,
        });
    }
    return { hasEarlier: matched > retained, lines };
}

function selectSearchPhysicalLines(
    buffer: Buffer,
    absoluteStart: number,
    limit: number,
    normalizedQuery: string
): SelectedPhysicalLines {
    if (buffer.length === 0) return { hasEarlier: false, lines: [] };

    const newestMatches: PhysicalLine[] = [];
    let hasEarlier = false;
    let inspected = 0;
    let lineEnd = buffer.at(-1) === 10 ? buffer.length - 1 : buffer.length;
    let hasLine = true;
    while (hasLine && inspected < logSearchMaximumInspectedLines) {
        const separator = lineEnd === 0 ? -1 : buffer.lastIndexOf(10, lineEnd - 1);
        const start = separator + 1;
        const end = lineEnd > start && buffer[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
        const redactedLine = redactLogLine(buffer.toString("utf8", start, end));
        inspected += 1;
        if (redactedLine.toLowerCase().includes(normalizedQuery)) {
            if (newestMatches.length === limit) {
                hasEarlier = true;
                break;
            }
            newestMatches.push({
                bytes: buffer.subarray(start, end),
                offset: absoluteStart + start,
                redacted: redactedLine,
            });
        }
        if (separator === -1) {
            hasLine = false;
        } else {
            lineEnd = separator;
        }
    }
    if (hasLine) hasEarlier = true;
    return { hasEarlier, lines: newestMatches.toReversed() };
}

async function readExactRange(
    file: Awaited<ReturnType<typeof open>>,
    length: number,
    position: number
): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
        const result = await file.read(
            buffer,
            bytesRead,
            length - bytesRead,
            position + bytesRead
        );
        if (result.bytesRead === 0) throw new SafeLogReaderError("source-changed");
        bytesRead += result.bytesRead;
    }
    return buffer;
}

async function readWindow(
    reference: LogSourceReference,
    previousCheckpoint: LogSourceCheckpoint | undefined,
    checkpointKey: Buffer
): Promise<ReadWindow> {
    let root;
    let file;
    try {
        root = await open(
            reference.root,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        const rootStatus = await root.stat();
        const runtimeOwnerId =
            typeof process.getuid === "function" ? process.getuid() : 0;
        if (
            !rootStatus.isDirectory() ||
            ![0, runtimeOwnerId].includes(rootStatus.uid) ||
            (rootStatus.mode & 0o002) !== 0 ||
            (await realpath(reference.root)) !== reference.root
        ) {
            throw new SafeLogReaderError("unavailable");
        }
        file = await open(`/proc/self/fd/${root.fd}/${reference.fileName}`, openFlags());
        const before = await observeFile(file);
        if (
            !before.isFile ||
            before.linkCount !== 1 ||
            !reference.trustedOwnerIds.includes(before.ownerId) ||
            (before.mode & 0o022) !== 0 ||
            !Number.isSafeInteger(before.size)
        ) {
            throw new SafeLogReaderError("unavailable");
        }

        const previousCheckpointEnd =
            previousCheckpoint === undefined
                ? 0
                : previousCheckpoint.offset + previousCheckpoint.length;
        const fullWindowStart = Math.max(0, before.size - logReadWindowMaximumBytes);
        const readPreviousCheckpointSeparately =
            previousCheckpoint !== undefined &&
            previousCheckpoint.length > 0 &&
            previousCheckpointEnd <= before.size &&
            previousCheckpoint.offset < fullWindowStart;
        const tailInspectionBudget =
            logReadWindowMaximumBytes -
            (readPreviousCheckpointSeparately ? previousCheckpoint.length : 0);
        const tailContentBudget =
            before.size > tailInspectionBudget
                ? tailInspectionBudget - 1
                : tailInspectionBudget;
        const startedAfterBeginning = before.size > tailContentBudget;
        const start = Math.max(0, before.size - tailContentBudget);
        const prefixStart = start === 0 ? 0 : start - 1;
        const length = before.size - prefixStart;
        const observed = await readExactRange(file, length, prefixStart);
        let separatelyReadCheckpoint: Buffer | undefined;
        if (readPreviousCheckpointSeparately && previousCheckpoint !== undefined) {
            separatelyReadCheckpoint = await readExactRange(
                file,
                previousCheckpoint.length,
                previousCheckpoint.offset
            );
        }
        // The worker epoch covers managed exact-prefix copytruncate. This checkpoint
        // also detects other rewrites when overlap changes or an empty file is observed.
        let previousCheckpointMatches: boolean | undefined;
        if (previousCheckpoint !== undefined) {
            if (previousCheckpoint.length === 0) {
                previousCheckpointMatches = true;
            } else if (previousCheckpointEnd > before.size) {
                previousCheckpointMatches = false;
            } else {
                const overlap =
                    separatelyReadCheckpoint ??
                    observed.subarray(
                        previousCheckpoint.offset - prefixStart,
                        previousCheckpointEnd - prefixStart
                    );
                previousCheckpointMatches = checkpointsMatch(
                    previousCheckpoint.digest,
                    checkpointDigest(checkpointKey, overlap)
                );
            }
        }
        let content = observed;
        let contentStart = prefixStart;
        if (prefixStart > 0) {
            const firstNewline = observed.indexOf(10);
            if (firstNewline === -1) {
                content = Buffer.alloc(0);
                contentStart = before.size;
            } else {
                content = observed.subarray(firstNewline + 1);
                contentStart = prefixStart + firstNewline + 1;
            }
        }

        const after = await observeFile(file);
        if (!sameObservation(before, after)) {
            throw new SafeLogReaderError("source-changed");
        }
        const revision = sha256(
            reference.id,
            before.device.toString(),
            before.inode.toString(),
            String(before.size),
            before.modifiedTimeNs.toString()
        );
        const checkpointLength = Math.min(logSourceCheckpointMaximumBytes, before.size);
        const checkpointBytes = observed.subarray(observed.length - checkpointLength);
        return {
            checkpoint: {
                digest: checkpointDigest(checkpointKey, checkpointBytes),
                length: checkpointLength,
                offset: before.size - checkpointLength,
            },
            content,
            contentStart,
            observation: before,
            ...(previousCheckpointMatches === undefined
                ? {}
                : { previousCheckpointMatches }),
            revision,
            scannedBytes: observed.length + (separatelyReadCheckpoint?.length ?? 0),
            startedAfterBeginning,
        };
    } catch (error) {
        if (error instanceof SafeLogReaderError) throw error;
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        throw new SafeLogReaderError(code === "ENOENT" ? "not-found" : "unavailable");
    } finally {
        await file?.close().catch(() => {});
        await root?.close().catch(() => {});
    }
}

function projectLine(generation: string, physical: PhysicalLine): LogLine {
    const line = physical.redacted ?? redactLogLine(physical.bytes.toString("utf8"));
    const timestampMs = parseLogTimestamp(line);
    return {
        id: framedSha256(
            "mira-log-line-identity-v1\0",
            generation,
            String(physical.offset),
            line
        ),
        line,
        severity: classifyLogSeverity(line),
        ...(timestampMs === undefined ? {} : { timestampMs }),
    };
}

async function referenceFor(
    catalog: LogSourceCatalog,
    sourceId: string
): Promise<LogSourceReference> {
    const reference = await catalog.resolve(sourceId);
    if (reference === undefined) throw new SafeLogReaderError("not-found");
    return reference;
}

function snapshot(
    sourceId: string,
    readResult: ReadWindow,
    now: () => number,
    generation: string,
    revision: string,
    selection: SelectedPhysicalLines
): LogSnapshotOutput {
    return {
        hasEarlier: readResult.startedAfterBeginning || selection.hasEarlier,
        lines: selection.lines.map((line) => projectLine(generation, line)),
        observedAtMs: now(),
        revision,
        scannedBytes: readResult.scannedBytes,
        sourceId,
    };
}

export interface SafeLogReader {
    readonly search: (input: SearchLogsInput) => Promise<LogSnapshotOutput>;
    readonly tail: (input: TailLogsInput) => Promise<LogSnapshotOutput>;
}

const absentRotationEpoch = undefined as string | undefined;
const absentRotationEpochProbe: LogRotationEpochProbe = Object.freeze({
    epoch: () => Promise.resolve(absentRotationEpoch),
});

/**
 * Creates a bounded descriptor-rooted reader over named catalog references.
 * @param catalog Path-free catalog that owns the fixed source mapping.
 * @param now Replaceable observation clock.
 * @param rotationEpochProbe Read-only worker marker used to distinguish managed copytruncate.
 * @returns Tail and search operations that emit only redacted text.
 */
export function createSafeLogReader(
    catalog: LogSourceCatalog,
    now: () => number = Date.now,
    rotationEpochProbe: LogRotationEpochProbe = absentRotationEpochProbe
): SafeLogReader {
    const checkpointKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const coordinateRead = createSourceReadCoordinator();
    const generationTracker = createSourceGenerationTracker();
    async function snapshotFor(
        input: SearchLogsInput | TailLogsInput,
        select: (readResult: ReadWindow) => SelectedPhysicalLines
    ): Promise<LogSnapshotOutput> {
        const reference = await referenceFor(catalog, input.sourceId);
        return coordinateRead(input.sourceId, async () => {
            let rotationEpochBefore: string | undefined;
            try {
                rotationEpochBefore = await rotationEpochProbe.epoch(input.sourceId);
            } catch {
                throw new SafeLogReaderError("unavailable");
            }
            const readResult = await readWindow(
                reference,
                generationTracker.previousCheckpoint(input.sourceId),
                checkpointKey
            );
            let rotationEpochAfter: string | undefined;
            try {
                rotationEpochAfter = await rotationEpochProbe.epoch(input.sourceId);
            } catch {
                throw new SafeLogReaderError("unavailable");
            }
            if (rotationEpochBefore !== rotationEpochAfter) {
                throw new SafeLogReaderError("source-changed");
            }
            const generation = generationTracker.record(
                input.sourceId,
                readResult,
                rotationEpochAfter
            );
            const revision = sha256(
                "mira-log-revision-v2\0",
                readResult.revision,
                "\0",
                rotationEpochAfter ?? "unmanaged"
            );
            const selection = select(readResult);
            return snapshot(
                input.sourceId,
                readResult,
                now,
                generation,
                revision,
                selection
            );
        });
    }
    const reader: SafeLogReader = {
        async search(input: SearchLogsInput) {
            const normalizedQuery = input.query.toLowerCase();
            return snapshotFor(input, (readResult) =>
                selectSearchPhysicalLines(
                    readResult.content,
                    readResult.contentStart,
                    input.limit,
                    normalizedQuery
                )
            );
        },
        async tail(input: TailLogsInput) {
            return snapshotFor(input, (readResult) =>
                selectPhysicalLines(
                    readResult.content,
                    readResult.contentStart,
                    input.limit,
                    () => true
                )
            );
        },
    };
    return Object.freeze(reader);
}
