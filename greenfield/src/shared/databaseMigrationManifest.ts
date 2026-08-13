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
            "34939ea6f2e0e82ec872b5c6bb08889ccc9e616ece20a36be718ff9cc3fb1f35",
        snapshotSha256:
            "747d5a56bd663bdd7c61f7a88cd45dbef72338406b2cdb4cf3cbc22b26e19278",
    }),
]);
