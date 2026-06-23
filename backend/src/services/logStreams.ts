import fs from "node:fs";
import path from "node:path";

import type { DashboardSocket } from "../dashboardSocket.ts";
import { errorMessage } from "../lib/errors.ts";
import { guardedPath, openReadNoFollowNonblockingGuarded } from "../lib/guardedOps.ts";
import { resolveRealLogsDirectory } from "../lib/logRoots.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

const logsRouteState: {
    logWatcher: NodeJS.Timeout | undefined;
    isLogPollInFlight: boolean;
    lastLogSize: number;
    lastLogFile: string;
    pendingFragment: string;
} = {
    logWatcher: undefined,
    isLogPollInFlight: false,
    lastLogSize: 0,
    lastLogFile: "",
    pendingFragment: "",
};

const logSubscribers = new Set<DashboardSocket>();
const MIN_LOG_TAIL_BYTES = 64 * 1024;
const LOG_BYTES_PER_REQUESTED_LINE = 1024;
const LOG_TAIL_READ_CHUNK_BYTES = 64 * 1024;
const MAX_LOG_TAIL_BYTES = 8 * 1024 * 1024;
const LOG_ROOT_RESOLUTION_ERROR_CODES = new Set([
    "ELOOP",
    "ENOENT",
    "ENOTDIR",
    "ERR_INVALID_ARG_VALUE",
]);

function isLogRootResolutionError(error: unknown): boolean {
    return LOG_ROOT_RESOLUTION_ERROR_CODES.has(
        (error as NodeJS.ErrnoException).code ?? ""
    );
}

/** Returns today log file. */
function getTodayLogFile(root = resolveRealLogsDirectory()): string {
    const today = dateToISOString(new Date()).split("T", 1)[0];
    return path.join(root, "openclaw-" + today + ".log");
}

async function readLogContent(
    file: fs.promises.FileHandle,
    stat: fs.Stats,
    lines: number | undefined
): Promise<string> {
    if (!lines) {
        const byteLength = Math.min(stat.size, MIN_LOG_TAIL_BYTES);
        const buffer = Buffer.allocUnsafe(byteLength);
        const offset = Math.max(0, stat.size - byteLength);
        const { bytesRead } = await file.read(buffer, 0, byteLength, offset);
        return buffer.subarray(0, bytesRead).toString("utf8");
    }

    const readWindowBytes = Math.min(
        stat.size,
        MAX_LOG_TAIL_BYTES,
        Math.max(MIN_LOG_TAIL_BYTES, lines * LOG_BYTES_PER_REQUESTED_LINE)
    );
    const chunks: Buffer[] = [];
    let offset = stat.size;
    let bytesReadTotal = 0;

    while (offset > 0 && bytesReadTotal < readWindowBytes) {
        const chunkBytes = Math.min(LOG_TAIL_READ_CHUNK_BYTES, offset);
        offset -= chunkBytes;
        const buffer = Buffer.allocUnsafe(chunkBytes);
        const { bytesRead } = await file.read(buffer, 0, chunkBytes, offset);
        if (bytesRead <= 0) {
            break;
        }
        const chunk = buffer.subarray(0, bytesRead);
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
        if (isLogRootResolutionError(error)) return;
        throw error;
    }

    let file: fs.promises.FileHandle | undefined;
    try {
        file = await openReadNoFollowNonblockingGuarded(guardedPath(logFile));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }

    try {
        const stat = await file.stat();
        if (!stat.isFile()) return;

        if (logFile !== logsRouteState.lastLogFile) {
            const isInitialStartup = !logsRouteState.lastLogFile;
            logsRouteState.lastLogFile = logFile;
            logsRouteState.lastLogSize = isInitialStartup ? stat.size : 0;
            logsRouteState.pendingFragment = "";
        }

        if (stat.size < logsRouteState.lastLogSize) {
            logsRouteState.lastLogSize = 0;
            logsRouteState.pendingFragment = "";
        }

        if (stat.size > logsRouteState.lastLogSize) {
            const deltaBytes = stat.size - logsRouteState.lastLogSize;
            const readBytes = Math.min(deltaBytes, LOG_TAIL_READ_CHUNK_BYTES);
            const readOffset =
                deltaBytes > LOG_TAIL_READ_CHUNK_BYTES
                    ? stat.size - readBytes
                    : logsRouteState.lastLogSize;
            if (deltaBytes > LOG_TAIL_READ_CHUNK_BYTES) {
                logsRouteState.pendingFragment = "";
            }
            const buffer = Buffer.alloc(readBytes);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, readOffset);
            if (bytesRead <= 0) return;

            const text =
                logsRouteState.pendingFragment +
                buffer.subarray(0, bytesRead).toString("utf8");
            const parts = text.split("\n");
            if (deltaBytes > LOG_TAIL_READ_CHUNK_BYTES) {
                parts.shift();
            }
            logsRouteState.pendingFragment = parts.pop() ?? "";
            const lines = parts.filter((line) => line.trim());
            if (logsRouteState.pendingFragment.length > LOG_TAIL_READ_CHUNK_BYTES) {
                lines.push(logsRouteState.pendingFragment);
                logsRouteState.pendingFragment = "";
            }
            logsRouteState.lastLogSize = readOffset + bytesRead;

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
async function sendLogHistory(ws: DashboardSocket): Promise<void> {
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
        const subscriberCountAtStart = logSubscribers.size;
        const logFile = getTodayLogFile();
        const fileName = path.basename(logFile);

        // Send file name
        send({ type: "log_file", file: fileName });

        let file: fs.promises.FileHandle;
        try {
            file = await openReadNoFollowNonblockingGuarded(guardedPath(logFile));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            logsRouteState.lastLogFile = logFile;
            logsRouteState.lastLogSize = 0;
            logsRouteState.pendingFragment = "";
            send({ type: "log_history_complete", count: 0 });
            return;
        }

        let lines: string[];
        try {
            const stat = await file.stat();
            if (!stat.isFile()) {
                send({ type: "log_history_complete", count: 0 });
                return;
            }
            if (subscriberCountAtStart <= 1 || !logsRouteState.lastLogFile) {
                logsRouteState.lastLogFile = logFile;
                logsRouteState.lastLogSize = stat.size;
                logsRouteState.pendingFragment = "";
            }
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
export function subscribeToLogs(ws: DashboardSocket): void {
    logSubscribers.add(ws);

    // Send log history first
    void sendLogHistory(ws);

    // Start watching for new logs
    startLogWatcher();
}

/** Performs unsubscribe from logs. */
export function unsubscribeFromLogs(ws: DashboardSocket): void {
    logSubscribers.delete(ws);
    if (logSubscribers.size === 0 && logsRouteState.logWatcher) {
        clearInterval(logsRouteState.logWatcher);
        logsRouteState.logWatcher = undefined;
    }
}
