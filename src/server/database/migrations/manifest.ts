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
            "0cb77ce5239335a4b7b848d72322789e4539a7caa011da9a3dd251eba5a9ba6f",
        snapshotSha256:
            "78a637b02bedaeecef73aa19b3c3d62c83636f5b515d55a817ad188ae80b02cf",
    }),
]);
