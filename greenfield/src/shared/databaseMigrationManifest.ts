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
            "012e2c962390e98462be5ed846840ae5b61d5f8f41f5e2beda6797837b2fb8bc",
        snapshotSha256:
            "1533a0a9d22ef6709388039231ff0d495765d6bc1e9de01c00ad897447c4d86e",
    }),
]);
