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
            "73f4cba5631a545f5129be957f1ed92d1a9ff36dd0700f8eb9a4aae2810b98b1",
        snapshotSha256:
            "5d8097256cdc861cbc770bff860dfed3cd92dcb4f52879f6b4d6679aa436f1ec",
    }),
]);
