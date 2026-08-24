/** Reviewed file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    id: string;
    migrationSha256: string;
    snapshotSha256: string;
}

/**
 * Reviewed migration files accepted by the application runtime.
 * The unpublished rewrite keeps one evolving fresh-database baseline until cutover.
 */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_dashboard-foundation",
        migrationSha256:
            "3c4217d319c85af9ff15e165aeb16a781a62653d02675383150dfb39e72eeef8",
        snapshotSha256:
            "ccfc5530abcba874cf22cf4710187b1d25ef8b8d027eae59e7c1d784552b3e31",
    }),
]);
