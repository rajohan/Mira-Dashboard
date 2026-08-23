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
            "9db995390b2753a7af54d478f4ada2a720f3b5d792b5c2be8d21db6bf428bb23",
        snapshotSha256:
            "0fc29980398107f6c0e82519107b0d054220c836cfdd3fe96e9c51fbacf314c3",
    }),
]);
