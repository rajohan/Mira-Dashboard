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

function isImageFile(filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    const imageExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"];
    return imageExts.includes(ext || "");
}

function getImageMimeType(filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeTypes = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        svg: "image/svg+xml",
        webp: "image/webp",
        ico: "image/x-icon",
        bmp: "image/bmp",
    };
    return mimeTypes[ext || ""] || "application/octet-stream";
}

function shouldHideFile(name) {
    return name.startsWith(".") && name !== ".env.example";
}

function listDirectory(dirPath) {
    const items = [];
    const fullPath = dirPath ? path.join(WORKSPACE_ROOT, dirPath) : WORKSPACE_ROOT;

    try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const entry of entries) {
            if (shouldHideFile(entry.name)) continue;

            const itemPath = dirPath ? path.join(dirPath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                items.push({
                    name: entry.name,
                    type: "directory",
                    path: itemPath,
                });
            } else {
                try {
                    const stat = fs.statSync(path.join(fullPath, entry.name));
                    items.push({
                        name: entry.name,
                        type: "file",
                        path: itemPath,
                        size: stat.size,
                        modified: stat.mtime.toISOString(),
                    });
                } catch {
                    items.push({
                        name: entry.name,
                        type: "file",
                        path: itemPath,
                        error: true,
                    });
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

module.exports = function (app, express) {
    // List files
    app.get("/api/files", (req, res) => {
        try {
            const dirPath = req.query.path || "";
            const files = listDirectory(dirPath);
            res.json({ files, root: WORKSPACE_ROOT });
        } catch (e) {
            console.error("[Backend] Files list error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Read file content
    app.get("/api/files/*", (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");

        try {
            const fullPath = path.resolve(WORKSPACE_ROOT, filePath);

            if (!fullPath.startsWith(WORKSPACE_ROOT)) {
                return res
                    .status(403)
                    .json({ error: "Access denied: path outside workspace" });
            }

            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: "File not found" });
            }

            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                return res.status(400).json({ error: "Path is a directory, not a file" });
            }

            const filename = path.basename(filePath);

            // Handle image files
            if (isImageFile(filename)) {
                const buffer = fs.readFileSync(fullPath);
                const base64 = buffer.toString("base64");
                const mimeType = getImageMimeType(filename);

                return res.json({
                    path: filePath,
                    content: base64,
                    mimeType: mimeType,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    isImage: true,
                    isBinary: true,
                });
            }

            if (stat.size > MAX_FILE_SIZE) {
                const fd = fs.openSync(fullPath, "r");
                const buffer = Buffer.alloc(MAX_FILE_SIZE);
                const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
                fs.closeSync(fd);

                const content = buffer.toString("utf-8", 0, bytesRead);
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
                return res
                    .status(403)
                    .json({ error: "Access denied: path outside workspace" });
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
