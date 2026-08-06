import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { SourceBoundaryViolation } from "./policyTypes.ts";
import {
    boundaryPathViolation,
    isContainedPath,
    repositoryPath,
} from "./sourceBoundaryPaths.ts";

const sourceExtensionPattern = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const nestedResolverMetadataPattern =
    /^(?:bunfig\.toml|(?:js|ts)config(?:\.[A-Za-z0-9_-]+)*\.json|package\.json)$/u;
const reviewedRootDirectories: ReadonlySet<string> = new Set([
    ".git",
    ".github",
    "coverage",
    "data",
    "dist",
    "docs",
    "migrations",
    "node_modules",
    "scripts",
    "src",
    "systemd",
]);

/** Discovered executable sources plus fail-closed repository-layout findings. */
export interface SourceDiscovery {
    readonly files: readonly string[];
    readonly violations: readonly SourceBoundaryViolation[];
}

async function discoverDirectory(
    lexicalProjectRoot: string,
    realProjectRoot: string,
    relativeDirectory: string,
    files: Set<string>,
    violations: SourceBoundaryViolation[]
): Promise<void> {
    const absoluteDirectory = path.join(lexicalProjectRoot, relativeDirectory);
    let directoryStatus;
    try {
        directoryStatus = await lstat(absoluteDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        violations.push(
            boundaryPathViolation(
                relativeDirectory,
                "Reviewed source directory is missing from the repository layout"
            )
        );
        return;
    }
    if (directoryStatus.isSymbolicLink()) {
        violations.push(
            boundaryPathViolation(
                relativeDirectory,
                "Production source directories may not be symbolic links"
            )
        );
        return;
    }
    const resolvedDirectory = await realpath(absoluteDirectory);
    if (!isContainedPath(realProjectRoot, resolvedDirectory)) {
        violations.push(
            boundaryPathViolation(
                relativeDirectory,
                "Production source real path escapes the repository"
            )
        );
        return;
    }

    const directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });
    const entries = directoryEntries.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
        const relativePath = repositoryPath(path.join(relativeDirectory, entry.name));
        const absolutePath = path.join(lexicalProjectRoot, relativePath);
        const status = await lstat(absolutePath);
        if (status.isSymbolicLink()) {
            violations.push(
                boundaryPathViolation(
                    relativePath,
                    "Production source paths may not be symbolic links"
                )
            );
            continue;
        }
        if (nestedResolverMetadataPattern.test(entry.name)) {
            violations.push(
                boundaryPathViolation(
                    relativePath,
                    "Nested source resolver metadata is forbidden; only reviewed repository-root configuration may control resolution"
                )
            );
            continue;
        }
        if (status.isDirectory()) {
            await discoverDirectory(
                lexicalProjectRoot,
                realProjectRoot,
                relativePath,
                files,
                violations
            );
            continue;
        }
        if (!sourceExtensionPattern.test(entry.name)) continue;
        if (!status.isFile()) {
            violations.push(
                boundaryPathViolation(
                    relativePath,
                    "Production source paths must be regular files"
                )
            );
            continue;
        }
        const resolvedFile = await realpath(absolutePath);
        if (!isContainedPath(realProjectRoot, resolvedFile)) {
            violations.push(
                boundaryPathViolation(
                    relativePath,
                    "Production source real path escapes the repository"
                )
            );
            continue;
        }
        files.add(relativePath);
    }
}

async function discoverRootSources(
    lexicalProjectRoot: string,
    realProjectRoot: string,
    files: Set<string>,
    violations: SourceBoundaryViolation[]
): Promise<void> {
    const rootEntries = await readdir(lexicalProjectRoot, { withFileTypes: true });
    const sourceEntries = rootEntries
        .filter((entry) => sourceExtensionPattern.test(entry.name))
        .toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of sourceEntries) {
        const relativePath = entry.name;
        const absolutePath = path.join(lexicalProjectRoot, relativePath);
        const status = await lstat(absolutePath);
        if (status.isSymbolicLink()) {
            violations.push(
                boundaryPathViolation(
                    relativePath,
                    "Production source paths may not be symbolic links"
                )
            );
            continue;
        }
        if (!status.isFile()) {
            violations.push(
                boundaryPathViolation(
                    relativePath,
                    "Production source paths must be regular files"
                )
            );
            continue;
        }
        const resolvedFile = await realpath(absolutePath);
        if (!isContainedPath(realProjectRoot, resolvedFile)) {
            violations.push(
                boundaryPathViolation(
                    relativePath,
                    "Production source real path escapes the repository"
                )
            );
            continue;
        }
        files.add(relativePath);
    }
}

async function validateRootDirectoryLayout(
    lexicalProjectRoot: string,
    violations: SourceBoundaryViolation[]
): Promise<void> {
    const rootEntries = await readdir(lexicalProjectRoot, { withFileTypes: true });
    const entries = rootEntries.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            violations.push(
                boundaryPathViolation(
                    entry.name,
                    "Repository-root symbolic links are forbidden until explicitly reviewed"
                )
            );
            continue;
        }
        if (entry.isDirectory() && !reviewedRootDirectories.has(entry.name)) {
            violations.push(
                boundaryPathViolation(
                    entry.name,
                    "Repository-root directories must belong to the exact reviewed project layout"
                )
            );
        }
    }
}

/**
 * Discovers every reviewed production/script source without following symlinks.
 * @param projectRoot Absolute repository root.
 * @returns Sorted sources and fail-closed layout findings.
 */
export async function discoverSourceFiles(projectRoot: string): Promise<SourceDiscovery> {
    const lexicalProjectRoot = path.resolve(projectRoot);
    const realProjectRoot = await realpath(lexicalProjectRoot);
    const files = new Set<string>();
    const violations: SourceBoundaryViolation[] = [];
    await validateRootDirectoryLayout(lexicalProjectRoot, violations);
    for (const directory of ["scripts", "src"] as const) {
        await discoverDirectory(
            lexicalProjectRoot,
            realProjectRoot,
            directory,
            files,
            violations
        );
    }
    await discoverRootSources(lexicalProjectRoot, realProjectRoot, files, violations);
    return {
        files: [...files].toSorted(),
        violations: violations.toSorted((left, right) =>
            left.importer.localeCompare(right.importer)
        ),
    };
}
