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
            "068e7ae758558b91abe39282c3fe9480d5b813953fb64bd0603b4c5444a41816",
        snapshotSha256:
            "bb7a62a5e42402a10b52111ac864ee93c779e966b8cb5c236b34ea7ac825b3f9",
    }),
]);
