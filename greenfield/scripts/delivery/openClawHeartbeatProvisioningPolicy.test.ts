import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
    openClawHeartbeatProvisioningPolicy,
    openClawHeartbeatProvisioningReleaseArtifactPaths,
} from "./openClawHeartbeatProvisioningPolicy.ts";

test("stages the exact heartbeat-v5 prompt metadata without changing external authority", async () => {
    const artifact = await readFile(openClawHeartbeatProvisioningPolicy.artifactPath, {
        encoding: "utf8",
    });

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
    expect(artifact).toContain("agents.entries.ops.heartbeat.prompt");
    expect(openClawHeartbeatProvisioningReleaseArtifactPaths).toEqual([
        "scripts/delivery/provisioning/openclaw-heartbeat/HEARTBEAT.md",
    ]);
    expect(artifact).toContain("Dashboard heartbeat v5 prompt");
    expect(artifact).toContain("schemaVersion: 5");
    expect(artifact).toContain("server/openClawHeartbeat.js collect");
    expect(artifact).toContain("server/openClawHeartbeat.js report");
    expect(artifact).toContain("exactly two shell executions");
    expect(artifact).toContain("Never retry");
    expect(artifact).not.toContain("/api/cache/heartbeat");
    expect(artifact).not.toContain("/api/reports");
});
