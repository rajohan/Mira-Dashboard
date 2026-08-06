/** Reviewed file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    id: string;
    migrationSha256: string;
    snapshotSha256: string;
}

/**
 * Reviewed migration files accepted by the application runtime.
 * The unpublished rewrite keeps one evolving fresh-database baseline until cutover.
 */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_dashboard-foundation",
        migrationSha256:
            "ed956d6f421e2114312588e4496b622ded5852d95bc1ccd8616737367139b02e",
        snapshotSha256:
            "b2e919661d6b669d3a7aae037c6ee940fd8780d6465bb4ce1226c063e9601e76",
    }),
]);
