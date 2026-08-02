import fs from "node:fs";
import path from "node:path";

import type { FileContent } from "../../../../contracts/files.ts";
import { json } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { guardedPath } from "../../lib/guardedOps/core.ts";
import {
    openReadNoFollowNonblockingGuarded,
    readFromOpenFile,
    statGuarded,
} from "../../lib/guardedOps/read.ts";
import { safePathWithinRoot } from "../../lib/safePath.ts";
import {
    fileOpenErrorResponse,
    filePathFromRequest,
    hasHiddenSegment,
    imageMime,
    isBinaryContent,
    isOpenFileWithinRoot,
    MAX_FILE_SIZE,
    workspaceRoot,
} from "./pathPolicy.ts";

export async function handleFileRead(request: Request): Promise<Response> {
    const relativePath = filePathFromRequest(request);
    if (relativePath === undefined) {
        return routeFailureResponse({
            context: "file",
            message: "Malformed file path",
            status: 400,
        });
    }
    if (hasHiddenSegment(relativePath)) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied: hidden paths are not allowed",
            status: 403,
        });
    }
    let root: string;
    try {
        root = fs.realpathSync(workspaceRoot());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        root = path.resolve(workspaceRoot());
    }
    const fullPath = safePathWithinRoot(relativePath, root);
    if (!fullPath) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied: path outside workspace",
            status: 403,
        });
    }
    if (hasHiddenSegment(path.relative(root, fullPath))) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied: hidden paths are not allowed",
            status: 403,
        });
    }
    let stat: fs.Stats;
    try {
        stat = statGuarded(guardedPath(fullPath));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return routeFailureResponse({
                context: "file",
                message: "File not found",
                status: 404,
            });
        }
        throw error;
    }
    if (!stat.isFile()) {
        return routeFailureResponse({
            context: "file",
            message: "Path is a directory, not a file",
            status: 400,
        });
    }
    if (stat.nlink > 1) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied: hard links are not supported",
            status: 403,
        });
    }
    const mimeType = imageMime(path.basename(relativePath));
    if (mimeType) {
        return readImageFile(fullPath, relativePath, root, stat, mimeType);
    }
    return readTextFile(fullPath, relativePath, root);
}

async function readImageFile(
    fullPath: string,
    relativePath: string,
    root: string,
    stat: fs.Stats,
    mimeType: string
): Promise<Response> {
    if (stat.size > MAX_FILE_SIZE) {
        return routeFailureResponse({
            context: "file",
            message: "Image file is too large to preview",
            status: 413,
        });
    }
    let file: fs.promises.FileHandle;
    try {
        file = await openReadNoFollowNonblockingGuarded(guardedPath(fullPath));
    } catch (error) {
        return fileOpenErrorResponse(error);
    }
    let buffer: Buffer;
    let openedStat: fs.Stats;
    try {
        if (!isOpenFileWithinRoot(file, root)) {
            return routeFailureResponse({
                context: "file",
                message: "Access denied",
                status: 403,
            });
        }
        openedStat = await file.stat();
        if (!openedStat.isFile() || openedStat.nlink > 1) {
            return routeFailureResponse({
                context: "file",
                message: "Access denied",
                status: 403,
            });
        }
        if (openedStat.size > MAX_FILE_SIZE) {
            return routeFailureResponse({
                context: "file",
                message: "Image file is too large to preview",
                status: 413,
            });
        }
        buffer = readFromOpenFile(file.fd, openedStat.size);
    } finally {
        await file.close();
    }
    return json({
        content: buffer.toBase64(),
        isBinary: true,
        isImage: true,
        mimeType,
        modified: openedStat.mtime.toISOString(),
        path: relativePath,
        size: openedStat.size,
    } satisfies FileContent);
}

async function readTextFile(
    fullPath: string,
    relativePath: string,
    root: string
): Promise<Response> {
    let file: fs.promises.FileHandle;
    try {
        file = await openReadNoFollowNonblockingGuarded(guardedPath(fullPath));
    } catch (error) {
        return fileOpenErrorResponse(error);
    }
    let buffer: Buffer;
    let openedStat: fs.Stats;
    try {
        if (!isOpenFileWithinRoot(file, root)) {
            return routeFailureResponse({
                context: "file",
                message: "Access denied",
                status: 403,
            });
        }
        openedStat = await file.stat();
        if (!openedStat.isFile() || openedStat.nlink > 1) {
            return routeFailureResponse({
                context: "file",
                message: "Access denied",
                status: 403,
            });
        }
        buffer = readFromOpenFile(file.fd, Math.min(openedStat.size, MAX_FILE_SIZE));
    } finally {
        await file.close();
    }
    const content = buffer.toString("utf8");
    const isBinary = isBinaryContent(content);
    return json({
        content: isBinary ? "[Binary file]" : content,
        isBinary,
        modified: openedStat.mtime.toISOString(),
        path: relativePath,
        size: openedStat.size,
        truncated: openedStat.size > MAX_FILE_SIZE || undefined,
    } satisfies FileContent);
}
