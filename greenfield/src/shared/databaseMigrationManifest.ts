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
            "a4840263672b4e7623d839a22cfaf1d11e2eb285845af36fd826834f64f8c08e",
        snapshotSha256:
            "dd1820ce6209745ff0445e1b125af8b863315d49852e5596211db41f2f4b9181",
    }),
]);
