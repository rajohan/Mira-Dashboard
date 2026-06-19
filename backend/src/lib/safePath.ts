import fs from "node:fs";
import path from "node:path";

/** Resolves symlinks through the deepest existing ancestor of a path. */
function canonicalizePotentialPath(targetPath: string): string {
    let existingAncestor = targetPath;
    const missingParts: string[] = [];

    while (true) {
        try {
            const canonicalAncestor = fs.realpathSync(existingAncestor);
            let canonicalResolved = canonicalAncestor;
            for (let index = missingParts.length - 1; index >= 0; index -= 1) {
                canonicalResolved = path.join(canonicalResolved, missingParts[index]);
            }

            return canonicalResolved;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }

            const parent = path.dirname(existingAncestor);
            if (parent === existingAncestor) {
                throw error;
            }

            missingParts.push(path.basename(existingAncestor));
            existingAncestor = parent;
        }
    }
}

function isFilesystemRoot(rootPath: string): boolean {
    return path.parse(rootPath).root === rootPath;
}

function isWithinCanonicalRoot(candidate: string, root: string, normalizedRoot: string) {
    return candidate === root || candidate.startsWith(normalizedRoot);
}

function isSameFile(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function createChildDirectoryFromVerifiedParent(
    realParent: string,
    childName: string
): string | null {
    if (process.platform !== "linux") {
        const nextParent = path.join(realParent, childName);
        const checkedRealParent = fs.realpathSync(Buffer.from(realParent));
        if (
            checkedRealParent !== realParent ||
            !fs.statSync(Buffer.from(checkedRealParent)).isDirectory()
        ) {
            return null;
        }
        try {
            fs.mkdirSync(Buffer.from(nextParent));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
        const realNextParent = fs.realpathSync(Buffer.from(nextParent));
        if (
            realNextParent !== nextParent ||
            !fs.statSync(Buffer.from(realNextParent)).isDirectory()
        ) {
            return null;
        }
        return realNextParent;
    }

    const parentFd = fs.openSync(
        Buffer.from(realParent),
        fs.constants.O_DIRECTORY | fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const parentStatBefore = fs.fstatSync(parentFd);
        const pathParentStatBefore = fs.statSync(Buffer.from(realParent));
        if (!isSameFile(parentStatBefore, pathParentStatBefore)) {
            return null;
        }

        const nextParent = path.join("/proc/self/fd", String(parentFd), childName);
        try {
            fs.mkdirSync(Buffer.from(nextParent));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }

        const parentStatAfter = fs.fstatSync(parentFd);
        const pathParentStatAfter = fs.statSync(Buffer.from(realParent));
        if (
            !isSameFile(parentStatBefore, parentStatAfter) ||
            !isSameFile(parentStatAfter, pathParentStatAfter)
        ) {
            return null;
        }

        const realNextParent = fs.realpathSync(Buffer.from(nextParent));
        if (
            realNextParent !== path.join(realParent, childName) ||
            !fs.statSync(Buffer.from(realNextParent)).isDirectory()
        ) {
            return null;
        }
        return realNextParent;
    } finally {
        fs.closeSync(parentFd);
    }
}

/**
 * Validate that a resolved path stays within an allowed root directory.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
 *
 * Uses path.resolve + realpathSync (for existing path ancestors) to canonicalize,
 * then verifies the result starts with the root. This pattern is recommended by
 * CodeQL (js/path-injection) as a path sanitizer.
 *
 * Returns the resolved absolute path if safe, or null if the path escapes root.
 */
export function safePathWithinRoot(
    userPath: string,
    rootDirectory: string
): string | null {
    if (!userPath || typeof userPath !== "string") {
        return null;
    }

    // Reject null bytes which can trick path resolution
    if (userPath.includes("\0")) {
        return null;
    }

    try {
        const canonicalRoot = canonicalizePotentialPath(path.resolve(rootDirectory));
        if (isFilesystemRoot(canonicalRoot)) {
            return null;
        }

        const canonicalResolved = canonicalizePotentialPath(
            path.resolve(rootDirectory, userPath)
        );
        const normalizedRoot = canonicalRoot + path.sep;

        if (isWithinCanonicalRoot(canonicalResolved, canonicalRoot, normalizedRoot)) {
            return canonicalResolved;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Creates any missing parent directories for a previously root-validated write target.
 *
 * Directory creation starts from the deepest existing canonical ancestor instead of
 * calling `mkdir -p` on the lexical target path. That prevents a concurrently swapped
 * symlinked ancestor from causing directory creation outside the allowed root.
 */
export function prepareSafeWriteTargetWithinRoot(
    fullPath: string,
    rootDirectory: string
): string | null {
    if (!fullPath || fullPath.includes("\0")) {
        return null;
    }

    try {
        const canonicalRoot = canonicalizePotentialPath(path.resolve(rootDirectory));
        if (isFilesystemRoot(canonicalRoot)) {
            return null;
        }

        const resolvedTarget = path.resolve(fullPath);
        let canonicalTarget: string;
        try {
            canonicalTarget = fs.realpathSync(fullPath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                throw error;
            }
            canonicalTarget = canonicalizePotentialPath(resolvedTarget);
        }

        const normalizedCanonicalRoot = canonicalRoot + path.sep;
        if (
            !isWithinCanonicalRoot(
                canonicalTarget,
                canonicalRoot,
                normalizedCanonicalRoot
            )
        ) {
            return null;
        }

        const rootMissingSegments: string[] = [];
        let rootExistingAncestor = canonicalRoot;
        while (true) {
            try {
                const realRootAncestor = fs.realpathSync(rootExistingAncestor);
                if (
                    realRootAncestor !== rootExistingAncestor ||
                    !fs.statSync(Buffer.from(realRootAncestor)).isDirectory()
                ) {
                    return null;
                }

                let realParent = realRootAncestor;
                for (let index = rootMissingSegments.length - 1; index >= 0; index -= 1) {
                    const realNextParent = createChildDirectoryFromVerifiedParent(
                        realParent,
                        rootMissingSegments[index]
                    );
                    if (!realNextParent) {
                        return null;
                    }
                    realParent = realNextParent;
                }
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }

                const parent = path.dirname(rootExistingAncestor);
                if (parent === rootExistingAncestor) {
                    return null;
                }

                rootMissingSegments.push(path.basename(rootExistingAncestor));
                rootExistingAncestor = parent;
            }
        }

        const realRoot = fs.realpathSync(canonicalRoot);
        if (realRoot !== canonicalRoot) {
            return null;
        }
        const normalizedRoot = realRoot + path.sep;

        try {
            if (fs.lstatSync(Buffer.from(resolvedTarget)).isSymbolicLink()) {
                return null;
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") {
                throw error;
            }
        }

        const targetParent = path.dirname(resolvedTarget);
        const missingSegments: string[] = [];
        let existingAncestor = targetParent;

        while (true) {
            try {
                const realAncestor = fs.realpathSync(existingAncestor);
                const ancestorStat = fs.statSync(Buffer.from(realAncestor));
                if (!ancestorStat.isDirectory()) {
                    return null;
                }

                if (!isWithinCanonicalRoot(realAncestor, realRoot, normalizedRoot)) {
                    return null;
                }

                let realParent = realAncestor;
                for (let index = missingSegments.length - 1; index >= 0; index -= 1) {
                    const realNextParent = createChildDirectoryFromVerifiedParent(
                        realParent,
                        missingSegments[index]
                    );
                    if (!realNextParent) {
                        return null;
                    }

                    realParent = realNextParent;
                }

                return path.join(realParent, path.basename(resolvedTarget));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }

                const parent = path.dirname(existingAncestor);
                if (parent === existingAncestor) {
                    return null;
                }

                missingSegments.push(path.basename(existingAncestor));
                existingAncestor = parent;
            }
        }
    } catch {
        return null;
    }
}

/**
 * Sanitize a filename to prevent directory traversal components.
 * Strips path separators and parent directory references.
 */
export function sanitizeFilename(name: string): string {
    const base = path.basename(name);
    if (!base || base === "." || base === ".." || base.includes("\0")) {
        throw new Error("Invalid filename");
    }

    return base;
}
