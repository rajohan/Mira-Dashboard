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
            "34757683759f61e83e079fa32e9c19689a0c551eabfdbd64529ec046a9754f58",
        snapshotSha256:
            "0632ea5278a0b7939ba15229fecfd99f8407ae712233500d1223825f5bbd0acb",
    }),
]);
