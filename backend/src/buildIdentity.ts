declare const __BACKEND_BUILD_COMMIT__: string | undefined;

const FULL_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;

/**
 * Returns the commit embedded by the backend bundler.
 *
 * Source-mode development and tests intentionally use a non-release identity.
 * Production readiness requires a bundled full SHA that matches the manifest.
 */
export function getBackendBuildCommit(): string {
    if (
        typeof __BACKEND_BUILD_COMMIT__ === "string" &&
        FULL_COMMIT_SHA_PATTERN.test(__BACKEND_BUILD_COMMIT__)
    ) {
        return __BACKEND_BUILD_COMMIT__;
    }
    return "development";
}
