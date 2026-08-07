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
            "ba6f427bec9769eca274fc0633ff8784a1cab24602045c0328b98dd09cfe5d91",
        snapshotSha256:
            "7ad0b8dfd66e7c5de8c8a06c093d75ec1b7ac7541bad76a737574ac57a0d4c0e",
    }),
]);
