/** Fixed local account delegated to Tailscale for preview Serve publication. */
export const previewTailscaleOperatorUser = "ubuntu";

/** Exact provisioning artifacts admitted into an immutable release. */
export const previewTailscaleProvisioningReleaseArtifactPaths = Object.freeze([
    "scripts/delivery/provisioning/preview-tailscale/README.md",
    "scripts/delivery/provisioning/preview-tailscale/operator.ts",
    "scripts/delivery/provisioning/preview-tailscale/policy.ts",
] as const);
