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
            "832ba77dd409b40067d77235c04e96a2431a2fb7a8640bfbc377169ad6451e86",
        snapshotSha256:
            "1f37fcc03319172a5375b7131764788f30c57febfb568a989c6bfe5c15f6f94c",
    }),
]);
