import { describe, expect, test } from "bun:test";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
    hostOperationsProvisioningArtifacts,
    hostOperationsProvisioningReleaseArtifactPaths,
} from "./hostOperationsProvisioningPolicy.ts";

const sourceRoot = path.join(import.meta.dir, "provisioning/host-operations");

describe("host-operations provisioning artifact policy", () => {
    test("inventories the seven exact root-owned artifacts and all installer support", async () => {
        expect(hostOperationsProvisioningArtifacts).toEqual([
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/60-mira-dashboard-host-operations.rules",
                destinationPath:
                    "/etc/polkit-1/rules.d/60-mira-dashboard-host-operations.rules",
                mode: 0o644,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-host-operation",
                destinationPath: "/usr/local/libexec/mira-dashboard-host-operation",
                mode: 0o755,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-deferred-reboot.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-reboot.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-deferred-reboot.timer",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-reboot.timer",
                mode: 0o644,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-host-system-cleanup.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-host-system-cleanup.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-host-system-restart.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-host-system-restart.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-host-system-update.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-host-system-update.service",
                mode: 0o644,
            },
        ]);
        const sourceFiles = await readdir(sourceRoot);
        const sourceEntries = sourceFiles.toSorted();
        expect(sourceEntries).toEqual([
            "60-mira-dashboard-host-operations.rules",
            "README.md",
            "hostOperationsProvisioningFilesystem.ts",
            "installHostOperationsProvisioning.ts",
            "mira-dashboard-deferred-reboot.service",
            "mira-dashboard-deferred-reboot.timer",
            "mira-dashboard-host-operation",
            "mira-dashboard-host-system-cleanup.service",
            "mira-dashboard-host-system-restart.service",
            "mira-dashboard-host-system-update.service",
            "policy.ts",
        ]);
        expect(hostOperationsProvisioningReleaseArtifactPaths).toEqual(
            sourceEntries.map(
                (fileName) => `scripts/delivery/provisioning/host-operations/${fileName}`
            )
        );
        for (const artifact of hostOperationsProvisioningArtifacts) {
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

    test("does not expose the root installer through an application-owned package script", async () => {
        const packageJson = JSON.parse(
            await readFile(path.resolve(import.meta.dir, "../../package.json"), "utf8")
        ) as { readonly scripts?: Readonly<Record<string, string>> };

        expect(packageJson.scripts).not.toHaveProperty(
            "delivery:install-host-operations"
        );
    });
});
