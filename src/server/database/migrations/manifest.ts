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
    Object.freeze({
        id: "20260805071222_security-core",
        migrationSha256:
            "4a2bd8d3915a32edf2512f737a0793eaaf6dd17e8eaa4ca9f2ea46f0e0fb2576",
        snapshotSha256:
            "9ff96f231ebedc572df83560b4d5d56f65d78b6e5abe070ba8235e5b88335e28",
    }),
]);
