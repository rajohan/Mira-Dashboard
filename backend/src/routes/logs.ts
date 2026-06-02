import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";
import type WebSocket from "ws";

import { errorMessage } from "../lib/errors.js";
import { guardedPath, openReadNoFollowGuarded } from "../lib/guardedOps.js";

let logsDir = "/tmp/openclaw";
let realLogsDir = path.resolve(logsDir);
let logWatcher: NodeJS.Timeout | null = null;
let logPollInFlight = false;
let lastLogSize = 0;
let lastLogFile = "";
const logSubscribers = new Set<WebSocket>();

/** Represents log file. */
interface LogFile {
    name: string;
    size: number;
    modified: Date;
}

/** Returns today log file. */
function getTodayLogFile(): string {
    const today = new Date().toISOString().split("T")[0];
    return path.join(realLogsDir, "openclaw-" + today + ".log");
}

/** Polls the current OpenClaw log once, serialized by startLogWatcher. */
async function pollLogFile(): Promise<void> {
    const logFile = getTodayLogFile();

    let file: fs.promises.FileHandle | undefined;
    try {
        file = await openReadNoFollowGuarded(guardedPath(logFile));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }

    try {
        const stat = await file.stat();

        if (logFile !== lastLogFile) {
            lastLogFile = logFile;
            lastLogSize = stat.size;
            return;
        }

        if (stat.size < lastLogSize) {
            lastLogSize = 0;
        }

        if (stat.size > lastLogSize) {
            const buffer = Buffer.alloc(stat.size - lastLogSize);
            await file.read(buffer, 0, buffer.length, lastLogSize);

            const lines = buffer
                .toString("utf8")
                .split("\n")
                .filter((l) => l.trim());
            lastLogSize = stat.size;

            for (const line of lines) {
                const msg = JSON.stringify({ type: "log", line });
                for (const ws of logSubscribers) {
                    try {
                        ws.send(msg);
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
function runLogWatcherTick(): void {
    if (logPollInFlight) return;
    logPollInFlight = true;
    void pollLogFile()
        .catch((error: unknown) => {
            console.error("[LogWatcher] Error:", errorMessage(error, String(error)));
        })
        .finally(() => {
            logPollInFlight = false;
        });
}

/** Performs start log watcher. */
function startLogWatcher(): void {
    if (logWatcher) return;

    logWatcher = setInterval(runLogWatcherTick, 1000);
}

/** Performs send log history. */
async function sendLogHistory(ws: WebSocket): Promise<void> {
    const send = (payload: unknown) => {
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

        const content = await file.readFile("utf8").finally(() => file.close());
        const lines = content
            .split("\n")
            .filter((l) => l.trim())
            .slice(-100);

        // Send each line
        for (const line of lines) {
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
export const __testing = {
    pollLogFileForTest: pollLogFile,
    runLogWatcherTickForTest: runLogWatcherTick,
    resetLogWatcherForTest(): void {
        if (logWatcher) {
            clearInterval(logWatcher);
        }
        logWatcher = null;
        logPollInFlight = false;
        lastLogSize = 0;
        lastLogFile = "";
        logSubscribers.clear();
    },
    subscriberCount(): number {
        return logSubscribers.size;
    },
    setLogsDirForTest(nextLogsDir: string): void {
        this.resetLogWatcherForTest();
        const resolvedLogsDir = path.resolve(nextLogsDir);
        logsDir = resolvedLogsDir;
        try {
            realLogsDir = fs.realpathSync(resolvedLogsDir);
        } catch {
            realLogsDir = resolvedLogsDir;
        }
    },
};

/** Registers logs API routes. */
export default function logsRoutes(app: express.Application): void {
    // Get log files info
    app.get("/api/logs/info", (async (_req, res) => {
        try {
            let realRoot: string;
            try {
                realRoot = fs.realpathSync(realLogsDir);
                realLogsDir = realRoot;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    res.json({ logs: [] });
                    return;
                }
                throw error;
            }
            if (!fs.existsSync(realRoot)) {
                res.json({ logs: [] });
                return;
            }

            let names: string[];
            try {
                names = fs.readdirSync(realRoot);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    res.json({ logs: [] });
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
                        if (code === "ENOENT" || code === "ENOTDIR") {
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

            res.json({ logs: files });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Get log file content
    app.get("/api/logs/content", (async (req, res) => {
        let logFile = req.query.file as string | undefined;
        const lines = req.query.lines
            ? Number.parseInt(req.query.lines as string, 10)
            : null;

        // If no file specified, use today's log
        if (!logFile) {
            const today = new Date().toISOString().split("T")[0];
            logFile = "openclaw-" + today + ".log";
        }

        try {
            let realRoot: string;
            try {
                realRoot = fs.realpathSync(realLogsDir);
                realLogsDir = realRoot;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") {
                    res.status(404).json({ error: "Log file not found" });
                    return;
                }
                throw error;
            }

            const candidatePath = path.resolve(realRoot, logFile);

            if (candidatePath === realRoot) {
                res.status(404).json({ error: "Log file not found" });
                return;
            }

            if (!candidatePath.startsWith(realRoot + path.sep)) {
                res.status(403).json({ error: "Access denied" });
                return;
            }

            let filePath: string;
            try {
                filePath = fs.realpathSync(candidatePath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (
                    code === "ENOENT" ||
                    code === "ENOTDIR" ||
                    code === "ELOOP" ||
                    code === "ERR_INVALID_ARG_VALUE"
                ) {
                    res.status(404).json({ error: "Log file not found" });
                    return;
                }
                throw error;
            }
            if (filePath === realRoot) {
                res.status(404).json({ error: "Log file not found" });
                return;
            }

            if (!filePath.startsWith(realRoot + path.sep)) {
                res.status(403).json({ error: "Access denied" });
                return;
            }

            let file: fs.promises.FileHandle;
            try {
                file = await openReadNoFollowGuarded(guardedPath(filePath));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
                    res.status(404).json({ error: "Log file not found" });
                    return;
                }
                console.error("[Logs] Failed to open log file:", error);
                res.status(500).json({
                    detail: errorMessage(error, "Unknown error"),
                    error: "Failed to open log file",
                });
                return;
            }

            let content: string;
            try {
                content = await file.readFile("utf8");
            } finally {
                await file.close();
            }

            if (lines) {
                const allLines = content.split("\n").filter((l) => l.trim());
                content = allLines.slice(-lines).join("\n");
            }

            res.json({ content: content, file: logFile });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
