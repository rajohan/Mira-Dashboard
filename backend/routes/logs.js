// Logs API routes
const fs = require("fs");
const path = require("path");

const LOGS_DIR = "/tmp/openclaw";
let logWatcher = null;
let lastLogSize = 0;
let lastLogFile = "";
let logSubscribers = new Set();

function getTodayLogFile() {
    const today = new Date().toISOString().split("T")[0];
    return path.join(LOGS_DIR, "openclaw-" + today + ".log");
}

function startLogWatcher() {
    if (logWatcher) return;

    logWatcher = setInterval(() => {
        try {
            const logFile = getTodayLogFile();

            if (!fs.existsSync(logFile)) return;

            const stat = fs.statSync(logFile);

            if (logFile !== lastLogFile) {
                lastLogFile = logFile;
                lastLogSize = 0;
            }

            if (stat.size > lastLogSize) {
                const fd = fs.openSync(logFile, "r");
                const buffer = Buffer.alloc(stat.size - lastLogSize);
                fs.readSync(fd, buffer, 0, buffer.length, lastLogSize);
                fs.closeSync(fd);

                const lines = buffer
                    .toString("utf-8")
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
        } catch (e) {
            console.error("[LogWatcher] Error:", e.message);
        }
    }, 1000);
}

function sendLogHistory(ws) {
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

        // Read last 1000 lines
        const content = fs.readFileSync(logFile, "utf-8");
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
    } catch (e) {
        console.error("[Logs] Error sending history:", e.message);
        ws.send(JSON.stringify({ type: "log_history_complete", count: 0 }));
    }
}

function subscribeToLogs(ws) {
    logSubscribers.add(ws);

    // Send log history first
    sendLogHistory(ws);

    // Start watching for new logs
    startLogWatcher();
}

function unsubscribeFromLogs(ws) {
    logSubscribers.delete(ws);
}

module.exports = function (app) {
    // Get log files info
    app.get("/api/logs/info", (req, res) => {
        try {
            if (!fs.existsSync(LOGS_DIR)) {
                return res.json({ logs: [] });
            }

            const files = fs
                .readdirSync(LOGS_DIR)
                .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
                .map((f) => {
                    const stat = fs.statSync(path.join(LOGS_DIR, f));
                    return { name: f, size: stat.size, modified: stat.mtime };
                })
                .sort((a, b) => b.modified - a.modified);

            res.json({ logs: files });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Get log file content
    app.get("/api/logs/content", (req, res) => {
        let logFile = req.query.file;
        const lines = req.query.lines ? parseInt(req.query.lines) : null;

        // If no file specified, use today's log
        if (!logFile) {
            const today = new Date().toISOString().split("T")[0];
            logFile = "openclaw-" + today + ".log";
        }

        try {
            const filePath = path.join(LOGS_DIR, logFile);

            if (!filePath.startsWith(LOGS_DIR)) {
                return res.status(403).json({ error: "Access denied" });
            }

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: "Log file not found" });
            }

            let content = fs.readFileSync(filePath, "utf-8");

            if (lines) {
                const allLines = content.split("\n").filter((l) => l.trim());
                content = allLines.slice(-lines).join("\n");
            }

            res.json({ content: content, file: logFile });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};

module.exports.subscribeToLogs = subscribeToLogs;
module.exports.unsubscribeFromLogs = unsubscribeFromLogs;
