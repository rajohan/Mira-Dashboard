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
            "747341bbfe883f794f78143f6e5693c803a4a3d8bfaae8d01aa2691f71a721dc",
        snapshotSha256:
            "1ae12268580576739e63b8fa042b2d7424d6489b4483221287872e5c9ff12aef",
    }),
]);
