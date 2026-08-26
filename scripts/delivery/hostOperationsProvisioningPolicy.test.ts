import { describe, expect, test } from "bun:test";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
    hostOperationsProvisioningArtifacts,
    hostOperationsProvisioningReleaseArtifactPaths,
    hostOperationsProvisioningSourceArtifactPaths,
} from "./hostOperationsProvisioningPolicy.ts";

const sourceRoot = path.join(import.meta.dir, "provisioning/host-operations");
const systemdRoot = path.resolve(import.meta.dir, "../../systemd/host-operations");

describe("host-operations provisioning artifact policy", () => {
    test("injects only the ordinary GitHub credential into release provisioning", async () => {
        const [unit, launcher] = await Promise.all([
            readFile(path.join(systemdRoot, "mira-p@.service"), "utf8"),
            readFile(
                path.join(sourceRoot, "mira-dashboard-production-provisioning"),
                "utf8"
            ),
        ]);

        expect(unit).toContain(
            "ExecStart=/usr/local/libexec/mira-dashboard-production-provisioning %i"
        );
        expect(unit).not.toContain("doppler");
        expect(launcher).toContain("--no-read-env");
        expect(launcher).toContain("--only-secrets=MIRA_GITHUB_TOKEN");
        expect(launcher).toContain("--config-dir=/home/ubuntu/.doppler");
        expect(launcher).toContain('"--authority=$authority"');
        expect(launcher).toContain("*--local|*--local--settled)");
        expect(launcher).toContain(
            "/usr/bin/env --chdir=/var/lib/mira-dashboard-host-provisioning/current"
        );
        expect(launcher).toContain("./bun ./productionProvisioning.js");
        expect(launcher).not.toContain(
            "/var/lib/mira-dashboard-host-provisioning/runtime/bun"
        );
        expect(launcher).not.toContain(
            "/usr/local/libexec/mira-dashboard-production-provisioning.js"
        );
        expect(launcher).not.toContain("RAJOHAN_GITHUB_TOKEN");
        expect(launcher.indexOf("*--local|*--local--settled)")).toBeLessThan(
            launcher.indexOf("/usr/local/bin/doppler run")
        );
    });

    test("inventories the exact root-owned authority artifacts and installer support", async () => {
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
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-production-authority.conf",
                destinationPath:
                    "/etc/sysusers.d/mira-dashboard-production-authority.conf",
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
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-production-provisioning",
                destinationPath:
                    "/usr/local/libexec/mira-dashboard-production-provisioning",
                mode: 0o755,
            },
            {
                artifactPath:
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-web-runtime",
                destinationPath: "/usr/local/libexec/mira-dashboard-web-runtime",
                mode: 0o755,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-deferred-stack-restart.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-stack-restart.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-deferred-stack-restart.timer",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-stack-restart.timer",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-deferred-worker-restart.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-worker-restart.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-deferred-worker-restart.timer",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-worker-restart.timer",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-deferred-reboot.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-reboot.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-deferred-reboot.timer",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-deferred-reboot.timer",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-host-system-cleanup.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-host-system-cleanup.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-host-system-restart.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-host-system-restart.service",
                mode: 0o644,
            },
            {
                artifactPath:
                    "systemd/host-operations/mira-dashboard-host-system-update.service",
                destinationPath:
                    "/etc/systemd/system/mira-dashboard-host-system-update.service",
                mode: 0o644,
            },
            {
                artifactPath: "systemd/host-operations/mira-p@.service",
                destinationPath: "/etc/systemd/system/mira-p@.service",
                mode: 0o644,
            },
            {
                artifactPath: "systemd/mira-dashboard-web.service",
                destinationPath: "/etc/systemd/system/mira-dashboard-web.service",
                mode: 0o644,
            },
            {
                artifactPath: "systemd/mira-dashboard-worker.service",
                destinationPath: "/etc/systemd/system/mira-dashboard-worker.service",
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
            "mira-dashboard-host-operation",
            "mira-dashboard-production-authority.conf",
            "mira-dashboard-production-provisioning",
            "mira-dashboard-web-runtime",
            "policy.ts",
        ]);
        expect(hostOperationsProvisioningReleaseArtifactPaths).toEqual(
            sourceEntries
                .map(
                    (fileName) =>
                        `scripts/delivery/provisioning/host-operations/${fileName}`
                )
                .toSorted()
        );
        expect(hostOperationsProvisioningSourceArtifactPaths).toEqual(
            [
                ...new Set([
                    ...hostOperationsProvisioningReleaseArtifactPaths,
                    ...hostOperationsProvisioningArtifacts.map(
                        ({ artifactPath }) => artifactPath
                    ),
                ]),
            ].toSorted()
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
