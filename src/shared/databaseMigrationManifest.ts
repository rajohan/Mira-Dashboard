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
            "6e602222cc583b0306bfd75d94e190524a7704224ef29d1921b1da6242c1ecc4",
        snapshotSha256:
            "25204989f7bf8405fce9997d051a430b5f47c2922fb48c7dcbbc228eb1af990c",
    }),
]);
