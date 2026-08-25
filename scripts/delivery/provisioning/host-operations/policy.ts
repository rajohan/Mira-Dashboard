/** Root-owned durable namespace used by the production provisioning service. */
export const productionHostProvisioningRoot = "/var/lib/mira-dashboard-host-provisioning";

/** Versioned runtime/provisioner pairs selected atomically by the provisioning unit. */
export const productionProvisioningPairsRoot = `${productionHostProvisioningRoot}/pairs`;
export const productionProvisioningPairSelector = `${productionHostProvisioningRoot}/current`;
export const productionProvisioningRuntimeName = "bun";
export const productionProvisioningEntrypointName = "productionProvisioning.js";

/** Largest raw production provisioning process admitted by both build and installer. */
export const maximumProductionProvisioningBundleBytes = 4 * 1024 * 1024;

/** Exact release-relative and host destination policy for root host operations. */
export const hostOperationsProvisioningArtifacts = Object.freeze([
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/host-operations/60-mira-dashboard-host-operations.rules",
        destinationPath: "/etc/polkit-1/rules.d/60-mira-dashboard-host-operations.rules",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/host-operations/mira-dashboard-production-authority.conf",
        destinationPath: "/etc/sysusers.d/mira-dashboard-production-authority.conf",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/host-operations/mira-dashboard-host-operation",
        destinationPath: "/usr/local/libexec/mira-dashboard-host-operation",
        mode: 0o755,
    }),
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/host-operations/mira-dashboard-production-provisioning",
        destinationPath: "/usr/local/libexec/mira-dashboard-production-provisioning",
        mode: 0o755,
    }),
    Object.freeze({
        artifactPath:
            "scripts/delivery/provisioning/host-operations/mira-dashboard-web-runtime",
        destinationPath: "/usr/local/libexec/mira-dashboard-web-runtime",
        mode: 0o755,
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-stack-restart.service",
        destinationPath:
            "/etc/systemd/system/mira-dashboard-deferred-stack-restart.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-stack-restart.timer",
        destinationPath:
            "/etc/systemd/system/mira-dashboard-deferred-stack-restart.timer",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-worker-restart.service",
        destinationPath:
            "/etc/systemd/system/mira-dashboard-deferred-worker-restart.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-worker-restart.timer",
        destinationPath:
            "/etc/systemd/system/mira-dashboard-deferred-worker-restart.timer",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-deferred-reboot.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-deferred-reboot.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-deferred-reboot.timer",
        destinationPath: "/etc/systemd/system/mira-dashboard-deferred-reboot.timer",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-host-system-cleanup.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-host-system-cleanup.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-host-system-restart.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-host-system-restart.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-host-system-update.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-host-system-update.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-provision@.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-provision@.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath: "systemd/mira-dashboard-web.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-web.service",
        mode: 0o644,
    }),
    Object.freeze({
        artifactPath: "systemd/mira-dashboard-worker.service",
        destinationPath: "/etc/systemd/system/mira-dashboard-worker.service",
        mode: 0o644,
    }),
] as const);

export type HostOperationsProvisioningArtifactPolicy =
    (typeof hostOperationsProvisioningArtifacts)[number];

/** Exact host directory the installer may create when absent on a fresh host. */
export const hostOperationsProvisioningCreatedDirectories = Object.freeze([
    Object.freeze({ destinationPath: "/etc/sysusers.d", mode: 0o755 }),
    Object.freeze({ destinationPath: "/usr/local/libexec", mode: 0o755 }),
] as const);

/** Reviewed non-installed support files shipped with the root installer. */
export const hostOperationsProvisioningSupportArtifactPaths = Object.freeze([
    "scripts/delivery/provisioning/host-operations/README.md",
    "scripts/delivery/provisioning/host-operations/hostOperationsProvisioningFilesystem.ts",
    "scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts",
    "scripts/delivery/provisioning/host-operations/policy.ts",
] as const);

/** Complete exact provisioning subtree admitted into an immutable release. */
export const hostOperationsProvisioningReleaseArtifactPaths = Object.freeze(
    [
        ...hostOperationsProvisioningArtifacts
            .map(({ artifactPath }) => artifactPath)
            .filter((artifactPath) =>
                artifactPath.startsWith("scripts/delivery/provisioning/host-operations/")
            ),
        ...hostOperationsProvisioningSupportArtifactPaths,
    ].toSorted()
);

/** Every immutable-release artifact read and revalidated by the root installer. */
export const hostOperationsProvisioningSourceArtifactPaths = Object.freeze(
    [
        ...hostOperationsProvisioningReleaseArtifactPaths,
        ...hostOperationsProvisioningArtifacts.map(({ artifactPath }) => artifactPath),
    ]
        .toSorted()
        .filter((artifactPath, index, paths) => paths[index - 1] !== artifactPath)
);
