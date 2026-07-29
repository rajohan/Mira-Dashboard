import fs from "node:fs";
import path from "node:path";

import type {
    DashboardLogContentResponse,
    LogContent,
    LogFile,
    OpenClawLogContentResponse,
    OpenClawLogFilesResponse,
} from "../../../contracts/logs.ts";
import { json } from "../http.ts";
import { guardedPath, openReadNoFollowNonblockingGuarded } from "../lib/guardedOps.ts";
import {
    formatOpenClawLogDate,
    logUnavailableReason,
    resolveRealLogsDirectory,
} from "../lib/logRoots.ts";
import { lineEntriesFromLogRead, type LogRead } from "../lib/logTail.ts";
import { runProcess, type RunProcessResult } from "../lib/processes.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { routeFailureResponse } from "../routeSupport.ts";

const logger = createStructuredLogger("logs");

const MIN_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_LINE_COUNT = 5000;
const MAX_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const DASHBOARD_LOG_DEFAULT_LINES = 100;
const DASHBOARD_LOG_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DASHBOARD_LOG_TIMEOUT_MS = 5000;
const DEVELOPMENT_APPLICATION_LOG_FILE = "dashboard.ndjson";
const DASHBOARD_JOURNAL_UNITS = [
    "mira-dashboard.service",
    "mira-dashboard-worker.service",
] as const;
const LOG_NOT_FOUND_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);
const LOG_PATH_UNREADABLE_ERROR_CODES = new Set([
    "ELOOP",
    "ENOENT",
    "ENOTDIR",
    "ERR_INVALID_ARG_VALUE",
]);

function unavailableLogInfoResponse(
    reason = logUnavailableReason() || "The log directory is unavailable."
): Response {
    return json({
        logs: [],
        unavailableReason: reason,
    } satisfies OpenClawLogFilesResponse);
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
        const unavailableReason = logUnavailableReason();
        if (unavailableReason) {
            return unavailableLogInfoResponse(unavailableReason);
        }

        let realRoot: string;
        try {
            realRoot = resolveRealLogsDirectory();
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return unavailableLogInfoResponse();
            }
            throw error;
        }

        let names: string[];
        try {
            names = fs.readdirSync(realRoot);
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return unavailableLogInfoResponse();
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
                return [
                    {
                        modified: stat.mtime.toISOString(),
                        name: fileName,
                        size: stat.size,
                    },
                ];
            })
            .toSorted((a, b) => b.modified.localeCompare(a.modified));

        return json({ logs: files } satisfies OpenClawLogFilesResponse);
    } catch (error) {
        logger.error("logs.files_list_failed", { error });
        return routeFailureResponse({
            context: "log",
            message: "Failed to list log files",
            status: 500,
        });
    }
}

async function logContentResponse(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    let logFile = query.get("file") || undefined;
    const lines = parsePositiveLineCount(query.get("lines"));
    if (lines === undefined && query.has("lines")) {
        return routeFailureResponse({
            context: "log",
            message: "Invalid lines",
            status: 400,
        });
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
        return routeFailureResponse({
            context: "log",
            message: "Log file not found",
            status: 404,
        });
    }

    try {
        let realRoot: string;
        try {
            realRoot = resolveRealLogsDirectory();
        } catch (error) {
            if (isLogNotFoundErrorCode((error as NodeJS.ErrnoException).code)) {
                return routeFailureResponse({
                    context: "log",
                    message: "Log file not found",
                    status: 404,
                });
            }
            throw error;
        }

        const candidatePath = path.resolve(realRoot, logFile);
        if (candidatePath === realRoot) {
            return routeFailureResponse({
                context: "log",
                message: "Log file not found",
                status: 404,
            });
        }
        if (!candidatePath.startsWith(`${realRoot}${path.sep}`)) {
            return routeFailureResponse({
                context: "log",
                message: "Access denied",
                status: 403,
            });
        }

        let file: fs.promises.FileHandle;
        try {
            file = await openReadNoFollowNonblockingGuarded(guardedPath(candidatePath));
        } catch (error) {
            if (isLogPathUnreadableErrorCode((error as NodeJS.ErrnoException).code)) {
                return routeFailureResponse({
                    context: "log",
                    message: "Log file not found",
                    status: 404,
                });
            }
            logger.error("logs.file_open_failed", { error, file: logFileName });
            return routeFailureResponse({
                context: "log",
                message: "Failed to open log file",
                status: 500,
            });
        }

        let content: LogContent;
        try {
            const stat = await file.stat();
            if (!stat.isFile()) {
                return routeFailureResponse({
                    context: "log",
                    message: "Log file not found",
                    status: 404,
                });
            }
            if (!isOpenedLogPathWithinRoot(file, realRoot) || stat.nlink > 1) {
                return routeFailureResponse({
                    context: "log",
                    message: "Access denied",
                    status: 403,
                });
            }
            content = lineContentWithIds(await readLogContent(file, stat, lines), lines);
        } finally {
            await file.close();
        }

        return json({
            content: content.content,
            file: logFile,
            lineIds: content.lineIds,
        } satisfies OpenClawLogContentResponse);
    } catch (error) {
        logger.error("logs.file_read_failed", { error, file: logFileName });
        return routeFailureResponse({
            context: "log",
            message: "Failed to read log file",
            status: 500,
        });
    }
}

interface JournalRecord {
    MESSAGE?: unknown;
    __CURSOR?: unknown;
    __REALTIME_TIMESTAMP?: unknown;
}

type JournalRunner = (
    executable: string,
    arguments_: readonly string[],
    options: {
        maxBuffer: number;
        timeoutMs: number;
    }
) => Promise<RunProcessResult>;

