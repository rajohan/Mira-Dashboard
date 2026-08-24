import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { workspaceFileLimits } from "../../contracts/files.ts";
import type { WorkerWorkspaceFileRootConfiguration } from "./descriptorWorkspaceFileStructuralWriter.ts";

const reviewedReplacementManifest = Object.freeze([
    Object.freeze({
        backupPolicy: "sibling-dot-bak",
        maximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
        segments: Object.freeze(["openclaw.json"]),
    }),
    Object.freeze({
        backupPolicy: "sibling-dot-bak",
        maximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
        segments: Object.freeze(["hooks", "transforms", "agentmail.ts"]),
    }),
]);

function invalidOpenClawRoot(): TypeError {
    return new TypeError("OpenClaw file writer root is invalid");
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
 * Resolves the worker's fixed OpenClaw replacement allowlist without granting
 * create, delete, rename, or arbitrary-home authority.
 * @param openClawRoot Explicit configured OpenClaw home.
 * @param productionRoot Canonical Dashboard production root to fence out.
 * @returns One owner-controlled root limited to the two legacy-editable files.
 */
export async function resolveReviewedWorkerOpenClawFileRoot(
    openClawRoot: string,
    productionRoot: string
): Promise<WorkerWorkspaceFileRootConfiguration> {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        !path.isAbsolute(openClawRoot) ||
        path.resolve(openClawRoot) !== openClawRoot ||
        openClawRoot === path.parse(openClawRoot).root ||
        !path.isAbsolute(productionRoot) ||
        path.resolve(productionRoot) !== productionRoot ||
        productionRoot === path.parse(productionRoot).root
    ) {
        throw invalidOpenClawRoot();
    }
    try {
        const [canonical, status] = await Promise.all([
            realpath(openClawRoot),
            lstat(openClawRoot, { bigint: true }),
        ]);
        if (
            canonical !== openClawRoot ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid()) ||
            (status.mode & 0o777n) !== 0o700n ||
            pathsOverlap(openClawRoot, productionRoot) ||
            pathsOverlap(productionRoot, openClawRoot)
        ) {
            throw invalidOpenClawRoot();
        }
    } catch {
        throw invalidOpenClawRoot();
    }
    return Object.freeze({
        id: "openclaw-config",
        path: openClawRoot,
        replacementManifest: reviewedReplacementManifest,
        writable: true,
    });
}
