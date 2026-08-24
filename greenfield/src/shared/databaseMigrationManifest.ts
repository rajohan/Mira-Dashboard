/** Reviewed file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    readonly id: string;
    readonly migrationSha256: string;
    readonly snapshotSha256: string;
}

/** Public schema target encoded into immutable release display metadata. */
export const databaseSchemaTarget = 1;

/**
 * Reviewed migration files accepted by runtime and release tooling.
 * The unpublished rewrite keeps one evolving fresh-database baseline until cutover.
 */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_dashboard-foundation",
        migrationSha256:
            "ee99537f9abd98d6dc62ecb2d0d3b060f9b308d7edd05b21dcd6caa3e8447003",
        snapshotSha256:
            "c3c2214d6af85a2a28d6c59ca6a20c9d7c8c7268116f79a505450774579647a8",
    }),
]);
