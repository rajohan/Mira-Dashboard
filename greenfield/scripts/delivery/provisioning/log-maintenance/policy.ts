/** Exact release-relative and host destination policy for root provisioning. */
export const logMaintenanceProvisioningArtifacts = Object.freeze([
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/log-maintenance/60-mira-dashboard-log-maintenance.rules",
        destinationPath: "/etc/polkit-1/rules.d/60-mira-dashboard-log-maintenance.rules",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance",
        destinationPath: "/usr/local/libexec/mira-dashboard-log-maintenance",
        mode: 0o755,
    }),
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance@.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-log-maintenance@.service",
        mode: 0o644,
    }),
] as const);

export type LogMaintenanceProvisioningArtifactPolicy =
    (typeof logMaintenanceProvisioningArtifacts)[number];

/** Reviewed non-installed support files shipped with the root installer. */
export const logMaintenanceProvisioningSupportArtifactPaths = Object.freeze([
    "scripts/delivery/provisioning/log-maintenance/README.md",
    "scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts",
    "scripts/delivery/provisioning/log-maintenance/logMaintenanceProvisioningFilesystem.ts",
    "scripts/delivery/provisioning/log-maintenance/policy.ts",
] as const);

/** Complete exact provisioning subtree admitted into an immutable release. */
export const logMaintenanceProvisioningReleaseArtifactPaths = Object.freeze(
    [
        ...logMaintenanceProvisioningArtifacts.map(({ artifactPath }) => artifactPath),
        ...logMaintenanceProvisioningSupportArtifactPaths,
    ].toSorted()
);
