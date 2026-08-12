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
            "6ce8ff84c4f4db5c6f3e468d70fd3391a2ff38808d420b0d348ff0e0e6b19bf2",
        snapshotSha256:
            "37fbadb762d3ba13a38a45338f005ad35113e5b1f7af08de498ca14aacf2f37e",
    }),
]);
