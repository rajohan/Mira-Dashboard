/** Exact approval-gated database-observability artifacts shipped in a release. */
export const databaseObservabilityProvisioningReleaseArtifactPaths = Object.freeze(
    [
        "README.md",
        "activate-observer.sql",
        "apply-cluster.sql",
        "apply-torrent-view.sql",
        "disable-observer.sql",
        "manifest.json",
        "rollback-cluster.sql",
        "rollback-torrent-view.sql",
        "verify-cluster.sql",
        "verify-database.sql",
        "verify-torrent-view.sql",
    ]
        .map(
            (fileName) =>
                `scripts/delivery/provisioning/database-observability/${fileName}`
        )
        .toSorted()
);
