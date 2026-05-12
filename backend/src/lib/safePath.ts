import path from "node:path";

/**
 * Validate that a resolved path stays within an allowed root directory.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
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
    const normalizedRoot = path.normalize(rootDir + path.sep);

    if (resolved === normalizedRoot.slice(0, -1) || resolved.startsWith(normalizedRoot)) {
        return resolved;
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
