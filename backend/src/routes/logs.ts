import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";
import type WebSocket from "ws";

import { guardedPath } from "../lib/guardedOps.js";

const LOGS_DIR = "/tmp/openclaw";
const REAL_LOGS_DIR = path.resolve(LOGS_DIR);
let logWatcher: NodeJS.Timeout | null = null;
let lastLogSize = 0;
let lastLogFile = "";
const logSubscribers = new Set<WebSocket>();

interface LogFile {
    name: string;
    size: number;
    modified: Date;
}

function getTodayLogFile(): string {
    const today = new Date().toISOString().split("T")[0];
    return path.join(LOGS_DIR, "openclaw-" + today + ".log");
}

function startLogWatcher(): void {
    if (logWatcher) return;

    logWatcher = setInterval(() => {
        try {
            const logFile = getTodayLogFile();

            if (!fs.existsSync(logFile)) return;

            const stat = fs.statSync(logFile);

            if (logFile !== lastLogFile) {
                lastLogFile = logFile;
                lastLogSize = stat.size;
                return;
            }

            if (stat.size > lastLogSize) {
                const fd = fs.openSync(logFile, "r");
                const buffer = Buffer.alloc(stat.size - lastLogSize);
                fs.readSync(fd, buffer, 0, buffer.length, lastLogSize);
                fs.closeSync(fd);

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
        } catch (error) {
            console.error("[LogWatcher] Error:", (error as Error).message);
        }
    }, 1000);
}

function sendLogHistory(ws: WebSocket): void {
    try {
        const logFile = getTodayLogFile();
        const fileName = path.basename(logFile);

        // Send file name
        ws.send(JSON.stringify({ type: "log_file", file: fileName }));

        if (!fs.existsSync(logFile)) {
            // No log file yet
            ws.send(JSON.stringify({ type: "log_history_complete", count: 0 }));
            return;
        }

        // Read last 100 lines
        const content = fs.readFileSync(logFile, "utf8");
        const lines = content
            .split("\n")
            .filter((l) => l.trim())
            .slice(-100);

        // Send each line
        for (const line of lines) {
            ws.send(JSON.stringify({ type: "log", line }));
        }

        // Send completion
        ws.send(JSON.stringify({ type: "log_history_complete", count: lines.length }));
    } catch (error) {
        console.error("[Logs] Error sending history:", (error as Error).message);
        ws.send(JSON.stringify({ type: "log_history_complete", count: 0 }));
    }
}

export function subscribeToLogs(ws: WebSocket): void {
    logSubscribers.add(ws);

    // Send log history first
    sendLogHistory(ws);

    // Start watching for new logs
    startLogWatcher();
}

export function unsubscribeFromLogs(ws: WebSocket): void {
    logSubscribers.delete(ws);
}

export const __testing = {
    resetLogWatcherForTest(): void {
        if (logWatcher) {
            clearInterval(logWatcher);
        }
        logWatcher = null;
        lastLogSize = 0;
        lastLogFile = "";
        logSubscribers.clear();
    },
    subscriberCount(): number {
        return logSubscribers.size;
    },
};

export default function logsRoutes(app: express.Application): void {
    // Get log files info
    app.get("/api/logs/info", (async (_req, res) => {
        try {
            if (!fs.existsSync(LOGS_DIR)) {
                res.json({ logs: [] });
                return;
            }

            const files: LogFile[] = fs
                .readdirSync(LOGS_DIR)
                .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
                .map((f) => {
                    const stat = fs.statSync(path.join(LOGS_DIR, f));
                    return { name: f, size: stat.size, modified: stat.mtime };
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
                realRoot = fs.realpathSync(REAL_LOGS_DIR);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    res.status(404).json({ error: "Log file not found" });
                    return;
                }
                throw error;
            }

            const candidatePath = path.resolve(realRoot, logFile);

            if (
                candidatePath !== realRoot &&
                !candidatePath.startsWith(realRoot + path.sep)
            ) {
                res.status(403).json({ error: "Access denied" });
                return;
            }

            let filePath: string;
            try {
                filePath = fs.realpathSync(candidatePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    res.status(404).json({ error: "Log file not found" });
                    return;
                }
                throw error;
            }

            if (filePath !== realRoot && !filePath.startsWith(realRoot + path.sep)) {
                res.status(403).json({ error: "Access denied" });
                return;
            }

            let file: fs.promises.FileHandle;
            try {
                file = await fs.promises.open(
                    guardedPath(filePath),
                    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
                );
            } catch {
                res.status(404).json({ error: "Log file not found" });
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
