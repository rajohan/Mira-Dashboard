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

    // For existing paths, use realpathSync to resolve symlinks and
    // canonicalize (CodeQL recognizes this as a path sanitizer).
    // For non-existing paths, just normalize.
    let canonicalRoot: string;
    let canonicalResolved: string;
    try {
        canonicalRoot = fs.realpathSync(rootDir);
    } catch {
        canonicalRoot = path.normalize(rootDir);
    }
    try {
        canonicalResolved = fs.realpathSync(resolved);
    } catch {
        canonicalResolved = resolved;
    }

    const normalizedRoot = canonicalRoot + path.sep;

    if (
        canonicalResolved === canonicalRoot ||
        canonicalResolved.startsWith(normalizedRoot)
    ) {
        return canonicalResolved;
    }

    return null;
}

/**
 * Sanitize a filename to prevent directory traversal components.
 * Strips path separators and parent directory references.
 */
export function sanitizeFilename(name: string): string {
    return path.basename(name);
}
