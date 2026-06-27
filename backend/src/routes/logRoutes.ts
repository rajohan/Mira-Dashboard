import fs from "node:fs";
import path from "node:path";

import { json } from "../http.ts";
import { guardedPath, openReadNoFollowNonblockingGuarded } from "../lib/guardedOps.ts";
import { formatOpenClawLogDate, resolveRealLogsDirectory } from "../lib/logRoots.ts";
import { lineEntriesFromLogRead, type LogRead } from "../lib/logTail.ts";

const MIN_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_LINE_COUNT = 5000;
const MAX_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const LOG_NOT_FOUND_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);
const LOG_PATH_UNREADABLE_ERROR_CODES = new Set([
    "ELOOP",
    "ENOENT",
    "ENOTDIR",
    "ERR_INVALID_ARG_VALUE",
]);

interface LogFile {
    modified: Date;
    name: string;
    size: number;
}

interface LogContent {
    content: string;
    lineIds: string[];
}

function isLogNotFoundErrorCode(code: string | undefined): boolean {
    return code !== undefined && LOG_NOT_FOUND_ERROR_CODES.has(code);
}

function isLogPathUnreadableErrorCode(code: string | undefined): boolean {
    return code !== undefined && LOG_PATH_UNREADABLE_ERROR_CODES.has(code);
}

function isOpenedLogPathWithinRoot(file: fs.promises.FileHandle, root: string): boolean {
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

function parsePositiveLineCount(value: unknown): number | undefined {
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

function lineContentWithIds(read: LogRead, lines: number | undefined): LogContent {
    const entries = lineEntriesFromLogRead(read, lines, { includeBlankLines: true });

    return {
        content: entries.map((entry) => entry.line).join("\n"),
        lineIds: entries.map((entry) => entry.lineId),
    };
}

function logInfoResponse(): Response {
    try {
        let realRoot: string;
        try {
            realRoot = resolveRealLogsDirectory();
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return json({ logs: [] });
            }
            throw error;
        }

        let names: string[];
        try {
            names = fs.readdirSync(realRoot);
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return json({ logs: [] });
            }
            throw error;
        }

        const files: LogFile[] = names
            .filter(
                (fileName) =>
                    fileName.startsWith("openclaw-") && fileName.endsWith(".log")
            )
            .flatMap((fileName) => {
                let stat: fs.Stats;
                try {
                    stat = fs.lstatSync(path.join(realRoot, fileName));
                } catch (error) {
                    if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                        return [];
                    }
                    throw error;
                }
                if (!stat.isFile() || stat.isSymbolicLink()) return [];
                return [{ modified: stat.mtime, name: fileName, size: stat.size }];
            })
            .toSorted((a, b) => b.modified.getTime() - a.modified.getTime());

        return json({ logs: files });
    } catch (error) {
        console.error("[Logs] Failed to list log files:", error);
        return json({ error: "Failed to list log files" }, { status: 500 });
    }
}

async function logContentResponse(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    let logFile = query.get("file") || undefined;
    const lines = parsePositiveLineCount(query.get("lines"));
    if (query.has("lines") && lines === undefined) {
        return json({ error: "Invalid lines" }, { status: 400 });
    }

    if (!logFile) {
        const today = formatOpenClawLogDate(new Date());
        logFile = `openclaw-${today}.log`;
    }
    const logFileName = path.basename(logFile);
    if (
        logFile !== logFileName ||
        !logFileName.startsWith("openclaw-") ||
        !logFileName.endsWith(".log")
    ) {
        return json({ error: "Log file not found" }, { status: 404 });
    }

    try {
        let realRoot: string;
        try {
            realRoot = resolveRealLogsDirectory();
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return json({ error: "Log file not found" }, { status: 404 });
            }
            throw error;
        }

        const candidatePath = path.resolve(realRoot, logFile);
        if (candidatePath === realRoot) {
            return json({ error: "Log file not found" }, { status: 404 });
        }
        if (!candidatePath.startsWith(`${realRoot}${path.sep}`)) {
            return json({ error: "Access denied" }, { status: 403 });
        }

        let file: fs.promises.FileHandle;
        try {
            file = await openReadNoFollowNonblockingGuarded(guardedPath(candidatePath));
        } catch (error) {
            if (isLogPathUnreadableErrorCode((error as NodeJS.ErrnoException).code)) {
                return json({ error: "Log file not found" }, { status: 404 });
            }
            console.error("[Logs] Failed to open log file:", error);
            return json(
                { detail: "Internal server error", error: "Failed to open log file" },
                { status: 500 }
            );
        }

        let content: LogContent;
        try {
            const stat = await file.stat();
            if (!stat.isFile()) {
                return json({ error: "Log file not found" }, { status: 404 });
            }
            if (!isOpenedLogPathWithinRoot(file, realRoot) || stat.nlink > 1) {
                return json({ error: "Access denied" }, { status: 403 });
            }
            content = lineContentWithIds(await readLogContent(file, stat, lines), lines);
        } finally {
            await file.close();
        }

        return json({
            content: content.content,
            file: logFile,
            lineIds: content.lineIds,
        });
    } catch (error) {
        console.error("[Logs] Failed to read log file:", error);
        return json({ error: "Failed to read log file" }, { status: 500 });
    }
}

export const logRoutes = {
    "/api/logs/content": {
        GET: logContentResponse,
    },
    "/api/logs/info": {
        GET: logInfoResponse,
    },
} as const;
