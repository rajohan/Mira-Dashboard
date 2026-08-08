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
            "60656fc117e41a99169cbd834d345a8f8855521c2f1cbca32c40a396b4520994",
        snapshotSha256:
            "b8fe7f9a03fdcf93389ae08cdacb7d37082fddf1c743f6ad1451eb63a5797274",
    }),
]);
