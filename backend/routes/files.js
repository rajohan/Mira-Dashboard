// Files API routes
const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/home/ubuntu/.openclaw/workspace";
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit for preview

function isBinaryFile(content) {
    for (let i = 0; i < Math.min(content.length, 8000); i++) {
        if (content.charCodeAt(i) === 0) return true;
    }
    return false;
}

function shouldHideFile(name) {
    return name.startsWith(".") && name !== ".env.example";
}

function listDirectory(dirPath, basePath) {
    const items = [];
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (shouldHideFile(entry.name)) continue;
            const itemPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(basePath, itemPath);
            if (entry.isDirectory()) {
                items.push({
                    name: entry.name,
                    type: "directory",
                    path: relativePath,
                    children: listDirectory(itemPath, basePath),
                });
            } else {
                try {
                    const stat = fs.statSync(itemPath);
                    items.push({
                        name: entry.name,
                        type: "file",
                        path: relativePath,
                        size: stat.size,
                        modified: stat.mtime.toISOString(),
                    });
                } catch {
                    items.push({ name: entry.name, type: "file", path: relativePath, error: true });
                }
            }
        }
    } catch (e) {
        console.error("[Files] Error listing directory:", e.message);
    }
    return items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

module.exports = function(app, express) {
    // List files
    app.get("/api/files", (req, res) => {
        try {
            const items = listDirectory(WORKSPACE_ROOT, WORKSPACE_ROOT);
            res.json({ root: WORKSPACE_ROOT, items });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read file
    app.get("/api/files/*", (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");
        
        try {
            const fullPath = path.resolve(WORKSPACE_ROOT, filePath);
            
            if (!fullPath.startsWith(WORKSPACE_ROOT)) {
                return res.status(403).json({ error: "Access denied: path outside workspace" });
            }
            
            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: "File not found" });
            }
            
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                const items = listDirectory(fullPath, WORKSPACE_ROOT);
                return res.json({ path: filePath, type: "directory", items });
            }
            
            if (stat.size > MAX_FILE_SIZE) {
                const content = fs.readFileSync(fullPath, "utf-8").slice(0, MAX_FILE_SIZE);
                const isBinary = isBinaryFile(content);
                return res.json({
                    path: filePath,
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
                path: filePath,
                content: isBinary ? "[Binary file]" : content,
                size: stat.size,
                modified: stat.mtime.toISOString(),
                isBinary: isBinary,
            });
        } catch (e) {
            console.error("[Backend] File read error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Write file
    app.put("/api/files/*", express.json(), (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");
        const { content } = req.body;
        
        if (content === undefined) {
            return res.status(400).json({ error: "Content required" });
        }
        
        try {
            const fullPath = path.resolve(WORKSPACE_ROOT, filePath);
            
            if (!fullPath.startsWith(WORKSPACE_ROOT)) {
                return res.status(403).json({ error: "Access denied: path outside workspace" });
            }
            
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
                path: filePath,
                size: stat.size,
                modified: stat.mtime.toISOString(),
            });
        } catch (e) {
            console.error("[Backend] File write error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
};
