import path from "node:path";

/** Canonical lexical paths for one repository-contained build output. */
export interface RepositoryBuildPath {
    readonly distRoot: string;
    readonly output: string;
    readonly repositoryRoot: string;
}

/**
 * Resolves one explicit build output as a strict child of the repository `dist` tree.
 * @param repositoryRoot Normalized absolute future-root checkout.
 * @param outputDirectory Normalized absolute output directory.
 * @param errorMessage Fixed caller-owned validation failure.
 * @returns Canonical lexical repository, dist, and output paths.
 */
export function resolveRepositoryBuildPath(
    repositoryRoot: string,
    outputDirectory: string,
    errorMessage: string
): RepositoryBuildPath {
    const root = path.resolve(repositoryRoot);
    const output = path.resolve(outputDirectory);
    const distRoot = path.join(root, "dist");
    if (
        !path.isAbsolute(repositoryRoot) ||
        !path.isAbsolute(outputDirectory) ||
        repositoryRoot.includes("\0") ||
        outputDirectory.includes("\0") ||
        root !== repositoryRoot ||
        output !== outputDirectory ||
        !output.startsWith(`${distRoot}${path.sep}`)
    ) {
        throw new TypeError(errorMessage);
    }
    return Object.freeze({ distRoot, output, repositoryRoot: root });
}
