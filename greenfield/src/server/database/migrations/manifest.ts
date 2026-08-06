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
            "60e08405387fb2d703f3f1236e0afaf3d8df56ebb9281e7850fa7b506eb1f2b6",
        snapshotSha256:
            "2804e5d1d17c060ba21d290b8fd1e744c9558347b8f593cdede430eca3009af5",
    }),
]);
