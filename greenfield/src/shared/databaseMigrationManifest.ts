/** Reviewed file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    readonly id: string;
    readonly migrationSha256: string;
    readonly snapshotSha256: string;
}

/**
 * Reviewed migration files accepted by runtime and release tooling.
 * The unpublished rewrite keeps one evolving fresh-database baseline until cutover.
 */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_dashboard-foundation",
        migrationSha256:
            "d653ae53363e6a25eb5fd320d0db22d27bced1651d9d6bd50525aa953a3b2995",
        snapshotSha256:
            "6aff5552e3a71243e082ce3affba9825543d7c7a93215d8903e00447ee88b422",
    }),
]);
