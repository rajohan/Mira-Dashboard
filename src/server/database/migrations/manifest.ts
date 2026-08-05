/** Reviewed file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    id: string;
    migrationSha256: string;
    snapshotSha256: string;
}

/**
 * Reviewed migration files accepted by the application runtime.
 * The unpublished rewrite keeps one evolving fresh-database baseline until cutover.
 */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_dashboard-foundation",
        migrationSha256:
            "ddc0837ed5bf69c252c165ee647984c3b6a712b381ee7bb2d056a545a4acd24a",
        snapshotSha256:
            "63ae5b5655064c53a54ff2c283b07ad095940ed5f9a7d9ade0593cf21adf3148",
    }),
]);
