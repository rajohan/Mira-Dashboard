import fs from "node:fs";
import path from "node:path";

/**
 * Validate that a resolved path stays within an allowed root directory.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
 *
 * Uses path.resolve + realpathSync (for existing paths) to canonicalize,
 * then verifies the result starts with the root. This pattern is
 * recommended by CodeQL (js/path-injection) as a path sanitizer.
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

    const resolved = path.resolve(rootDir, userPath);

    // Resolve the root and the deepest existing ancestor. For paths that do not
    // exist yet, this still catches symlink escapes such as root/link/new-file
    // where link points outside root.
    let canonicalRoot: string;
    try {
        canonicalRoot = fs.realpathSync(rootDir);
    } catch {
        return null;
    }

    let existingAncestor = resolved;
    const missingParts: string[] = [];

    while (true) {
        try {
            const canonicalAncestor = fs.realpathSync(existingAncestor);
            let canonicalResolved = canonicalAncestor;
            for (let index = missingParts.length - 1; index >= 0; index -= 1) {
                canonicalResolved = path.join(canonicalResolved, missingParts[index]);
            }

            const normalizedRoot = canonicalRoot + path.sep;

            if (
                canonicalResolved === canonicalRoot ||
                canonicalResolved.startsWith(normalizedRoot)
            ) {
                return canonicalResolved;
            }

            return null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return null;
            }

            const parent = path.dirname(existingAncestor);
            if (parent === existingAncestor) {
                return null;
            }

            missingParts.push(path.basename(existingAncestor));
            existingAncestor = parent;
        }
    }
}

/**
 * Sanitize a filename to prevent directory traversal components.
 * Strips path separators and parent directory references.
 */
export function sanitizeFilename(name: string): string {
    return path.basename(name);
}
