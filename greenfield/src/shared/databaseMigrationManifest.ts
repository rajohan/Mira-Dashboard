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
            "ffd816aa6360b59ea598cc29fd16d11984c3d55ae1f2c1d5752042c52e9ed1fb",
        snapshotSha256:
            "5f411db554ecb9885b198f5c9748552726a93774b7a5ebbd5fc8e1c69182692a",
    }),
]);
