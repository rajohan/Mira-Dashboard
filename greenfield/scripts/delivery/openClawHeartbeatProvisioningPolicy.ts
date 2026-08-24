import path from "node:path";

export const openClawHeartbeatProvisioningReleaseArtifactPaths = Object.freeze([
    "scripts/delivery/provisioning/openclaw-heartbeat/HEARTBEAT.md",
] as const);

export const openClawHeartbeatProvisioningPolicy = Object.freeze({
    artifactPath: path.join(
        import.meta.dir,
        "provisioning",
        "openclaw-heartbeat",
        "HEARTBEAT.md"
    ),
    capabilities: Object.freeze(["cache:read", "monitoring:write"] as const),
    credentialFile: "openclaw-heartbeat.token",
    targetPath: "/home/ubuntu/.openclaw/workspace/HEARTBEAT.md",
});
