import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";
import type WebSocket from "ws";

import { errorMessage } from "../lib/errors.ts";
import { guardedPath, openReadNoFollowGuarded } from "../lib/guardedOps.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const logsDirectory = "/tmp/openclaw";
const logsRouteState: {
    logWatcher: NodeJS.Timeout | null;
    isLogPollInFlight: boolean;
    lastLogSize: number;
    lastLogFile: string;
} = { logWatcher: null, isLogPollInFlight: false, lastLogSize: 0, lastLogFile: "" };

const logSubscribers = new Set<WebSocket>();
const MIN_LOG_TAIL_BYTES = 64 * 1024;
const LOG_BYTES_PER_REQUESTED_LINE = 1024;
const LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const LOG_NOT_FOUND_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);
const LOG_PATH_UNREADABLE_ERROR_CODES = new Set([
    "ELOOP",
    "ENOENT",
    "ENOTDIR",
    "ERR_INVALID_ARG_VALUE",
]);

/** Represents log file. */
interface LogFile {
    name: string;
    size: number;
    modified: Date;
}

function isLogNotFoundErrorCode(code: string | undefined): boolean {
    return code !== undefined && LOG_NOT_FOUND_ERROR_CODES.has(code);
}

function isLogPathUnreadableErrorCode(code: string | undefined): boolean {
    return code !== undefined && LOG_PATH_UNREADABLE_ERROR_CODES.has(code);
}

function resolveRealLogsDirectory(): string {
    return fs.realpathSync(logsDirectory);
}

/** Returns today log file. */
function getTodayLogFile(root = resolveRealLogsDirectory()): string {
    const today = dateToISOString(new Date()).split("T", 1)[0];
    return path.join(root, "openclaw-" + today + ".log");
}

