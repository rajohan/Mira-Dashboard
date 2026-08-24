import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";

import {
    logReadWindowMaximumBytes,
    type LogLine,
    type LogSnapshotOutput,
    type SearchLogsInput,
    type TailLogsInput,
} from "../../../contracts/logs.ts";
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
}

interface ReadWindow {
    readonly lines: readonly PhysicalLine[];
    readonly revision: string;
    readonly scannedBytes: number;
    readonly startedAfterBeginning: boolean;
}

function sha256(...values: readonly (Buffer | string)[]): string {
    const hash = createHash("sha256");
    for (const value of values) hash.update(value);
    return hash.digest("hex");
}

function openFlags(): number {
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function splitPhysicalLines(buffer: Buffer, absoluteStart: number): PhysicalLine[] {
    const lines: PhysicalLine[] = [];
    let lineStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 10) continue;
        const end = index > lineStart && buffer[index - 1] === 13 ? index - 1 : index;
        lines.push({
            bytes: buffer.subarray(lineStart, end),
            offset: absoluteStart + lineStart,
        });
        lineStart = index + 1;
    }
    if (lineStart < buffer.length) {
        lines.push({
            bytes: buffer.subarray(lineStart),
            offset: absoluteStart + lineStart,
        });
    }
    return lines;
}

async function readWindow(reference: LogSourceReference): Promise<ReadWindow> {
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
        const before = await file.stat();
        if (
            !before.isFile() ||
            before.nlink !== 1 ||
            !reference.trustedOwnerIds.includes(before.uid) ||
            (before.mode & 0o022) !== 0 ||
            !Number.isSafeInteger(before.size)
        ) {
            throw new SafeLogReaderError("unavailable");
        }

        const startedAfterBeginning = before.size > logReadWindowMaximumBytes;
        const start = Math.max(0, before.size - logReadWindowMaximumBytes);
        const prefixStart = start === 0 ? 0 : start - 1;
        const length = before.size - prefixStart;
        const buffer = Buffer.allocUnsafe(length);
        let bytesRead = 0;
        while (bytesRead < length) {
            const result = await file.read(
                buffer,
                bytesRead,
                length - bytesRead,
                prefixStart + bytesRead
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        const observed = buffer.subarray(0, bytesRead);
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

        const after = await file.stat();
        if (
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs
        ) {
            throw new SafeLogReaderError("source-changed");
        }
        const revision = sha256(
            reference.id,
            String(before.dev),
            String(before.ino),
            String(before.size),
            String(before.mtimeMs)
        );
        return {
            lines: splitPhysicalLines(content, contentStart),
            revision,
            scannedBytes: observed.length,
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

function projectLine(sourceId: string, physical: PhysicalLine): LogLine {
    const raw = physical.bytes.toString("utf8");
    const line = redactLogLine(raw);
    const timestampMs = parseLogTimestamp(line);
    return {
        id: sha256(sourceId, String(physical.offset), line),
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
    window: ReadWindow,
    candidates: readonly PhysicalLine[],
    limit: number,
    now: () => number
): LogSnapshotOutput {
    const selected = candidates.slice(-limit);
    return {
        hasEarlier: window.startedAfterBeginning || candidates.length > selected.length,
        lines: selected.map((line) => projectLine(sourceId, line)),
        observedAtMs: now(),
        revision: window.revision,
        scannedBytes: window.scannedBytes,
        sourceId,
    };
}

export interface SafeLogReader {
    readonly search: (input: SearchLogsInput) => Promise<LogSnapshotOutput>;
    readonly tail: (input: TailLogsInput) => Promise<LogSnapshotOutput>;
}

/**
 * Creates a bounded descriptor-rooted reader over named catalog references.
 * @param catalog Path-free catalog that owns the fixed source mapping.
 * @param now Replaceable observation clock.
 * @returns Tail and search operations that emit only redacted text.
 */
export function createSafeLogReader(
    catalog: LogSourceCatalog,
    now: () => number = Date.now
): SafeLogReader {
    const reader: SafeLogReader = {
        async search(input: SearchLogsInput) {
            const reference = await referenceFor(catalog, input.sourceId);
            const window = await readWindow(reference);
            const normalizedQuery = input.query.toLowerCase();
            const matches = window.lines.filter((physical) =>
                redactLogLine(physical.bytes.toString("utf8"))
                    .toLowerCase()
                    .includes(normalizedQuery)
            );
            return snapshot(input.sourceId, window, matches, input.limit, now);
        },
        async tail(input: TailLogsInput) {
            const reference = await referenceFor(catalog, input.sourceId);
            const window = await readWindow(reference);
            return snapshot(input.sourceId, window, window.lines, input.limit, now);
        },
    };
    return Object.freeze(reader);
}
