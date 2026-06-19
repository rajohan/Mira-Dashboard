import express, { type RequestHandler } from "express";
import fs from "fs";
import os from "os";
import path from "path";

import { nonEmptyEnvFallback, stringFallback } from "../lib/values.js";

const MAX_MEDIA_SIZE = 16 * 1024 * 1024;
let cachedMediaRoot: string | undefined;
let cachedRealMediaRoot: string | undefined;

const MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8",
};

/** Performs MIME type from path. */
function mimeTypeFromPath(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function getMediaRoot(): string {
    const fallbackOpenClawHome = nonEmptyEnvFallback(
        "MIRA_DASHBOARD_OPENCLAW_HOME",
        path.join(os.homedir(), ".openclaw")
    );
    const openclawHome = nonEmptyEnvFallback("OPENCLAW_HOME", fallbackOpenClawHome);
    return path.resolve(openclawHome, "media");
}

/** Resolves and caches the canonical media root after it exists. */
function getRealMediaRoot(): string | null {
    const mediaRoot = getMediaRoot();
    if (cachedMediaRoot !== mediaRoot) {
        cachedMediaRoot = mediaRoot;
        cachedRealMediaRoot = undefined;
    }
    if (cachedRealMediaRoot) {
        return cachedRealMediaRoot;
    }
    try {
        cachedRealMediaRoot = fs.realpathSync(mediaRoot);
        return cachedRealMediaRoot;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
            throw error;
        }
        return null;
    }
}

/** Registers media API routes. */
export default function mediaRoutes(app: express.Application): void {
    app.get("/api/media", ((request, response) => {
        const requestedPath = stringFallback(request.query.path);

        if (!requestedPath) {
            response.status(403).json({ error: "Access denied" });
            return;
        }

        const fullPath = path.resolve(getMediaRoot(), requestedPath);
        const realMediaRoot = getRealMediaRoot();
        if (!realMediaRoot) {
            response.status(404).json({ error: "Media not found" });
            return;
        }

        if (!fs.existsSync(fullPath)) {
            response.status(404).json({ error: "Media not found" });
            return;
        }

        let realPath: string;
        let stat: fs.Stats;
        try {
            realPath = fs.realpathSync(fullPath);
            stat = fs.statSync(realPath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") {
                response.status(404).json({ error: "Media not found" });
                return;
            }
            throw error;
        }
        const relativeRealPath = path.relative(realMediaRoot, realPath);
        if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
            response.status(403).json({ error: "Access denied" });
            return;
        }

        if (!stat.isFile()) {
            response.status(400).json({ error: "Media path is not a file" });
            return;
        }

        if (stat.size > MAX_MEDIA_SIZE) {
            response.status(413).json({ error: "Media file too large" });
            return;
        }

        response.setHeader("Content-Type", mimeTypeFromPath(realPath));
        response.setHeader("Cache-Control", "private, max-age=3600");
        response.sendFile(realPath, { dotfiles: "allow" });
    }) as RequestHandler);
}
