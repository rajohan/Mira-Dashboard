import { describe, expect, test } from "bun:test";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
    logMaintenanceProvisioningArtifacts,
    logMaintenanceProvisioningReleaseArtifactPaths,
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
                    "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance@.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-log-maintenance@.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/log-maintenance/mira-dashboard-managed-container-logs.conf",
                destinationPath:
                    "/usr/lib/tmpfiles.d/mira-dashboard-managed-container-logs.conf",
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
            "mira-dashboard-log-maintenance@.service",
            "mira-dashboard-managed-container-logs.conf",
            "policy.ts",
        ]);
        expect(logMaintenanceProvisioningReleaseArtifactPaths).toEqual(
            sourceEntries
                .map(
                    (fileName) =>
                        `scripts/delivery/provisioning/log-maintenance/${fileName}`
                )
                .toSorted()
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

    test("declares exact container owners and maintenance-group access", async () => {
        const configuration = await readFile(
            path.join(sourceRoot, "mira-dashboard-managed-container-logs.conf"),
            "utf8"
        );
        expect(configuration.trim().split("\n")).toEqual([
            "# Type Path Mode User Group Age Argument",
            "d /opt/docker/data/prowlarr/logs 2770 1001 mira-dashboard-log-maintenance - -",
            "a /opt/docker/data/prowlarr/logs - - - - d:group:mira-dashboard-log-maintenance:rwx,d:mask::rwx",
            "f /opt/docker/data/prowlarr/logs/prowlarr.debug.txt 0660 1001 mira-dashboard-log-maintenance - -",
            "f /opt/docker/data/prowlarr/logs/prowlarr.trace.txt 0660 1001 mira-dashboard-log-maintenance - -",
            "f /opt/docker/data/prowlarr/logs/prowlarr.txt 0660 1001 mira-dashboard-log-maintenance - -",
            "d /opt/docker/data/submaker/logs 2770 1001 mira-dashboard-log-maintenance - -",
            "a /opt/docker/data/submaker/logs - - - - user:1000:rwx,d:user:1000:rwx,d:group:mira-dashboard-log-maintenance:rwx,d:mask::rwx",
            "f /opt/docker/data/submaker/logs/app.log 0660 1000 mira-dashboard-log-maintenance - -",
            "d /opt/docker/data/traefik 2770 1001 mira-dashboard-log-maintenance - -",
            "a /opt/docker/data/traefik - - - - d:group:mira-dashboard-log-maintenance:rwx,d:mask::rwx",
            "f /opt/docker/data/traefik/access.log 0660 1001 mira-dashboard-log-maintenance - -",
        ]);
    });
});
