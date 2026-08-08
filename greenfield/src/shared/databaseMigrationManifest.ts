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
            "d903247e58b7354c6ba80525e1a81ac529a6dfc5324b391fbad6ce4c93165b8b",
        snapshotSha256:
            "1147c8da79981f058c4b2afd953253b31aaae10804f9357a5601f0dcafcd293c",
    }),
]);
