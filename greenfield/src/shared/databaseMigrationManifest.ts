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
            "93fa9faef50b77730f828258f2082557639749d43130524010e01fbdd54e1dbe",
        snapshotSha256:
            "9e630567c11629627699907a6a6899d3e33a41c9ebe50ce2c5dae9f8c4f53c6b",
    }),
]);
