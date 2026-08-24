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
            "75db9e84537f392fd2792e2cb080f0fd74409948eb183b4b5d16bfc1464405d7",
        snapshotSha256:
            "88d86e029c08d8e41b12295989f5838ce8a54f5f8be936113fe43215d13b59bb",
    }),
]);
