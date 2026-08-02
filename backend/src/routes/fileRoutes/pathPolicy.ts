import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { routeFailureResponse } from "../../http/routeSupport.ts";

export const MAX_FILE_SIZE = 1024 * 1024;
export const JSON_WRITE_BODY_LIMIT = MAX_FILE_SIZE * 3;

function defaultWorkspaceRoot(): string {
    const openclawHome = process.env.OPENCLAW_HOME?.trim();
    if (
        openclawHome &&
        path.isAbsolute(openclawHome) &&
        path.parse(openclawHome).root !== openclawHome
    ) {
        return path.join(openclawHome, "workspace");
    }
    const rawHome = process.env.HOME?.trim();
    const fallbackHome = os.homedir().trim();
    let home = "";
    if (fallbackHome && path.isAbsolute(fallbackHome)) {
        home = path.resolve(fallbackHome);
    }
    if (rawHome && path.isAbsolute(rawHome)) {
        home = path.resolve(rawHome);
    }
    if (!home || path.parse(home).root === home) {
        throw new Error("Could not resolve a safe workspace root");
    }
    return path.join(home, ".openclaw", "workspace");
}

export function workspaceRoot(): string {
    const root = process.env.WORKSPACE_ROOT?.trim() || defaultWorkspaceRoot();
    if (
        !path.isAbsolute(root) ||
        path.normalize(root) !== root ||
        path.resolve(root) === path.parse(path.resolve(root)).root
    ) {
        throw new Error("WORKSPACE_ROOT must be an absolute normalized path");
    }
    return root;
}

function isHidden(name: string): boolean {
    return (
        name.startsWith(".") && name !== ".env.example" && name !== ".environment.example"
    );
}

export function hasHiddenSegment(relativePath: string): boolean {
    return relativePath
        .split(/[\\/]+/u)
        .filter(Boolean)
        .some((segment) => segment !== "." && isHidden(segment));
}

export function isVisibleWorkspaceEntry(name: string): boolean {
    return !isHidden(name);
}

export function isBinaryContent(content: string): boolean {
    for (let index = 0; index < Math.min(content.length, 8000); index += 1) {
        if (content.codePointAt(index) === 0) return true;
    }
    return false;
}

export function imageMime(filename: string): string | undefined {
    const extension = filename.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
        bmp: "image/bmp",
        gif: "image/gif",
        ico: "image/x-icon",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        png: "image/png",
        svg: "image/svg+xml",
        webp: "image/webp",
    };
    return extension ? (map[extension] ?? undefined) : undefined;
}

function isPathWithinRoot(candidatePath: string, root: string): boolean {
    const relativePath = path.relative(root, candidatePath);
    return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function isOpenFileWithinRoot(
    file: fs.promises.FileHandle,
    root: string
): boolean {
    if (process.platform !== "linux") return true;
    try {
        return isPathWithinRoot(fs.realpathSync(`/proc/self/fd/${file.fd}`), root);
    } catch {
        return false;
    }
}

export function fileOpenErrorResponse(error: unknown): Response {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ENOTDIR"].includes(code ?? "")) {
        return routeFailureResponse({
            context: "file",
            message: "File not found",
            status: 404,
        });
    }
    if (["ELOOP", "EACCES", "EPERM"].includes(code ?? "")) {
        return routeFailureResponse({
            context: "file",
            message: "Access denied",
            status: 403,
        });
    }
    throw error;
}

export function filePathFromRequest(request: Request): string | undefined {
    const url = new URL(request.url);
    try {
        return decodeURIComponent(url.pathname.slice("/api/files/".length));
    } catch {
        return undefined;
    }
}
