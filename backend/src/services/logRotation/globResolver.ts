import fs from "node:fs/promises";
import path from "node:path";

export function escapeRegExp(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function globPatternSource(pattern: string): string {
    return pattern
        .split(/(\*|\[0-9\])/u)
        .map((part) => {
            if (part === "*") {
                return "[^/]*";
            }
            if (part === "[0-9]") {
                return "[0-9]";
            }
            return escapeRegExp(part);
        })
        .join("");
}

// Patterns come from admin-controlled config, and metacharacters are escaped
// before the only supported glob tokens are interpolated.
function globToRegex(pattern: string): RegExp {
    const normalized = pattern.split(path.sep).join("/");
    return new RegExp(`^${globPatternSource(normalized)}$`);
}

function segmentRegex(segment: string): RegExp {
    return new RegExp(`^${globPatternSource(segment)}$`);
}

export function isMissingPathError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR"].includes(String(error.code))
    );
}

export function isPathExistsError(error: unknown): boolean {
    return error instanceof Error && "code" in error && String(error.code) === "EEXIST";
}

function hasGlobMeta(pattern: string): boolean {
    return /\*|\[0-9\]/u.test(pattern);
}

async function appendGlobWildcardCandidates(options: {
    candidate: string;
    isLastSegment: boolean;
    nextCandidates: string[];
    regex: RegExp | undefined;
}): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
        entries = await fs.readdir(options.candidate, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }
        throw error;
    }
    for (const entry of entries) {
        if (
            !entry.isSymbolicLink() &&
            options.regex?.test(entry.name) &&
            (options.isLastSegment || entry.isDirectory())
        ) {
            options.nextCandidates.push(path.join(options.candidate, entry.name));
        }
    }
}

/**
 * Resolves the intentionally small supported log-path glob syntax.
 * @param pattern Absolute or relative log path pattern.
 * @param options Missing-path handling options.
 * @returns Matching filesystem paths.
 */
export async function resolveLogGlob(
    pattern: string,
    options: { missingOk?: boolean } = {}
): Promise<string[]> {
    const absolutePattern = path.resolve(pattern);
    const segments = absolutePattern.split(path.sep).filter(Boolean);
    let candidates: string[] = [path.sep];

    for (const [index, segment] of segments.entries()) {
        const hasWildcard = hasGlobMeta(segment);
        const isLastSegment = index === segments.length - 1;
        const regex = hasWildcard ? segmentRegex(segment) : undefined;
        const nextCandidates: string[] = [];
        for (const candidate of candidates) {
            if (hasWildcard) {
                await appendGlobWildcardCandidates({
                    candidate,
                    isLastSegment,
                    nextCandidates,
                    regex,
                });
            } else {
                nextCandidates.push(path.join(candidate, segment));
            }
        }
        candidates = nextCandidates;
        if (candidates.length === 0) break;
    }

    const files: string[] = [];
    for (const candidate of candidates) {
        try {
            const stat = await fs.lstat(candidate);
            if (stat.isFile()) files.push(candidate);
        } catch (error) {
            if (isMissingPathError(error)) {
                continue;
            }
            throw error;
        }
    }
    const regex = globToRegex(absolutePattern);
    const matchedFiles = files.filter((file) =>
        regex.test(file.split(path.sep).join("/"))
    );
    if (
        options.missingOk === false &&
        !hasGlobMeta(pattern) &&
        matchedFiles.length === 0
    ) {
        throw new Error(`Log rotation path does not exist: ${pattern}`);
    }
    return matchedFiles;
}
