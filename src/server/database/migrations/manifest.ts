/** Immutable file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    id: string;
    migrationSha256: string;
    snapshotSha256: string;
}

/** Reviewed migration files accepted by the greenfield runtime. */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_greenfield-foundation",
        migrationSha256:
            "0cb77ce5239335a4b7b848d72322789e4539a7caa011da9a3dd251eba5a9ba6f",
        snapshotSha256:
            "112163e5fa4dfae881c39839096d37377c30d45488d391fb2731145f3a35551c",
    }),
]);
