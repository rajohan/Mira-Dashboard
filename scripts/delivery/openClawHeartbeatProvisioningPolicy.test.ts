import { expect, test } from "bun:test";

import {
    openClawHeartbeatProvisioningPolicy,
    openClawHeartbeatProvisioningReleaseArtifactPaths,
} from "./openClawHeartbeatProvisioningPolicy.ts";

test("stages the concise heartbeat-v5 prompt without changing external authority", async () => {
    const artifact = await Bun.file(
        openClawHeartbeatProvisioningPolicy.artifactPath
    ).text();

    expect(openClawHeartbeatProvisioningPolicy).toMatchObject({
        agentId: "ops",
        capabilities: ["cache:read", "monitoring:write"],
        credentialFormat: "greenfield-opaque-token-v1",
        credentialFile: "openclaw-heartbeat.token",
        legacyCredentialReuse: false,
        principalId: "openclaw-heartbeat",
        promptConfigPath: "agents.entries.ops.heartbeat.prompt",
    });
    expect("targetPath" in openClawHeartbeatProvisioningPolicy).toBe(false);
    expect(artifact).not.toContain("/workspace/HEARTBEAT.md");
    expect(openClawHeartbeatProvisioningReleaseArtifactPaths).toEqual([
        "scripts/delivery/provisioning/openclaw-heartbeat/HEARTBEAT.md",
    ]);
    expect(artifact).toContain("schemaVersion: 5");
    expect(artifact).toContain("server/openClawHeartbeat.js collect");
    expect(artifact).toContain("server/openClawHeartbeat.js report");
    expect(artifact).toContain("exactly two shell executions");
    expect(artifact).toContain("retry call");
    expect(artifact).not.toContain("/api/cache/heartbeat");
    expect(artifact).not.toContain("/api/reports");
});