function parsePositiveLineCount(value: unknown): number | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) {
        return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readLogContent(
    file: fs.promises.FileHandle,
    stat: fs.Stats,
    lines: number | null
): Promise<string> {
    if (!lines) {
        return file.readFile("utf8");
    }

    const minimumWindowBytes = Math.min(
        stat.size,
        Math.max(MIN_LOG_TAIL_BYTES, lines * LOG_BYTES_PER_REQUESTED_LINE)
    );
    const chunks: Buffer[] = [];
    let offset = stat.size;
    let bytesReadTotal = 0;
    let newlineCount = 0;

    while (offset > 0 && (bytesReadTotal < minimumWindowBytes || newlineCount <= lines)) {
        const chunkBytes = Math.min(LOG_TAIL_READ_CHUNK_BYTES, offset);
        offset -= chunkBytes;
        const buffer = Buffer.allocUnsafe(chunkBytes);
        const { bytesRead } = await file.read(buffer, 0, chunkBytes, offset);
        if (bytesRead <= 0) {
            break;
        }
        const chunk = buffer.subarray(0, bytesRead);
        for (const byte of chunk) {
            if (byte === 10) newlineCount += 1;
        }
        chunks.unshift(chunk);
        bytesReadTotal += bytesRead;
    }

    return Buffer.concat(chunks, bytesReadTotal).toString("utf8");
}

async function readLogTailLines(
    file: fs.promises.FileHandle,
    stat: fs.Stats,
    lineCount: number
): Promise<string[]> {
    const content = await readLogContent(file, stat, lineCount);
    return content
        .split("\n")
        .filter((line) => line.trim())
        .slice(-lineCount);
}

/** Polls the current OpenClaw log once, serialized by startLogWatcher. */
async function pollLogFile(): Promise<void> {
    let logFile: string;
    try {
        logFile = getTodayLogFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }

    let file: fs.promises.FileHandle | undefined;
    try {
        file = await openReadNoFollowGuarded(guardedPath(logFile));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }

    try {
        const stat = await file.stat();

        if (logFile !== logsRouteState.lastLogFile) {
            logsRouteState.lastLogFile = logFile;
            logsRouteState.lastLogSize = stat.size;
            return;
        }

        if (stat.size < logsRouteState.lastLogSize) {
            logsRouteState.lastLogSize = 0;
        }

        if (stat.size > logsRouteState.lastLogSize) {
            const buffer = Buffer.alloc(stat.size - logsRouteState.lastLogSize);
            await file.read(buffer, 0, buffer.length, logsRouteState.lastLogSize);

            const lines = buffer
                .toString("utf8")
                .split("\n")
                .filter((l) => l.trim());
            logsRouteState.lastLogSize = stat.size;

            for (const line of lines) {
                const message = JSON.stringify({ type: "log", line });
                for (const ws of logSubscribers) {
                    try {
                        ws.send(message);
                    } catch {
                        // Ignore errors from closed connections
                    }
                }
            }
        }
    } finally {
        await file.close();
    }
}

/** Performs a single tick of the log watcher. */
async function pollLogFileAndLogErrors(poller = pollLogFile): Promise<void> {
    try {
        await poller();
    } catch (error) {
        console.error("[LogWatcher] Error:", errorMessage(error, "Log polling failed"));
    }
}

/** Performs a single tick of the log watcher. */
function runLogWatcherTick(): void {
    if (logsRouteState.isLogPollInFlight) return;
    logsRouteState.isLogPollInFlight = true;
    void (async () => {
        await pollLogFileAndLogErrors();
        logsRouteState.isLogPollInFlight = false;
    })();
}

/** Performs start log watcher. */
function startLogWatcher(): void {
    if (logsRouteState.logWatcher) return;

    logsRouteState.logWatcher = setInterval(runLogWatcherTick, 1000);
}

/** Performs send log history. */
async function sendLogHistory(ws: WebSocket): Promise<void> {
    const send = (payload: unknown) => {
        if (!logSubscribers.has(ws)) {
            return;
        }
        try {
            ws.send(JSON.stringify(payload));
        } catch (error) {
            console.error("[Logs] Error sending history:", (error as Error).message);
        }
    };

    try {
        const logFile = getTodayLogFile();
        const fileName = path.basename(logFile);

        // Send file name
        send({ type: "log_file", file: fileName });

        let file: fs.promises.FileHandle;
        try {
            file = await openReadNoFollowGuarded(guardedPath(logFile));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            send({ type: "log_history_complete", count: 0 });
            return;
        }

        let lines: string[];
        try {
            const stat = await file.stat();
            lines = await readLogTailLines(file, stat, 100);
        } finally {
            await file.close();
        }

        // Send each line
        for (const line of lines) {
            if (!logSubscribers.has(ws)) {
                return;
            }
            send({ type: "log", line });
        }

        // Send completion
        send({ type: "log_history_complete", count: lines.length });
    } catch (error) {
        console.error("[Logs] Error sending history:", (error as Error).message);
        send({ type: "log_history_complete", count: 0 });
    }
}

/** Performs subscribe to logs. */
export function subscribeToLogs(ws: WebSocket): void {
    logSubscribers.add(ws);

    // Send log history first
    void sendLogHistory(ws);

    // Start watching for new logs
    startLogWatcher();
}

/** Performs unsubscribe from logs. */
export function unsubscribeFromLogs(ws: WebSocket): void {
    logSubscribers.delete(ws);
}

/** Defines testing. */

/** Registers logs API routes. */
export default function logsRoutes(app: express.Application): void {
    // Get log files info
    app.get("/api/logs/info", (async (_request, response) => {
        try {
            let realRoot: string;
            try {
                realRoot = resolveRealLogsDirectory();
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (isLogNotFoundErrorCode(code)) {
                    response.json({ logs: [] });
                    return;
                }
                throw error;
            }

            let names: string[];
            try {
                names = fs.readdirSync(realRoot);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (isLogNotFoundErrorCode(code)) {
                    response.json({ logs: [] });
                    return;
                }
                throw error;
            }

            const files: LogFile[] = names
                .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
                .flatMap((f) => {
                    let stat: fs.Stats;
                    try {
                        stat = fs.lstatSync(path.join(realRoot, f));
                    } catch (error) {
                        const code = (error as NodeJS.ErrnoException).code;
                        if (isLogNotFoundErrorCode(code)) {
                            return [];
                        }
                        throw error;
                    }
                    if (!stat.isFile() || stat.isSymbolicLink()) {
                        return [];
                    }
                    return [{ name: f, size: stat.size, modified: stat.mtime }];
                })
                .sort((a, b) => b.modified.getTime() - a.modified.getTime());

            response.json({ logs: files });
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Get log file content
    app.get("/api/logs/content", (async (request, response) => {
        let logFile = request.query.file as string | undefined;
        const lines = parsePositiveLineCount(request.query.lines);
        if (request.query.lines !== undefined && lines === null) {
            response.status(400).json({ error: "Invalid lines" });
            return;
        }

        // If no file specified, use today's log
        if (!logFile) {
            const today = dateToISOString(new Date()).split("T", 1)[0];
            logFile = "openclaw-" + today + ".log";
        }

        try {
            let realRoot: string;
            try {
                realRoot = resolveRealLogsDirectory();
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (isLogNotFoundErrorCode(code)) {
                    response.status(404).json({ error: "Log file not found" });
                    return;
                }
                throw error;
            }

            const candidatePath = path.resolve(realRoot, logFile);

            if (candidatePath === realRoot) {
                response.status(404).json({ error: "Log file not found" });
                return;
            }

            if (!candidatePath.startsWith(realRoot + path.sep)) {
                response.status(403).json({ error: "Access denied" });
                return;
            }

            let filePath: string;
            try {
                filePath = fs.realpathSync(candidatePath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (isLogPathUnreadableErrorCode(code)) {
                    response.status(404).json({ error: "Log file not found" });
                    return;
                }
                throw error;
            }
            if (filePath === realRoot) {
                response.status(404).json({ error: "Log file not found" });
                return;
            }

            if (!filePath.startsWith(realRoot + path.sep)) {
                response.status(403).json({ error: "Access denied" });
                return;
            }

            let file: fs.promises.FileHandle;
            try {
                file = await openReadNoFollowGuarded(guardedPath(filePath));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (isLogPathUnreadableErrorCode(code)) {
                    response.status(404).json({ error: "Log file not found" });
                    return;
                }
                console.error("[Logs] Failed to open log file:", error);
                response.status(500).json({
                    detail: "Internal server error",
                    error: "Failed to open log file",
                });
                return;
            }

            let content: string;
            try {
                const stat = await file.stat();
                if (!stat.isFile()) {
                    response.status(404).json({ error: "Log file not found" });
                    return;
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

            response.json({ content: content, file: logFile });
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
