import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";

const OPENCLAW_ROOT = (process.env.HOME || "") + "/.openclaw";
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit

// Allowed config files (whitelist for security)
const ALLOWED_CONFIG_FILES = [
    "openclaw.json",
    "cron/jobs.json",
    "hooks/transforms/agentmail.ts",
];

/** Describes config file. */
interface ConfigFile {
    name: string;
    path: string;
    relPath: string;
    type: "file";
    size: number;
    modified: string;
}

/** Describes config file response. */
interface ConfigFileResponse {
    path: string;
    relPath: string;
    content: string;
    size: number;
    modified: string;
    isBinary: boolean;
    truncated?: boolean;
}

/** Describes write response. */
interface WriteResponse {
    success: boolean;
    path: string;
    relPath: string;
    size: number;
    modified: string;
}

/** Handles is binary file. */
function isBinaryFile(content: string): boolean {
    for (let i = 0; i < Math.min(content.length, 8000); i++) {
        if (content.codePointAt(i) === 0) return true;
    }
    return false;
}

/** Handles list config files. */
function listConfigFiles(): ConfigFile[] {
    const files: ConfigFile[] = [];

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

/** Handles config files routes. */
export default function configFilesRoutes(
    app: express.Application,
    _express: typeof express
): void {
    // List config files
    app.get("/api/config-files", (async (_req, res) => {
        try {
            const files = listConfigFiles();
            res.json({ files, root: OPENCLAW_ROOT });
        } catch (error) {
            console.error("[ConfigFiles] List error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Read config file content
    app.get(/^\/api\/config-files\/(.*)$/, (async (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");

        // Check if file is in whitelist
        if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
            res.status(403).json({ error: "Access denied: file not in allowed list" });
            return;
        }

        try {
            const fullPath = path.join(OPENCLAW_ROOT, filePath);

            if (!fs.existsSync(fullPath)) {
                res.status(404).json({ error: "File not found" });
                return;
            }

            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                res.status(400).json({ error: "Path is a directory, not a file" });
                return;
            }

            if (stat.size > MAX_FILE_SIZE) {
                const fd = fs.openSync(fullPath, "r");
                const buffer = Buffer.alloc(MAX_FILE_SIZE);
                const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
                fs.closeSync(fd);

                const content = buffer.toString("utf8", 0, bytesRead);
                const isBinary = isBinaryFile(content);

                res.json({
                    path: "config:" + filePath,
                    relPath: filePath,
                    content: isBinary ? "[Binary file]" : content,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    isBinary: isBinary,
                    truncated: true,
                } satisfies ConfigFileResponse);
                return;
            }

            const content = fs.readFileSync(fullPath, "utf8");
            const isBinary = isBinaryFile(content);

            res.json({
                path: "config:" + filePath,
                relPath: filePath,
                content: isBinary ? "[Binary file]" : content,
                size: stat.size,
                modified: stat.mtime.toISOString(),
                isBinary: isBinary,
            } satisfies ConfigFileResponse);
        } catch (error) {
            console.error("[ConfigFiles] Read error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Write config file
    app.put(/^\/api\/config-files\/(.*)$/, express.json(), (async (req, res) => {
        const filePath = decodeURIComponent(req.params[0] || "");
        const { content } = req.body as { content?: string };

        if (content === undefined) {
            res.status(400).json({ error: "Content required" });
            return;
        }

        // Check if file is in whitelist
        if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
            res.status(403).json({ error: "Access denied: file not in allowed list" });
            return;
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

            fs.writeFileSync(fullPath, content, "utf8");
            const stat = fs.statSync(fullPath);

            res.json({
                success: true,
                path: "config:" + filePath,
                relPath: filePath,
                size: stat.size,
                modified: stat.mtime.toISOString(),
            } satisfies WriteResponse);
        } catch (error) {
            console.error("[ConfigFiles] Write error:", (error as Error).message);
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
