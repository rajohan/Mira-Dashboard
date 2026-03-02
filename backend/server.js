require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const { getMetrics } = require("./metrics");

// Route modules
const filesRoutes = require("./routes/files");
const moltbookRoutes = require("./routes/moltbook");
const settingsRoutes = require("./routes/settings");
const sessions = require("./routes/sessions");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const frontendPath = path.join(__dirname, "..", "dist");

// =====================
// API Routes
// =====================

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        gatewayConnected: sessions.isConnected(),
        sessionCount: sessions.getSessions().length,
    });
});

app.get("/api/sessions", (req, res) => {
    res.json(sessions.getSessions());
});

app.get("/api/metrics", (req, res) => {
    try {
        const metrics = getMetrics();
        res.json(metrics);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/exec", express.json(), async (req, res) => {
    const { command, cwd } = req.body;
    if (!command) {
        return res.status(400).json({ error: "Command required" });
    }
    
    try {
        const { spawn } = require("child_process");
        const child = spawn(command, { 
            shell: true, 
            cwd: cwd || process.cwd(),
            env: process.env 
        });
        
        let stdout = "";
        let stderr = "";
        
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        
        child.on("close", (code) => {
            res.json({ 
                code: code, 
                stdout: stdout.slice(-10000), 
                stderr: stderr.slice(-10000) 
            });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/logs/info", (req, res) => {
    const fs = require("fs");
    const logsDir = "/tmp/openclaw";
    
    try {
        if (!fs.existsSync(logsDir)) {
            return res.json({ logs: [] });
        }
        
        const files = fs.readdirSync(logsDir)
            .filter(f => f.startsWith("openclaw-") && f.endsWith(".log"))
            .map(f => {
                const stat = fs.statSync(path.join(logsDir, f));
                return { name: f, size: stat.size, modified: stat.mtime };
            })
            .sort((a, b) => b.modified - a.modified);
        
        res.json({ logs: files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/logs/content", (req, res) => {
    const fs = require("fs");
    const logsDir = "/tmp/openclaw";
    const logFile = req.query.file;
    
    if (!logFile) {
        return res.status(400).json({ error: "File parameter required" });
    }
    
    try {
        const filePath = path.join(logsDir, logFile);
        
        if (!filePath.startsWith(logsDir)) {
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

// Route modules
filesRoutes(app, express);
moltbookRoutes(app);
settingsRoutes(app, express, sessions.getStatus);

// Static files & SPA
app.use(express.static(frontendPath));

app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

// =====================
// WebSocket
// =====================
wss.on("connection", (ws) => {
    console.log("[Frontend] Client connected");
    sessions.handleClient(ws);
});

// =====================
// Start Server
// =====================
const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
    console.log("[Backend] Server listening on port", PORT);
    
    const token = process.env.OPENCLAW_TOKEN;
    if (token) {
        sessions.init(token);
    } else {
        console.error("[Backend] OPENCLAW_TOKEN required");
        process.exit(1);
    }
});
