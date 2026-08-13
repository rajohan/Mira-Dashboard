import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
    openClawHeartbeatProvisioningPolicy,
    openClawHeartbeatProvisioningReleaseArtifactPaths,
} from "./openClawHeartbeatProvisioningPolicy.ts";

test("stages the exact heartbeat-v5 cutover contract without changing live authority", async () => {
    const artifact = await readFile(openClawHeartbeatProvisioningPolicy.artifactPath, {
        encoding: "utf8",
    });

    expect(openClawHeartbeatProvisioningPolicy).toMatchObject({
        capabilities: ["cache:read", "monitoring:write"],
        credentialFile: "openclaw-heartbeat.token",
        targetPath: "/home/ubuntu/.openclaw/workspace/HEARTBEAT.md",
    });
    expect(openClawHeartbeatProvisioningReleaseArtifactPaths).toEqual([
        "scripts/delivery/provisioning/openclaw-heartbeat/HEARTBEAT.md",
    ]);
    expect(artifact).toContain("schemaVersion: 5");
    expect(artifact).toContain("server/openClawHeartbeat.js collect");
    expect(artifact).toContain("server/openClawHeartbeat.js report");
    expect(artifact).toContain("exactly two shell executions");
    expect(artifact).toContain("Never retry");
    expect(artifact).not.toContain("/api/cache/heartbeat");
    expect(artifact).not.toContain("/api/reports");
});
