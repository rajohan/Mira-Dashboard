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
            "e8f7c2890e6baef5ad69440ab544b514a687177f47b9a9c34e0f41005ae1b707",
        snapshotSha256:
            "d338b75abe221139c7e758caa63370500e607d6318bf6784e314e37e2836eeec",
    }),
]);
