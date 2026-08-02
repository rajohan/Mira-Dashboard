import fs from "node:fs";
import path from "node:path";

import type { FileWriteResponse } from "../../../../contracts/files.ts";
import { parseFileWriteRequest } from "../../../../contracts/files.ts";
import { json } from "../../http/core.ts";
import { readApiJsonOrError, routeFailureResponse } from "../../http/routeSupport.ts";
import { guardedPath, mkdirGuarded } from "../../lib/guardedOps/core.ts";
import {
    lstatGuarded,
    openReadNoFollowNonblockingGuarded,
    readFromOpenFile,
    statGuarded,
} from "../../lib/guardedOps/read.ts";
import { writeTextNoFollowAnchoredGuarded } from "../../lib/guardedOps/write.ts";
import {
    prepareSafeWriteTargetWithinRoot,
    safePathWithinRoot,
} from "../../lib/safePath.ts";
import {
    fileOpenErrorResponse,
    filePathFromRequest,
    hasHiddenSegment,
    isOpenFileWithinRoot,
    JSON_WRITE_BODY_LIMIT,
    MAX_FILE_SIZE,
    workspaceRoot,
} from "./pathPolicy.ts";

export async function handleFileWrite(request: Request): Promise<Response> {
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
    const body = await readApiJsonOrError(request, parseFileWriteRequest, {
        code: "invalid_file_request",
        context: "file.write",
        maxBytes: JSON_WRITE_BODY_LIMIT,
        message: "Invalid file request",
    });
    if (body instanceof Response) return body;
    if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_SIZE) {
        return routeFailureResponse({
            context: "file",
            message: "File is too large to write",
            status: 413,
        });
    }
    const workspaceRootPath = workspaceRoot();
    let root: string;
    try {
        root = fs.realpathSync(workspaceRootPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
        mkdirGuarded(guardedPath(workspaceRootPath), { recursive: true });
        root = fs.realpathSync(workspaceRootPath);
    }
    const fullPath = safePathWithinRoot(relativePath, root);
    const safeFullPath = fullPath
        ? prepareSafeWriteTargetWithinRoot(fullPath, root)
        : undefined;
    if (!safeFullPath) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied: path outside workspace",
            status: 403,
        });
    }
    const safeRelativePath = path.relative(root, safeFullPath);
    if (hasHiddenSegment(safeRelativePath)) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied: hidden paths are not allowed",
            status: 403,
        });
    }
    const parent = path.dirname(safeFullPath);
    if (!fs.existsSync(parent)) {
        return routeFailureResponse({
            context: "file",
            message: "Path not found",
            status: 404,
        });
    }
    let existingMode: number | undefined;
    let backupContent: string | undefined;
    try {
        const existingStat = lstatGuarded(guardedPath(safeFullPath));
        if (existingStat.isDirectory()) {
            return routeFailureResponse({
                context: "file",
                message: "Path is a directory, not a file",
                status: 400,
            });
        }
        if (!existingStat.isFile()) {
            return routeFailureResponse({
                context: "file",
                message: "Path is not a regular file",
                status: 400,
            });
        }
        if (existingStat.nlink > 1) {
            return routeFailureResponse({
                context: "file",
                message: "Access denied: hard links are not supported",
                status: 403,
            });
        }
        existingMode = existingStat.mode & 0o777;
        const file = await openReadNoFollowNonblockingGuarded(guardedPath(safeFullPath));
        try {
            const openedStat = await file.stat();
            if (!openedStat.isFile() || openedStat.nlink > 1) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied",
                    status: 403,
                });
            }
            if (!isOpenFileWithinRoot(file, root)) {
                return routeFailureResponse({
                    context: "file",
                    message: "Access denied",
                    status: 403,
                });
            }
            if (openedStat.size > MAX_FILE_SIZE) {
                return routeFailureResponse({
                    context: "file",
                    message: "Existing file is too large to back up",
                    status: 413,
                });
            }
            backupContent = readFromOpenFile(file.fd, openedStat.size).toString("utf8");
        } finally {
            await file.close();
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return fileOpenErrorResponse(error);
        }
    }
    const anchoredPath = path.relative(root, safeFullPath);
    if (backupContent !== undefined) {
        await writeTextNoFollowAnchoredGuarded(
            guardedPath(root),
            `${anchoredPath}.bak`,
            backupContent,
            { mode: existingMode }
        );
    }
    await writeTextNoFollowAnchoredGuarded(
        guardedPath(root),
        anchoredPath,
        body.content,
        { mode: existingMode }
    );
    const stat = statGuarded(guardedPath(safeFullPath));
    return json({
        isSuccess: true,
        modified: stat.mtime.toISOString(),
        path: relativePath,
        size: stat.size,
    } satisfies FileWriteResponse);
}
