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
            "e0dfba3bafa53cc412d5b0b7aaf7599bc9ed85679e21792477dbc1bfd8be2ce5",
        snapshotSha256:
            "ca41710f4b204cec427b7faaca03c49ca68edcec9fca5e78f423e8de90a4b1ee",
    }),
]);
