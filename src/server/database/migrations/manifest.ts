/** Immutable file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    id: string;
    migrationSha256: string;
    snapshotSha256: string;
}

/** Reviewed migration files accepted by the greenfield runtime. */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260803233257_greenfield-foundation",
        migrationSha256:
            "ab13c459441d1aea46fc854ebe3359535392901416ba179b415488919f218c5b",
        snapshotSha256:
            "6867fc6458c9394e265d972b48f8e233a3d190b175fe39808f8e33ed2024d3df",
    }),
]);
