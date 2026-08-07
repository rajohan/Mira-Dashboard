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
            "ad96460f166f83ed20ba077bd75716c4cf97274b5bfe0b6fa6a56ddd0ed1ebc6",
        snapshotSha256:
            "16e382f0aca3a2e0769db17e282cc08a9645e2d9ea45e9e274618c00c9bd34ec",
    }),
]);
