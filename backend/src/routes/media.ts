import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";

import { nonEmptyEnvFallback, stringFallback } from "../lib/values.js";

const OPENCLAW_HOME = nonEmptyEnvFallback("OPENCLAW_HOME", "/home/ubuntu/.openclaw");
const MEDIA_ROOT = path.resolve(OPENCLAW_HOME, "media");
const MAX_MEDIA_SIZE = 16 * 1024 * 1024;
let cachedRealMediaRoot: string | undefined;

export const __testing = {
    mediaRoot: MEDIA_ROOT,
};

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

/** Performs mime type from path. */
function mimeTypeFromPath(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/** Resolves and caches the canonical media root after it exists. */
function getRealMediaRoot(): string {
    cachedRealMediaRoot ??= fs.realpathSync(MEDIA_ROOT);
    return cachedRealMediaRoot;
}

/** Registers media API routes. */
export default function mediaRoutes(app: express.Application): void {
    app.get("/api/media", ((request, response) => {
        const requestedPath = stringFallback(request.query.path);
        const fullPath = path.resolve(requestedPath);

        if (!requestedPath || !fullPath.startsWith(`${MEDIA_ROOT}${path.sep}`)) {
            response.status(403).json({ error: "Access denied" });
            return;
        }

        if (!fs.existsSync(fullPath)) {
            response.status(404).json({ error: "Media not found" });
            return;
        }

        const realPath = fs.realpathSync(fullPath);
        const realMediaRoot = getRealMediaRoot();
        if (!realPath.startsWith(`${realMediaRoot}${path.sep}`)) {
            response.status(403).json({ error: "Access denied" });
            return;
        }

        const stat = fs.statSync(realPath);
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
