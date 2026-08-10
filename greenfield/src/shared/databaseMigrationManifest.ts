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
            "c2f48bcfb7555b826eb6c0f402f4acd7ba8886fcacce19a9692a208a76ab4671",
        snapshotSha256:
            "ae6526ef32910acba76e88ed5574ed0bae619c0fe3b5abc8f7895deca9f034d5",
    }),
]);
