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
            "a32f06570d2cf598ed3400983e7155cb1c8bebcffb418a81a15e42888053f526",
        snapshotSha256:
            "80c85d99b197eef73e60da3dabed3e17f7c7031e9fee7cf3cedbbb0647a7260c",
    }),
]);