function journalEntry(
    raw: string,
    index: number
): { line: string; lineId: string } | undefined {
    if (!raw.trim()) return undefined;
    try {
        const record = JSON.parse(raw) as JournalRecord;
        if (typeof record.MESSAGE !== "string" || !record.MESSAGE.trim()) {
            return undefined;
        }
        const cursor =
            typeof record.__CURSOR === "string" && record.__CURSOR
                ? record.__CURSOR
                : undefined;
        const timestamp =
            typeof record.__REALTIME_TIMESTAMP === "string" && record.__REALTIME_TIMESTAMP
                ? record.__REALTIME_TIMESTAMP
                : "journal";
        return {
            line: record.MESSAGE,
            lineId: cursor ?? `${timestamp}:${index}`,
        };
    } catch {
        return undefined;
    }
}

/**
 * Reads the fixed Dashboard web/worker journal units without accepting command input.
 * @param lines Lines value.
 * @param runner Runner value.
 * @returns Read the fixed Dashboard web/worker journal units without accepting command input.
 */
export async function readDashboardJournal(
    lines: number,
    runner: JournalRunner = runProcess
): Promise<LogContent> {
    const result = await runner(
        "/usr/bin/journalctl",
        [
            "--user",
            "--no-pager",
            "--quiet",
            "--output=json",
            "--lines",
            String(lines),
            ...DASHBOARD_JOURNAL_UNITS.flatMap((unit) => ["--unit", unit]),
        ],
        {
            maxBuffer: DASHBOARD_LOG_MAX_BUFFER_BYTES,
            timeoutMs: DASHBOARD_LOG_TIMEOUT_MS,
        }
    );
    if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "journalctl failed");
    }
    const entries = result.stdout
        .split("\n")
        .map((line, index) => journalEntry(line, index))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    return {
        content: entries.map((entry) => entry.line).join("\n"),
        lineIds: entries.map((entry) => entry.lineId),
    };
}

async function dashboardLogContentResponse(request: Request): Promise<Response> {
    if (process.env.MIRA_DASHBOARD_DEV_SAFE_MODE === "1") {
        const configuredPath = process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH?.trim();
        if (!configuredPath) {
            return json({
                content: "",
                lineIds: [],
                unavailableReason: "Dashboard application log capture is not configured.",
            } satisfies DashboardLogContentResponse);
        }
        const resolvedPath = path.resolve(configuredPath);
        if (
            !path.isAbsolute(configuredPath) ||
            path.basename(resolvedPath) !== DEVELOPMENT_APPLICATION_LOG_FILE
        ) {
            logger.error("logs.dashboard_development_path_invalid");
            return routeFailureResponse({
                context: "log",
                message: "Dashboard application log capture is unavailable",
                status: 503,
            });
        }
        const query = new URL(request.url).searchParams;
        const parsedLines = parsePositiveLineCount(query.get("lines"));
        if (parsedLines === undefined && query.has("lines")) {
            return routeFailureResponse({
                context: "log",
                message: "Invalid lines",
                status: 400,
            });
        }
        let file: fs.promises.FileHandle;
        try {
            file = await openReadNoFollowNonblockingGuarded(guardedPath(resolvedPath));
        } catch (error) {
            if (isLogPathUnreadableErrorCode((error as NodeJS.ErrnoException).code)) {
                return json({
                    content: "",
                    lineIds: [],
                } satisfies DashboardLogContentResponse);
            }
            logger.error("logs.dashboard_development_file_open_failed", { error });
            return routeFailureResponse({
                context: "log",
                message: "Failed to read Dashboard logs",
                status: 503,
            });
        }
        try {
            const stat = await file.stat();
            const realParent = fs.realpathSync(path.dirname(resolvedPath));
            if (
                !stat.isFile() ||
                stat.nlink !== 1 ||
                !isOpenedLogPathWithinRoot(file, realParent)
            ) {
                return routeFailureResponse({
                    context: "log",
                    message: "Dashboard application log capture is unavailable",
                    status: 503,
                });
            }
            return json({
                ...lineContentWithIds(
                    await readLogContent(
                        file,
                        stat,
                        parsedLines ?? DASHBOARD_LOG_DEFAULT_LINES
                    ),
                    parsedLines ?? DASHBOARD_LOG_DEFAULT_LINES
                ),
            } satisfies DashboardLogContentResponse);
        } catch (error) {
            logger.error("logs.dashboard_development_file_read_failed", { error });
            return routeFailureResponse({
                context: "log",
                message: "Failed to read Dashboard logs",
                status: 503,
            });
        } finally {
            await file.close();
        }
    }
    const query = new URL(request.url).searchParams;
    const parsedLines = parsePositiveLineCount(query.get("lines"));
    if (parsedLines === undefined && query.has("lines")) {
        return routeFailureResponse({
            context: "log",
            message: "Invalid lines",
            status: 400,
        });
    }
    try {
        return json({
            ...(await readDashboardJournal(parsedLines ?? DASHBOARD_LOG_DEFAULT_LINES)),
        } satisfies DashboardLogContentResponse);
    } catch (error) {
        logger.error("logs.dashboard_journal_read_failed", { error });
        return routeFailureResponse({
            context: "log",
            message: "Failed to read Dashboard logs",
            status: 503,
        });
    }
}

export const logRoutes = {
    "/api/logs/dashboard": {
        GET: dashboardLogContentResponse,
    },
    "/api/logs/openclaw/content": {
        GET: logContentResponse,
    },
    "/api/logs/openclaw/files": {
        GET: logInfoResponse,
    },
} as const;
