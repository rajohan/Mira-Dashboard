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
            "c874450ba38677196570c9b00da8a491bbef886017d19e10c2118c583150b05f",
        snapshotSha256:
            "1ae12268580576739e63b8fa042b2d7424d6489b4483221287872e5c9ff12aef",
    }),
]);
