/** Immutable file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    id: string;
    migrationSha256: string;
    snapshotSha256: string;
}

/** Reviewed migration files accepted by the application runtime. */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_dashboard-foundation",
        migrationSha256:
            "692e9c325ffd790e554a67c007dd421e00076e71919c6c18fed28059116923fd",
        snapshotSha256:
            "d1d97eccf4ba5fb63b0058c41599d629dbe65c97656f0a5e060ab671acb5d8b1",
    }),
]);
