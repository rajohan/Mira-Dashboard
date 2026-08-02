/** Backend-owned allowlist shared by preview authorization and UI metadata. */
const PULL_REQUEST_PREVIEW_ALLOWED_AUTHORS = ["mira-2026", "rajohan"] as const;

/**
 * Resolves the single backend-owned allowlist used by preview auth and UI metadata.
 * @returns Resolved the single backend-owned allowlist used by preview auth and UI metadata.
 */
export function resolvePullRequestPreviewAllowedAuthors(): ReadonlySet<string> {
    return new Set(PULL_REQUEST_PREVIEW_ALLOWED_AUTHORS);
}

/**
 * Checks one GitHub login against the normalized backend preview allowlist.
 * @param authorLogin Author login value.
 * @param allowedAuthors Allowed authors value.
 * @returns Whether the pull request author may start a preview.
 */
export function isPullRequestPreviewAuthorAllowed(
    authorLogin: string | undefined,
    allowedAuthors: ReadonlySet<string>
): boolean {
    return Boolean(authorLogin && allowedAuthors.has(authorLogin.trim().toLowerCase()));
}
