import { describe, expect, test } from "bun:test";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
    logMaintenanceProvisioningArtifacts,
    logMaintenanceProvisioningReleaseArtifactPaths,
    logMaintenanceProvisioningSourceArtifactPaths,
} from "./logMaintenanceProvisioningPolicy.ts";

const sourceRoot = path.join(import.meta.dir, "provisioning/log-maintenance");

describe("log-maintenance provisioning artifact policy", () => {
    test("inventories every installable root-owned artifact", async () => {
        expect(logMaintenanceProvisioningArtifacts).toEqual([
            {
                artifactPath:
                    "scripts/delivery/provisioning/log-maintenance/60-mira-dashboard-log-maintenance.rules",
                destinationPath:
                    "/etc/polkit-1/rules.d/60-mira-dashboard-log-maintenance.rules",
                mode: 0o644,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance",
                destinationPath: "/usr/local/libexec/mira-dashboard-log-maintenance",
                mode: 0o755,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/log-maintenance/mira-dashboard-managed-log-access",
                destinationPath: "/usr/local/libexec/mira-dashboard-managed-log-access",
                mode: 0o755,
            },
            {
                artifactPath:
                    "systemd/log-maintenance/mira-dashboard-managed-log-access.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-managed-log-access.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/log-maintenance/mira-dashboard-log-maintenance@.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-log-maintenance@.service",
                mode: 0o644,
            },
        ]);
        const sourceEntries = await readdir(sourceRoot);
        expect(sourceEntries.toSorted()).toEqual([
            "60-mira-dashboard-log-maintenance.rules",
            "README.md",
            "installLogMaintenanceProvisioning.ts",
            "logMaintenanceProvisioningFilesystem.ts",
            "migrateManagedApplicationLogs.ts",
            "mira-dashboard-log-maintenance",
            "mira-dashboard-managed-log-access",
            "policy.ts",
            "provisionManagedLogAccess.ts",
        ]);
        expect(logMaintenanceProvisioningReleaseArtifactPaths).toEqual(
            sourceEntries
                .map(
                    (fileName) =>
                        `scripts/delivery/provisioning/log-maintenance/${fileName}`
                )
                .toSorted()
        );
        expect(logMaintenanceProvisioningSourceArtifactPaths).toEqual(
            [
                ...logMaintenanceProvisioningReleaseArtifactPaths,
                "systemd/log-maintenance/mira-dashboard-log-maintenance@.service",
                "systemd/log-maintenance/mira-dashboard-managed-log-access.service",
            ].toSorted()
        );
        for (const artifact of logMaintenanceProvisioningArtifacts) {
            const source = path.join(
                path.resolve(import.meta.dir, "../.."),
                artifact.artifactPath
            );
            const status = await lstat(source, { bigint: true });
            expect(status.isFile()).toBe(true);
            expect(status.isSymbolicLink()).toBe(false);
            expect(status.nlink).toBe(1n);
            expect(status.size).toBeGreaterThan(0n);
        }
    });
});
