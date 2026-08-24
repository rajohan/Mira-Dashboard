import path from "node:path";

import type { SourceBoundaryViolation } from "./policyTypes.ts";

/**
 * Normalizes a path for stable repository-relative diagnostics.
 * @param filePath Candidate filesystem or repository path.
 * @returns Forward-slash-normalized path.
 */
export function repositoryPath(filePath: string): string {
    return filePath.replaceAll("\\", "/");
}

/**
 * Returns whether a resolved candidate stays within a resolved container.
 * @param container Resolved container path.
 * @param candidate Resolved candidate path.
 * @returns Whether the candidate remains contained.
 */
export function isContainedPath(container: string, candidate: string): boolean {
    const relative = path.relative(container, candidate);
    return (
        relative === "" ||
        (!path.isAbsolute(relative) &&
            !relative.startsWith(`..${path.sep}`) &&
            relative !== "..")
    );
}

/**
 * Creates a stable discovery/configuration violation at the owning path.
 * @param importer Repository-relative owning path.
 * @param message Actionable violation detail.
 * @returns Stable source-boundary violation.
 */
export function boundaryPathViolation(
    importer: string,
    message: string
): SourceBoundaryViolation {
    return { importer: repositoryPath(importer), line: 1, message };
}
