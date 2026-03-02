// Logs API routes
const fs = require("fs");
const path = require("path");

const LOGS_DIR = "/tmp/openclaw";
let logWatcher = null;
let lastLogSize = 0;
let lastLogFile = "";
let logSubscribers = new Set();

function startLogWatcher() {
    if (logWatcher) return;
    
    logWatcher = setInterval(() => {
        try {
            const today = new Date().toISOString().split("T")[0];
            const logFile = path.join(LOGS_DIR, "openclaw-" + today + ".log");
            
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
                
                const lines = buffer.toString("utf-8").split("\n").filter(l => l.trim());
                lastLogSize = stat.size;
                
                for (const line of lines) {
                    const msg = JSON.stringify({ type: "log", line });
                    for (const ws of logSubscribers) {
                        try { ws.send(msg); } catch {}
                    }
                }
            }
        } catch (e) {
            console.error("[LogWatcher] Error:", e.message);
        }
    }, 1000);
}

function subscribeToLogs(ws) {
    logSubscribers.add(ws);
    startLogWatcher();
}

function unsubscribeFromLogs(ws) {
    logSubscribers.delete(ws);
}

module.exports = function(app) {
    // Get log files info
    app.get("/api/logs/info", (req, res) => {
        try {
            if (!fs.existsSync(LOGS_DIR)) {
                return res.json({ logs: [] });
            }
            
            const files = fs.readdirSync(LOGS_DIR)
                .filter(f => f.startsWith("openclaw-") && f.endsWith(".log"))
                .map(f => {
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
        const logFile = req.query.file;
        
        if (!logFile) {
            return res.status(400).json({ error: "File parameter required" });
        }
        
        try {
            const filePath = path.join(LOGS_DIR, logFile);
            
            if (!filePath.startsWith(LOGS_DIR)) {
                return res.status(403).json({ error: "Access denied" });
            }
            
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: "File not found" });
            }
            
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split("\n").slice(-5000).join("\n");
            
            res.json({ content: lines });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};

module.exports.subscribeToLogs = subscribeToLogs;
module.exports.unsubscribeFromLogs = unsubscribeFromLogs;
