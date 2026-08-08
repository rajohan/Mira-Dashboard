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
            "3f87fd36f2371de5a6243383bb62fb74ccb4d72fc90ec5cab875ea5d5c8ea1bd",
        snapshotSha256:
            "6eabd3a99d84f0a9d64fc7ddd70acf3ab3799569748bf3f32d9996beba7d876e",
    }),
]);
