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
            "ef0060c95a9b572d11eddba8f101a9b2e24b482fc64518f880aa98a61308358d",
        snapshotSha256:
            "9f490d95c1009c7fb63d65e29acf109029da3b1edea384ba571c93f2935df8ad",
    }),
]);
