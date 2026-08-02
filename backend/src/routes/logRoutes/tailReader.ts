import fs from "node:fs";
import path from "node:path";

import type { LogContent } from "../../../../contracts/logs.ts";
import { lineEntriesFromLogRead, type LogRead } from "../../lib/logTail.ts";

const MIN_LOG_TAIL_BYTES = 64 * 1024;
export const MAX_LOG_LINE_COUNT = 5000;
const MAX_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const LOG_NOT_FOUND_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);
const LOG_PATH_UNREADABLE_ERROR_CODES = new Set([
    "ELOOP",
    "ENOENT",
    "ENOTDIR",
    "ERR_INVALID_ARG_VALUE",
]);

export function isLogNotFoundErrorCode(code: string | undefined): boolean {
    return code !== undefined && LOG_NOT_FOUND_ERROR_CODES.has(code);
}

export function isLogPathUnreadableErrorCode(code: string | undefined): boolean {
    return code !== undefined && LOG_PATH_UNREADABLE_ERROR_CODES.has(code);
}

export function isOpenedLogPathWithinRoot(
    file: fs.promises.FileHandle,
    root: string
): boolean {
    if (process.platform !== "linux") return true;
    try {
        const openedPath = fs.realpathSync(`/proc/self/fd/${file.fd}`);
        const relativeOpenedPath = path.relative(root, openedPath);
        return (
            !relativeOpenedPath.startsWith("..") && !path.isAbsolute(relativeOpenedPath)
        );
    } catch {
        return false;
    }
}

export function parsePositiveLineCount(value: unknown): number | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, MAX_LOG_LINE_COUNT)
        : undefined;
}

async function readLogContent(
    file: fs.promises.FileHandle,
    stat: fs.Stats,
    lines: number | undefined
): Promise<LogRead> {
    if (!lines) {
        const byteLength = Math.min(stat.size, MIN_LOG_TAIL_BYTES);
        const buffer = Buffer.allocUnsafe(byteLength);
        const offset = Math.max(0, stat.size - byteLength);
        const { bytesRead } = await file.read(buffer, 0, byteLength, offset);
        const bytes = buffer.subarray(0, bytesRead);
        return {
            bytes,
            content: bytes.toString("utf8"),
            startOffset: offset,
            startsAtLineBoundary: await readStartsAtLineBoundary(file, offset),
        };
    }

    const chunks: Buffer[] = [];
    let offset = stat.size;
    let bytesReadTotal = 0;
    let nonEmptyLineCount = 0;
    let leadingPartialLine = "";

    while (
        offset > 0 &&
        bytesReadTotal < MAX_LOG_TAIL_BYTES &&
        (bytesReadTotal < MIN_LOG_TAIL_BYTES || nonEmptyLineCount <= lines)
    ) {
        const chunkBytes = Math.min(LOG_TAIL_READ_CHUNK_BYTES, offset);
        offset -= chunkBytes;
        const buffer = Buffer.allocUnsafe(chunkBytes);
        const { bytesRead } = await file.read(buffer, 0, chunkBytes, offset);
        if (bytesRead <= 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        chunks.unshift(chunk);
        bytesReadTotal += bytesRead;
        const linesInWindowPrefix =
            `${chunk.toString("utf8")}${leadingPartialLine}`.split("\n");
        leadingPartialLine = linesInWindowPrefix[0] ?? "";
        nonEmptyLineCount += linesInWindowPrefix
            .slice(offset > 0 ? 1 : 0)
            .filter((line) => line.trim()).length;
    }

    const bytes = Buffer.concat(chunks, bytesReadTotal);
    return {
        bytes,
        content: bytes.toString("utf8"),
        startOffset: offset,
        startsAtLineBoundary: await readStartsAtLineBoundary(file, offset),
    };
}

async function readStartsAtLineBoundary(
    file: fs.promises.FileHandle,
    offset: number
): Promise<boolean> {
    if (offset === 0) {
        return true;
    }

    const previousByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await file.read(previousByte, 0, 1, offset - 1);
    return bytesRead === 1 && previousByte[0] === 10;
}

export async function lineContentWithIds(
    file: fs.promises.FileHandle,
    stat: fs.Stats,
    lines: number | undefined
): Promise<LogContent> {
    const entries = lineEntriesFromLogRead(
        await readLogContent(file, stat, lines),
        lines,
        {
            includeBlankLines: true,
        }
    );

    return {
        content: entries.map((entry) => entry.line).join("\n"),
        lineIds: entries.map((entry) => entry.lineId),
    };
}
