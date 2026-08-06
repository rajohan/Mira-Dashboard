import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { SourceImport } from "./importGraph.ts";
import type { SourceBoundaryViolation } from "./policyTypes.ts";
import { isContainedPath, repositoryPath } from "./sourceBoundaryPaths.ts";
import { isTestPath } from "./sourceTopologyPolicy.ts";

/**
 * Validates that an exact legacy allowlist target remains a contained regular file.
 * @param projectRoot Absolute repository root.
 * @param allowlistKey Stable importer/target allowlist key.
 * @returns Target violation when the reviewed target has drifted.
 */
export async function validateLegacyAllowlistTarget(
    projectRoot: string,
    allowlistKey: string
): Promise<SourceBoundaryViolation | undefined> {
    const separatorIndex = allowlistKey.indexOf("\0");
    const importer = allowlistKey.slice(0, separatorIndex);
    const target = allowlistKey.slice(separatorIndex + 1);
    const lexicalProjectRoot = path.resolve(projectRoot);
    let currentPath = lexicalProjectRoot;
    const components = target.split("/");
    for (const [index, component] of components.entries()) {
        currentPath = path.join(currentPath, component);
        let status;
        try {
            status = await lstat(currentPath);
        } catch {
            return {
                importer,
                line: 1,
                message: "Legacy allowlisted target is missing or unreadable",
                specifier: target,
            };
        }
        if (status.isSymbolicLink()) {
            return {
                importer,
                line: 1,
                message: "Legacy allowlisted target paths may not contain symbolic links",
                specifier: target,
            };
        }
        const isTarget = index === components.length - 1;
        if ((isTarget && !status.isFile()) || (!isTarget && !status.isDirectory())) {
            return {
                importer,
                line: 1,
                message: "Legacy allowlisted target must be a regular repository file",
                specifier: target,
            };
        }
    }
    const realProjectRoot = await realpath(lexicalProjectRoot);
    if (!isContainedPath(realProjectRoot, await realpath(currentPath))) {
        return {
            importer,
            line: 1,
            message: "Legacy allowlisted target real path escapes the repository",
            specifier: target,
        };
    }
    return undefined;
}

function importTargetViolation(
    importer: string,
    sourceImport: SourceImport,
    message: string
): SourceBoundaryViolation {
    return {
        importer,
        line: sourceImport.line,
        message,
        ...(sourceImport.specifier === undefined
            ? {}
            : { specifier: sourceImport.specifier }),
    };
}

/**
 * Validates a production relative import without runtime resolver fallback.
 * @param projectRoot Absolute repository root.
 * @param importer Repository-relative importing source.
 * @param sourceImport Parsed relative import edge.
 * @returns Exact-target violation when the lexical target is unsafe.
 */
export async function validateExactRelativeImportTarget(
    projectRoot: string,
    importer: string,
    sourceImport: SourceImport
): Promise<SourceBoundaryViolation | undefined> {
    const specifier = sourceImport.specifier;
    if (
        isTestPath(importer) ||
        specifier === undefined ||
        !specifier.startsWith(".") ||
        /[%?#\\]/u.test(specifier)
    ) {
        return undefined;
    }
    const importerDirectory = path.posix.dirname(importer);
    const joinedTarget = path.posix.join(importerDirectory, specifier);
    const target = repositoryPath(path.posix.normalize(joinedTarget));
    if (target === ".." || target.startsWith("../")) return undefined;

    const lexicalProjectRoot = path.resolve(projectRoot);
    let currentPath = lexicalProjectRoot;
    const components = target.split("/");
    for (const [index, component] of components.entries()) {
        currentPath = path.join(currentPath, component);
        let status;
        try {
            status = await lstat(currentPath);
        } catch (error) {
            if ((error as { code?: unknown }).code !== "ENOENT") throw error;
            return importTargetViolation(
                importer,
                sourceImport,
                "Relative production imports must resolve to an existing exact target; runtime extension fallback is forbidden"
            );
        }
        if (status.isSymbolicLink()) {
            return importTargetViolation(
                importer,
                sourceImport,
                "Relative production import target paths may not contain symbolic links"
            );
        }
        const isTarget = index === components.length - 1;
        if ((isTarget && !status.isFile()) || (!isTarget && !status.isDirectory())) {
            return importTargetViolation(
                importer,
                sourceImport,
                "Relative production import targets must be exact regular files"
            );
        }
    }
    const realProjectRoot = await realpath(lexicalProjectRoot);
    if (!isContainedPath(realProjectRoot, await realpath(currentPath))) {
        return importTargetViolation(
            importer,
            sourceImport,
            "Relative production import target real path escapes the repository"
        );
    }
    return undefined;
}
