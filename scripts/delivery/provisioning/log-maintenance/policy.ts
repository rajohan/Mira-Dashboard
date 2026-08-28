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
            "scripts/delivery/provisioning/log-maintenance/mira-dashboard-managed-log-access",
        destinationPath: "/usr/local/libexec/mira-dashboard-managed-log-access",
        mode: 0o755,
    }),
    Object.freeze({
        artifactPath: "systemd/log-maintenance/mira-dashboard-managed-log-access.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-managed-log-access.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath: "systemd/log-maintenance/mira-dashboard-log-maintenance@.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-log-maintenance@.service",
        mode: 0o644,
    }),
] as const);

export type LogMaintenanceProvisioningArtifactPolicy =
    (typeof logMaintenanceProvisioningArtifacts)[number];

/** Exact host directory the installer may create when absent on a fresh host. */
export const logMaintenanceProvisioningCreatedDirectories = Object.freeze([
    Object.freeze({ destinationPath: "/usr/local/libexec", mode: 0o755 }),
] as const);

/** Reviewed non-installed support files shipped with the root installer. */
export const logMaintenanceProvisioningSupportArtifactPaths = Object.freeze([
    "scripts/delivery/provisioning/log-maintenance/README.md",
    "scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts",
    "scripts/delivery/provisioning/log-maintenance/logMaintenanceProvisioningFilesystem.ts",
    "scripts/delivery/provisioning/log-maintenance/policy.ts",
    "scripts/delivery/provisioning/log-maintenance/migrateManagedApplicationLogs.ts",
    "scripts/delivery/provisioning/log-maintenance/provisionManagedLogAccess.ts",
] as const);

/** Complete exact provisioning subtree admitted into an immutable release. */
export const logMaintenanceProvisioningReleaseArtifactPaths = Object.freeze(
    [
        ...logMaintenanceProvisioningArtifacts
            .map(({ artifactPath }) => artifactPath)
            .filter((artifactPath) =>
                artifactPath.startsWith("scripts/delivery/provisioning/log-maintenance/")
            ),
        ...logMaintenanceProvisioningSupportArtifactPaths,
    ].toSorted()
);

/** Every immutable-release artifact read and revalidated by the root installer. */
export const logMaintenanceProvisioningSourceArtifactPaths = Object.freeze(
    [
        ...logMaintenanceProvisioningReleaseArtifactPaths,
        ...logMaintenanceProvisioningArtifacts.map(({ artifactPath }) => artifactPath),
    ]
        .toSorted()
        .filter((artifactPath, index, paths) => paths[index - 1] !== artifactPath)
);
