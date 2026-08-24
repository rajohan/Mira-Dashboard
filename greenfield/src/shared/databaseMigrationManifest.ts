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
            "731f3e09c89b04ede49bc8246258c87f8634f450afada7803c1d9d56abf7d7b5",
        snapshotSha256:
            "d11bb1e2f1a9e0f311090e75944402d480b37f2a866be474eb8d58aad5da9e6d",
    }),
]);
