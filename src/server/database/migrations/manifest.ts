/** Immutable file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    id: string;
    migrationSha256: string;
    snapshotSha256: string;
}

/** Reviewed migration files accepted by the greenfield runtime. */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260803215711_greenfield-foundation",
        migrationSha256:
            "377eb0360d021c076f0e1dac57760e3792eaebd0dc12ecd9d0ff00537c68d0e5",
        snapshotSha256:
            "c2659ab4de437cffd48ee1f70312faf0c2aa4ad283fb0ddf19e6cf533bd5ef7a",
    }),
]);
