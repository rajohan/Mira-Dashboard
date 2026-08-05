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
            "a195b1914088adfe04aa5dca883bd8b55d3c9060d282a3fc53f958a6eb2a867c",
        snapshotSha256:
            "bc7f18ca16720eea05bb9ff71909d55de096d22c9ae65d44f469aac9e032f53d",
    }),
]);
