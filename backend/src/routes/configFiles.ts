import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";

import {
    copyGuarded,
    guardedPath,
    statGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.js";
import { prepareSafeWriteTargetWithinRoot, safePathWithinRoot } from "../lib/safePath.js";

const OPENCLAW_ROOT = (process.env.HOME || "") + "/.openclaw";
const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit
const MAX_CONFIG_WRITE_SIZE = 2 * 1024 * 1024; // 2MB write guardrail

// Allowed config files (whitelist for security)
const ALLOWED_CONFIG_FILES = [
    "openclaw.json",
    "cron/jobs.json",
    "hooks/transforms/agentmail.ts",
];

/** Represents config file. */
interface ConfigFile {
    name: string;
    path: string;
    relPath: string;
    type: "file";
    size: number;
    modified: string;
}

/** Represents the config file API response. */
interface ConfigFileResponse {
    path: string;
    relPath: string;
    content: string;
    size: number;
    modified: string;
    isBinary: boolean;
    truncated?: boolean;
}

/** Represents the write API response. */
interface WriteResponse {
    success: boolean;
    path: string;
    relPath: string;
    size: number;
    modified: string;
}

/** Returns whether binary file. */
function isBinaryFile(content: string): boolean {
    for (let i = 0; i < Math.min(content.length, 8000); i++) {
        if (content.codePointAt(i) === 0) return true;
    }
    return false;
}

/** Performs list config files. */
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

/** Registers config files API routes. */
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
            const fullPath = safePathWithinRoot(filePath, OPENCLAW_ROOT);

            if (!fullPath) {
                try {
                    fs.realpathSync(path.resolve(OPENCLAW_ROOT, filePath));
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
                        res.status(404).json({ error: "File not found" });
                        return;
                    }
                }

                res.status(403).json({
                    error: "Access denied: path outside allowed root",
                });
                return;
            }

            let fd: number | undefined;
            try {
                fd = fs.openSync(fullPath, "r");
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
                    res.status(404).json({ error: "File not found" });
                    return;
                }
                throw error;
            }

            try {
                const stat = fs.fstatSync(fd);

                if (stat.isDirectory()) {
                    res.status(400).json({ error: "Path is a directory, not a file" });
                    return;
                }

                if (stat.size > MAX_FILE_SIZE) {
                    const buffer = Buffer.alloc(MAX_FILE_SIZE);
                    const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
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

                const content = fs.readFileSync(fd, "utf8");
                const isBinary = isBinaryFile(content);

                res.json({
                    path: "config:" + filePath,
                    relPath: filePath,
                    content: isBinary ? "[Binary file]" : content,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    isBinary: isBinary,
                } satisfies ConfigFileResponse);
            } finally {
                fs.closeSync(fd);
            }
            return;
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

        if (typeof content !== "string" || content.length > MAX_CONFIG_WRITE_SIZE) {
            res.status(400).json({ error: "Invalid content" });
            return;
        }

        // Check if file is in whitelist
        if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
            res.status(403).json({ error: "Access denied: file not in allowed list" });
            return;
        }

        try {
            const fullPath = safePathWithinRoot(filePath, OPENCLAW_ROOT);

            if (!fullPath) {
                res.status(403).json({
                    error: "Access denied: path outside allowed root",
                });
                return;
            }

            const safeFullPath = prepareSafeWriteTargetWithinRoot(
                fullPath,
                OPENCLAW_ROOT
            );
            if (!safeFullPath) {
                res.status(403).json({
                    error: "Access denied: path outside allowed root",
                });
                return;
            }

            // Create backup
            try {
                const backupPath = safeFullPath + ".bak";
                copyGuarded(guardedPath(safeFullPath), guardedPath(backupPath));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }

            await writeTextNoFollowGuarded(guardedPath(safeFullPath), content);
            const stat = statGuarded(guardedPath(safeFullPath));

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
