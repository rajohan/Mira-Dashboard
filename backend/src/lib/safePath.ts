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
export function safePathWithinRoot(userPath: string, rootDir: string): string | null {
    if (!userPath || typeof userPath !== "string") {
        return null;
    }

    // Reject null bytes which can trick path resolution
    if (userPath.includes("\0")) {
        return null;
    }

    try {
        const canonicalRoot = canonicalizePotentialPath(path.resolve(rootDir));
        const canonicalResolved = canonicalizePotentialPath(
            path.resolve(rootDir, userPath)
        );
        const normalizedRoot = canonicalRoot + path.sep;

        if (
            canonicalResolved === canonicalRoot ||
            canonicalResolved.startsWith(normalizedRoot)
        ) {
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
    rootDir: string
): string | null {
    if (!fullPath || fullPath.includes("\0")) {
        return null;
    }

    try {
        const canonicalRoot = canonicalizePotentialPath(path.resolve(rootDir));
        fs.mkdirSync(Buffer.from(canonicalRoot), { recursive: true });

        const realRoot = fs.realpathSync(canonicalRoot);
        if (realRoot !== canonicalRoot) {
            return null;
        }

        const normalizedRoot = realRoot + path.sep;
        const resolvedTarget = path.resolve(fullPath);

        if (resolvedTarget !== realRoot && !resolvedTarget.startsWith(normalizedRoot)) {
            return null;
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

                if (
                    realAncestor !== realRoot &&
                    !realAncestor.startsWith(normalizedRoot)
                ) {
                    return null;
                }

                let realParent = realAncestor;
                for (let index = missingSegments.length - 1; index >= 0; index -= 1) {
                    const nextParent = path.join(realParent, missingSegments[index]);
                    try {
                        fs.mkdirSync(Buffer.from(nextParent));
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                            throw error;
                        }
                    }

                    const realNextParent = fs.realpathSync(nextParent);
                    const nextParentStat = fs.statSync(Buffer.from(realNextParent));

                    if (!nextParentStat.isDirectory()) {
                        return null;
                    }

                    if (
                        realNextParent !== realRoot &&
                        !realNextParent.startsWith(normalizedRoot)
                    ) {
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
