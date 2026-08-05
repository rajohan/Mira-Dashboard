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
            "642accfba32c8e838c034016514b3f2123d7366ce236e1c372cc1b9a9e517ede",
        snapshotSha256:
            "ad3c873a6a4adf978e526be82019be8d8120f101b61a8e3391cf6a5ed51933ab",
    }),
]);
