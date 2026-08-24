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
            "4d7ab61a9740f9d30542edb4893db34e48b00121ba0890c6aada1ac75da000fe",
        snapshotSha256:
            "d0f85e519891528365bde94b9a1513b95c6e0130125e866bd5e7ab3c67cb9d35",
    }),
]);
