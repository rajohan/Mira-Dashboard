import fs from "node:fs";
import path from "node:path";

import type { FileEntry } from "../../../../contracts/files.ts";
import { json } from "../../http/core.ts";
import { routeFailureResponse } from "../../http/routeSupport.ts";
import { guardedPath } from "../../lib/guardedOps/core.ts";
import { lstatGuarded, readdirGuarded } from "../../lib/guardedOps/read.ts";
import { safePathWithinRoot } from "../../lib/safePath.ts";
import {
    hasHiddenSegment,
    isVisibleWorkspaceEntry,
    workspaceRoot,
} from "./pathPolicy.ts";

function listFiles(directoryPath: string): FileEntry[] | undefined {
    let root: string;
    try {
        root = fs.realpathSync(workspaceRoot());
    } catch (error) {
        if (
            !directoryPath &&
            ((error as NodeJS.ErrnoException).code === "ENOENT" ||
                (error as NodeJS.ErrnoException).code === "ENOTDIR")
        ) {
            return [];
        }
        throw error;
    }
    if (hasHiddenSegment(directoryPath)) return;
    const fullPath = safePathWithinRoot(directoryPath || ".", root);
    if (!fullPath) return;
    const resolved = safePathWithinRoot(fs.realpathSync(fullPath), root);
    if (!resolved) return;
    if (hasHiddenSegment(path.relative(root, resolved))) return;
    const items: FileEntry[] = [];
    const entries = readdirGuarded(guardedPath(resolved), { withFileTypes: true });
    for (const entry of entries) {
        if (!isVisibleWorkspaceEntry(entry.name) || entry.isSymbolicLink()) continue;
        const itemPath = directoryPath
            ? path.join(directoryPath, entry.name)
            : entry.name;
        if (entry.isDirectory()) {
            items.push({ name: entry.name, path: itemPath, type: "directory" });
            continue;
        }
        try {
            const stat = lstatGuarded(guardedPath(path.join(resolved, entry.name)));
            items.push({
                modified: stat.mtime.toISOString(),
                name: entry.name,
                path: itemPath,
                size: stat.size,
                type: "file",
            });
        } catch {
            items.push({ error: true, name: entry.name, path: itemPath, type: "file" });
        }
    }
    return items.toSorted((a, b) => {
        if (a.type === b.type) {
            return a.name.localeCompare(b.name);
        }
        return a.type === "directory" ? -1 : 1;
    });
}

export function handleFileListing(request: Request): Response {
    try {
        const directory = new URL(request.url).searchParams.get("path") ?? "";
        const files = listFiles(directory);
        if (!files) {
            return routeFailureResponse({
                context: "file",
                message: "Access denied: path outside workspace",
                status: 403,
            });
        }
        return json({ files, root: workspaceRoot() });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return routeFailureResponse({
                context: "file",
                message: "Directory not found",
                status: 404,
            });
        }
        throw error;
    }
}
