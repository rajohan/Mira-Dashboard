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
            "7bddc833c8a5aa79eff2f40ead6d56aa9f4abdd9308cfaa11aa3657e4f4bcf74",
        snapshotSha256:
            "bd090f5f045ff40968eef792fb6deb83fa128c4abc1442a9ba0c068078201e79",
    }),
]);
