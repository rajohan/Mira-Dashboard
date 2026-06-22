import fs from "node:fs";
import path from "node:path";

import { json } from "../http.ts";
import { guardedPath, openReadNoFollowNonblockingGuarded } from "../lib/guardedOps.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const logsDirectory = "/tmp/openclaw";
const MIN_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_LINE_COUNT = 5_000;
const MAX_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_BYTES_PER_REQUESTED_LINE = 1024;
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

function resolveRealLogsDirectory(): string {
    return fs.realpathSync(logsDirectory);
}

function parsePositiveLineCount(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, MAX_LOG_LINE_COUNT)
        : null;
}

async function readLogContent(
    file: fs.promises.FileHandle,
    stat: fs.Stats,
    lines: number | null
): Promise<string> {
    if (!lines) {
        const byteLength = Math.min(stat.size, MIN_LOG_TAIL_BYTES);
        const buffer = Buffer.allocUnsafe(byteLength);
        const offset = Math.max(0, stat.size - byteLength);
        const { bytesRead } = await file.read(buffer, 0, byteLength, offset);
        return buffer.subarray(0, bytesRead).toString("utf8");
    }

    const minimumWindowBytes = Math.min(
        stat.size,
        MAX_LOG_TAIL_BYTES,
        Math.max(MIN_LOG_TAIL_BYTES, lines * LOG_BYTES_PER_REQUESTED_LINE)
    );
    const chunks: Buffer[] = [];
    let offset = stat.size;
    let bytesReadTotal = 0;
    let newlineCount = 0;

    while (
        offset > 0 &&
        bytesReadTotal < MAX_LOG_TAIL_BYTES &&
        (bytesReadTotal < minimumWindowBytes || newlineCount <= lines)
    ) {
        const chunkBytes = Math.min(LOG_TAIL_READ_CHUNK_BYTES, offset);
        offset -= chunkBytes;
        const buffer = Buffer.allocUnsafe(chunkBytes);
        const { bytesRead } = await file.read(buffer, 0, chunkBytes, offset);
        if (bytesRead <= 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        for (const byte of chunk) {
            if (byte === 10) newlineCount += 1;
        }
        chunks.unshift(chunk);
        bytesReadTotal += bytesRead;
    }

    return Buffer.concat(chunks, bytesReadTotal).toString("utf8");
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
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());

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
    if (query.has("lines") && lines === null) {
        return json({ error: "Invalid lines" }, { status: 400 });
    }

    if (!logFile) {
        const today = dateToISOString(new Date()).split("T", 1)[0];
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

        let content: string;
        try {
            const stat = await file.stat();
            if (!stat.isFile()) {
                return json({ error: "Log file not found" }, { status: 404 });
            }
            if (!isOpenedLogPathWithinRoot(file, realRoot) || stat.nlink > 1) {
                return json({ error: "Access denied" }, { status: 403 });
            }
            content = await readLogContent(file, stat, lines);
        } finally {
            await file.close();
        }

        if (lines) {
            content = content
                .split("\n")
                .filter((line) => line.trim())
                .slice(-lines)
                .join("\n");
        }

        return json({ content, file: logFile });
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
