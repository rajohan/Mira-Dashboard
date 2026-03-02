// Config files API routes - provides access to OpenClaw config files outside workspace
const fs = require("fs");
const path = require("path");

const OPENCLAW_ROOT = process.env.HOME + "/.openclaw";
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit

// Allowed config files (whitelist for security)
const ALLOWED_CONFIG_FILES = [
    "openclaw.json",
    "config/agents.json5",
    "config/channels.json5",
    "config/models.json5",
    "cron/jobs.json",
    "hooks/transforms/agentmail.ts",
];

function isBinaryFile(content) {
    for (let i = 0; i < Math.min(content.length, 8000); i++) {
        if (content.charCodeAt(i) === 0) return true;
    }
    return false;
}

function listConfigFiles() {
    const files = [];

    for (const relPath of ALLOWED_CONFIG_FILES) {
        const fullPath = path.join(OPENCLAW_ROOT, relPath);
        try {
            const stat = fs.statSync(fullPath);
            files.push({
                name: path.basename(relPath),
                path: "config:" + relPath, // Prefix to distinguish from workspace files
                relPath: relPath,
                type: "file",
                size: stat.size,
                modified: stat.mtime.toISOString(),
            });
        } catch {
            // File doesn't exist, skip
        }
    }

    return files;
}

module.exports = function (app, express) {
    // List config files
    app.get("/api/config-files", (req, res) => {
        try {
            const files = listConfigFiles();
            res.json({ files, root: OPENCLAW_ROOT });
        } catch (e) {
            console.error("[ConfigFiles] List error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Read config file content
    app.get("/api/config-files/*", (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");

        // Check if file is in whitelist
        if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
            return res
                .status(403)
                .json({ error: "Access denied: file not in allowed list" });
        }

        try {
            const fullPath = path.join(OPENCLAW_ROOT, filePath);

            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: "File not found" });
            }

            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                return res.status(400).json({ error: "Path is a directory, not a file" });
            }

            if (stat.size > MAX_FILE_SIZE) {
                const fd = fs.openSync(fullPath, "r");
                const buffer = Buffer.alloc(MAX_FILE_SIZE);
                const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
                fs.closeSync(fd);

                const content = buffer.toString("utf-8", 0, bytesRead);
                const isBinary = isBinaryFile(content);

                return res.json({
                    path: "config:" + filePath,
                    relPath: filePath,
                    content: isBinary ? "[Binary file]" : content,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    isBinary: isBinary,
                    truncated: true,
                });
            }

            const content = fs.readFileSync(fullPath, "utf-8");
            const isBinary = isBinaryFile(content);

            res.json({
                path: "config:" + filePath,
                relPath: filePath,
                content: isBinary ? "[Binary file]" : content,
                size: stat.size,
                modified: stat.mtime.toISOString(),
                isBinary: isBinary,
            });
        } catch (e) {
            console.error("[ConfigFiles] Read error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Write config file
    app.put("/api/config-files/*", express.json(), (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");
        const { content } = req.body;

        if (content === undefined) {
            return res.status(400).json({ error: "Content required" });
        }

        // Check if file is in whitelist
        if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
            return res
                .status(403)
                .json({ error: "Access denied: file not in allowed list" });
        }

        try {
            const fullPath = path.join(OPENCLAW_ROOT, filePath);

            // Create backup
            if (fs.existsSync(fullPath)) {
                const backupPath = fullPath + ".bak";
                fs.copyFileSync(fullPath, backupPath);
            } else {
                const parentDir = path.dirname(fullPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }
            }

            fs.writeFileSync(fullPath, content, "utf-8");
            const stat = fs.statSync(fullPath);

            res.json({
                success: true,
                path: "config:" + filePath,
                relPath: filePath,
                size: stat.size,
                modified: stat.mtime.toISOString(),
            });
        } catch (e) {
            console.error("[ConfigFiles] Write error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
};
