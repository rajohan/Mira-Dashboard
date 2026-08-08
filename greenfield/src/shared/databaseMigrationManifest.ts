/** Reviewed file identity for one ordered Drizzle migration node. */
export interface MigrationManifestEntry {
    readonly id: string;
    readonly migrationSha256: string;
    readonly snapshotSha256: string;
}

/**
 * Reviewed migration files accepted by runtime and release tooling.
 * The unpublished rewrite keeps one evolving fresh-database baseline until cutover.
 */
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "20260804022252_dashboard-foundation",
        migrationSha256:
            "d80877fec12ccec667aed46bf563db64df3b51ce6af1e2dc790a9c0ff68f2c80",
        snapshotSha256:
            "643b6f6ad7c52f89509b568817096cfca54ee8e3062faceb32b5d8d588bbe7db",
    }),
]);
