import path from "node:path";

export const openClawHeartbeatProvisioningReleaseArtifactPaths = Object.freeze([
    "scripts/delivery/provisioning/openclaw-heartbeat/HEARTBEAT.md",
] as const);

export const openClawHeartbeatProvisioningPolicy = Object.freeze({
    agentId: "ops",
    artifactPath: path.join(
        import.meta.dir,
        "provisioning",
        "openclaw-heartbeat",
        "HEARTBEAT.md"
    ),
    capabilities: Object.freeze(["cache:read", "monitoring:write"] as const),
    credentialFormat: "greenfield-opaque-token-v1",
    credentialFile: "openclaw-heartbeat.token",
    legacyCredentialReuse: false,
    principalId: "openclaw-heartbeat",
    promptConfigPath: "agents.entries.ops.heartbeat.prompt",
});
