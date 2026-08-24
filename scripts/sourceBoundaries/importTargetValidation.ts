import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { SourceImport } from "./importGraph.ts";
import type { SourceBoundaryViolation } from "./policyTypes.ts";
import { isContainedPath, repositoryPath } from "./sourceBoundaryPaths.ts";
import { isTestPath } from "./sourceTopologyPolicy.ts";

interface TargetValidationMessages {
    readonly escaped: string;
    readonly invalidType: string;
    readonly missing: string;
    readonly symbolicLink: string;
}

async function validateContainedTarget(
    lexicalProjectRoot: string,
    realProjectRoot: string,
    target: string,
    messages: TargetValidationMessages,
    violation: (message: string) => SourceBoundaryViolation
): Promise<SourceBoundaryViolation | undefined> {
    let currentPath = lexicalProjectRoot;
    const components = target.split("/");
    for (const [index, component] of components.entries()) {
        currentPath = path.join(currentPath, component);
        let status;
        try {
            status = await lstat(currentPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return violation(messages.missing);
        }
        if (status.isSymbolicLink()) return violation(messages.symbolicLink);
        const isTarget = index === components.length - 1;
        if ((isTarget && !status.isFile()) || (!isTarget && !status.isDirectory())) {
            return violation(messages.invalidType);
        }
    }
    if (!isContainedPath(realProjectRoot, await realpath(currentPath))) {
        return violation(messages.escaped);
    }
    return undefined;
}

/**
 * Validates that an exact legacy allowlist target remains a contained regular file.
 * @param projectRoot Absolute repository root.
 * @param realProjectRoot Canonical repository root used for containment.
 * @param allowlistKey Stable importer/target allowlist key.
 * @returns Target violation when the reviewed target has drifted.
 */
export async function validateLegacyAllowlistTarget(
    projectRoot: string,
    realProjectRoot: string,
    allowlistKey: string
): Promise<SourceBoundaryViolation | undefined> {
    const separatorIndex = allowlistKey.indexOf("\0");
    const importer = allowlistKey.slice(0, separatorIndex);
    const target = allowlistKey.slice(separatorIndex + 1);
    const lexicalProjectRoot = path.resolve(projectRoot);
    const violation = (message: string): SourceBoundaryViolation => ({
        importer,
        line: 1,
        message,
        specifier: target,
    });
    return validateContainedTarget(
        lexicalProjectRoot,
        realProjectRoot,
        target,
        {
            escaped: "Legacy allowlisted target real path escapes the repository",
            invalidType: "Legacy allowlisted target must be a regular repository file",
            missing: "Legacy allowlisted target is missing or unreadable",
            symbolicLink:
                "Legacy allowlisted target paths may not contain symbolic links",
        },
        violation
    );
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
 * @param realProjectRoot Canonical repository root used for containment.
 * @param importer Repository-relative importing source.
 * @param sourceImport Parsed relative import edge.
 * @returns Exact-target violation when the lexical target is unsafe.
 */
export async function validateExactRelativeImportTarget(
    projectRoot: string,
    realProjectRoot: string,
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
    return validateContainedTarget(
        lexicalProjectRoot,
        realProjectRoot,
        target,
        {
            escaped: "Relative production import target real path escapes the repository",
            invalidType: "Relative production import targets must be exact regular files",
            missing:
                "Relative production imports must resolve to an existing exact target; runtime extension fallback is forbidden",
            symbolicLink:
                "Relative production import target paths may not contain symbolic links",
        },
        (message) => importTargetViolation(importer, sourceImport, message)
    );
}
