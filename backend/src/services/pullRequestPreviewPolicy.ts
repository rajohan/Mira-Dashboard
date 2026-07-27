const DEFAULT_ALLOWED_AUTHORS = "mira-2026,rajohan";

/** Resolves the single backend-owned allowlist used by preview auth and UI metadata. */
export function resolvePullRequestPreviewAllowedAuthors(
    configuredValue: string | undefined
): ReadonlySet<string> {
    const allowedAuthors = new Set(
        (configuredValue === undefined ? DEFAULT_ALLOWED_AUTHORS : configuredValue)
            .split(",")
            .map((author) => author.trim().toLowerCase())
            .filter(Boolean)
    );
    if (allowedAuthors.size === 0) {
        throw new TypeError(
            "MIRA_DASHBOARD_PREVIEW_ALLOWED_AUTHORS must contain at least one author"
        );
    }
    return allowedAuthors;
}

/** Checks one GitHub login against the normalized backend preview allowlist. */
export function isPullRequestPreviewAuthorAllowed(
    authorLogin: string | undefined,
    allowedAuthors: ReadonlySet<string>
): boolean {
    return Boolean(authorLogin && allowedAuthors.has(authorLogin.trim().toLowerCase()));
}
