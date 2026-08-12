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
            "7a5e7f5123bcb862ad2c156ba42336bb39e6cbd3ee7d9bc97a5b3583cdea37ea",
        snapshotSha256:
            "33f487a80abcc3e76f964da4e896527d6278f20bf41294c1e8af7ba20df35d84",
    }),
]);
