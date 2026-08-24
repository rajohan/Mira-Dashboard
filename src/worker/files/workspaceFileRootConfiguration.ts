import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { WorkerWorkspaceFileRootConfiguration } from "./descriptorWorkspaceFileStructuralWriter.ts";

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
 * Resolves the worker's exact workspace root without importing web/server authority.
 * @param workspaceRoot Explicit configured workspace path.
 * @param productionRoot Canonical Dashboard production-state root to fence out.
 * @returns Frozen root metadata for the worker-only descriptor writer.
 */
export async function resolveReviewedWorkerWorkspaceFileRoot(
    workspaceRoot: string,
    productionRoot: string
): Promise<WorkerWorkspaceFileRootConfiguration> {
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
            pathsOverlap(workspaceRoot, productionRoot) ||
            pathsOverlap(productionRoot, workspaceRoot)
        ) {
            throw invalidWorkspaceRoot();
        }
    } catch {
        throw invalidWorkspaceRoot();
    }
    return Object.freeze({
        id: "workspace",
        path: workspaceRoot,
        writable: true,
    });
}
