import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceFileRootConfiguration } from "../../domains/files/ports.ts";
import type { DashboardProjectLayout } from "../filesystem/projectLayout.ts";

function invalidWorkspaceRoot(): TypeError {
    return new TypeError("Workspace file root is invalid");
}

function pathsOverlap(left: string, right: string): boolean {
    const relative = path.relative(left, right);
    return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
    );
}

/**
 * Resolves the one reviewed workspace root used by both web and worker processes.
 * The root may never contain or be contained by Dashboard production state/releases.
 * @param workspaceRoot Lexically validated explicit configuration value.
 * @param layout Canonical Dashboard project layout.
 * @returns Frozen descriptor-adapter configuration with no fallback path discovery.
 */
export async function resolveReviewedWorkspaceFileRoot(
    workspaceRoot: string,
    layout: DashboardProjectLayout
): Promise<WorkspaceFileRootConfiguration> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        !path.isAbsolute(workspaceRoot) ||
        path.resolve(workspaceRoot) !== workspaceRoot ||
        workspaceRoot === path.parse(workspaceRoot).root
    ) {
        throw invalidWorkspaceRoot();
    }
    try {
        const [canonical, status] = await Promise.all([
            realpath(workspaceRoot),
            lstat(workspaceRoot, { bigint: true }),
        ]);
        if (
            canonical !== workspaceRoot ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid()) ||
            (status.mode & 0o022n) !== 0n ||
            pathsOverlap(workspaceRoot, layout.production.root) ||
            pathsOverlap(layout.production.root, workspaceRoot)
        ) {
            throw invalidWorkspaceRoot();
        }
    } catch {
        throw invalidWorkspaceRoot();
    }
    return Object.freeze({
        id: "workspace",
        label: "Workspace",
        path: workspaceRoot,
        writable: true,
    });
}
