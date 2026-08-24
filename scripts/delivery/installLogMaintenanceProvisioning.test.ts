import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    chown,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import {
    parseInstallLogMaintenanceProvisioningArguments,
    runInstallLogMaintenanceProvisioningCli,
} from "./provisioning/log-maintenance/installLogMaintenanceProvisioning.ts";
import {
    logMaintenanceProvisioningArtifacts,
    logMaintenanceProvisioningReleaseArtifactPaths,
} from "./provisioning/log-maintenance/policy.ts";

const releaseId = "a".repeat(40);
const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];
const currentUserId = typeof process.getuid === "function" ? process.getuid() : -1;
const currentGroupId = typeof process.getgid === "function" ? process.getgid() : -1;
const supplementaryGroupId =
    typeof process.getgroups === "function"
        ? process.getgroups().find((groupId) => groupId !== currentGroupId)
        : undefined;

afterEach(async () => {
    for (const temporaryRoot of temporaryRoots.splice(0)) {
        await makeWritable(temporaryRoot);
        await rm(temporaryRoot, { force: true, recursive: true });
    }
});

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function makeWritable(entryPath: string): Promise<void> {
    const status = await lstat(entryPath);
    if (!status.isDirectory() || status.isSymbolicLink()) return;
    await chmod(entryPath, 0o700);
    for (const entry of await readdir(entryPath, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await makeWritable(path.join(entryPath, entry.name));
        }
    }
}

async function releaseFixture(): Promise<string> {
    const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-log-maintenance-release-")
    );
    temporaryRoots.push(temporaryRoot);
    const releaseRoot = path.join(temporaryRoot, releaseId);
    const source = path.join(
        sourceProjectRoot,
        "scripts/delivery/provisioning/log-maintenance"
    );
    const destination = path.join(
        releaseRoot,
        "scripts/delivery/provisioning/log-maintenance"
    );
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true });
    const artifacts = [];
    for (const artifactPath of logMaintenanceProvisioningReleaseArtifactPaths) {
        const bytes = await readFile(path.join(releaseRoot, artifactPath));
        artifacts.push({
            bytes: bytes.byteLength,
            path: artifactPath,
            sha256: sha256(bytes),
        });
        await chmod(path.join(releaseRoot, artifactPath), 0o400);
    }
    await writeFile(
        path.join(releaseRoot, "release-manifest.json"),
        `${JSON.stringify({
            artifacts,
            formatVersion: 1,
            source: { commitSha: releaseId, treeState: "clean" },
        })}\n`,
        { mode: 0o400 }
    );
    for (const directory of [
        "scripts/delivery/provisioning/log-maintenance",
        "scripts/delivery/provisioning",
        "scripts/delivery",
        "scripts",
        "",
    ]) {
        await chmod(path.join(releaseRoot, directory), 0o500);
    }
    return releaseRoot;
}

async function destinationFixture(
    options: Readonly<{ readonly includeLibexec?: boolean }> = {}
): Promise<string> {
    const destinationRoot = await mkdtemp(
        path.join(tmpdir(), "mira-log-maintenance-destination-")
    );
    temporaryRoots.push(destinationRoot);
    await chmod(destinationRoot, 0o700);
    const directories = ["etc/polkit-1/rules.d", "etc/systemd/system"];
    if (options.includeLibexec === false) directories.push("usr/local");
    else directories.push("usr/local/libexec");
    for (const directory of directories) {
        await mkdir(path.join(destinationRoot, directory), {
            mode: 0o755,
            recursive: true,
        });
    }
    return destinationRoot;
}

function argumentsFor(releaseRoot: string): readonly string[] {
    return [`--release-root=${releaseRoot}`, `--release-id=${releaseId}`];
}

describe("root log-maintenance provisioning installer", () => {
    test("accepts a root-owned non-writable policy directory with a service group", async () => {
        if (supplementaryGroupId === undefined) return;
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const rulesDirectory = path.join(destinationRoot, "etc/polkit-1/rules.d");
        await chown(rulesDirectory, currentUserId, supplementaryGroupId);
        await chmod(rulesDirectory, 0o750);

        expect(
            await runInstallLogMaintenanceProvisioningCli(argumentsFor(releaseRoot), {
                destinationRoot,
                requireRoot: () => {},
            })
        ).toEqual({ releaseId, status: "INSTALLED" });
    });

    test("installs exact manifest bytes atomically without activating host policy", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const hooks = { destinationRoot, requireRoot: () => {} };

        expect(
            await runInstallLogMaintenanceProvisioningCli(
                argumentsFor(releaseRoot),
                hooks
            )
        ).toEqual({ releaseId, status: "INSTALLED" });
        await runInstallLogMaintenanceProvisioningCli(argumentsFor(releaseRoot), hooks);

        for (const artifact of logMaintenanceProvisioningArtifacts) {
            const installedPath = path.join(
                destinationRoot,
                artifact.destinationPath.slice(1)
            );
            expect(await readFile(installedPath)).toEqual(
                await readFile(path.join(releaseRoot, artifact.artifactPath))
            );
            const status = await lstat(installedPath);
            expect(status.isFile()).toBe(true);
            expect(status.isSymbolicLink()).toBe(false);
            expect(status.nlink).toBe(1);
            expect(status.mode & 0o7777).toBe(artifact.mode);
            expect(status.uid).toBe(
                typeof process.getuid === "function" ? process.getuid() : -1
            );
            expect(status.gid).toBe(
                typeof process.getgid === "function" ? process.getgid() : -1
            );
        }
    });

    test("creates and validates the reviewed libexec target on a fresh host", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture({ includeLibexec: false });
        const libexec = path.join(destinationRoot, "usr/local/libexec");

        expect(
            await runInstallLogMaintenanceProvisioningCli(argumentsFor(releaseRoot), {
                destinationRoot,
                requireRoot: () => {},
            })
        ).toEqual({ releaseId, status: "INSTALLED" });

        const status = await lstat(libexec);
        expect(status.isDirectory()).toBeTrue();
        expect(status.isSymbolicLink()).toBeFalse();
        expect(status.mode & 0o7777).toBe(0o755);
        expect(
            await readFile(path.join(libexec, "mira-dashboard-log-maintenance"))
        ).toEqual(
            await readFile(
                path.join(
                    releaseRoot,
                    "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance"
                )
            )
        );
    });

    test("preflights every existing destination before creating libexec", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture({ includeLibexec: false });
        const libexec = path.join(destinationRoot, "usr/local/libexec");
        await chmod(path.join(destinationRoot, "etc/systemd/system"), 0o777);

        const failure = await rejectionError(
            runInstallLogMaintenanceProvisioningCli(argumentsFor(releaseRoot), {
                destinationRoot,
                requireRoot: () => {},
            })
        );
        expect(failure.message).toBe("Log maintenance provisioning installation failed");
        const missing = await rejectionError(lstat(libexec));
        expect((missing as NodeJS.ErrnoException).code).toBe("ENOENT");
    });

    test("preflights a later existing target file before creating libexec", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture({ includeLibexec: false });
        const libexec = path.join(destinationRoot, "usr/local/libexec");
        const systemdTarget = path.join(
            destinationRoot,
            "etc/systemd/system/mira-dashboard-log-maintenance@.service"
        );
        await writeFile(systemdTarget, "unsafe", { mode: 0o600 });

        const failure = await rejectionError(
            runInstallLogMaintenanceProvisioningCli(argumentsFor(releaseRoot), {
                destinationRoot,
                requireRoot: () => {},
            })
        );
        expect(failure.message).toBe("Log maintenance provisioning installation failed");
        const missing = await rejectionError(lstat(libexec));
        expect((missing as NodeJS.ErrnoException).code).toBe("ENOENT");
    });

    test("fails before replacement for untrusted destinations and target swaps", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const arguments_ = argumentsFor(releaseRoot);
        const baseHooks = { destinationRoot, requireRoot: () => {} };
        await runInstallLogMaintenanceProvisioningCli(arguments_, baseHooks);

        const first = logMaintenanceProvisioningArtifacts[0];
        const firstTarget = path.join(destinationRoot, first.destinationPath.slice(1));
        const displaced = `${firstTarget}.displaced`;
        const swapFailure = await rejectionError(
            runInstallLogMaintenanceProvisioningCli(arguments_, {
                ...baseHooks,
                filesystem: {
                    async beforeRename(destinationPath) {
                        if (destinationPath !== first.destinationPath) return;
                        await rename(firstTarget, displaced);
                        await symlink(displaced, firstTarget);
                    },
                },
            })
        );
        expect(swapFailure.message).toBe(
            "Log maintenance provisioning installation failed"
        );

        await rm(firstTarget);
        await rename(displaced, firstTarget);
        await chmod(path.dirname(firstTarget), 0o777);
        const permissionFailure = await rejectionError(
            runInstallLogMaintenanceProvisioningCli(arguments_, baseHooks)
        );
        expect(permissionFailure.message).toBe(
            "Log maintenance provisioning installation failed"
        );
    });

    test("rejects changed release bytes, non-root execution, and extra arguments", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const arguments_ = argumentsFor(releaseRoot);
        const sourceArtifact = path.join(
            releaseRoot,
            logMaintenanceProvisioningArtifacts[0].artifactPath
        );
        await chmod(sourceArtifact, 0o600);
        await writeFile(sourceArtifact, "changed");
        await chmod(sourceArtifact, 0o400);

        const releaseFailure = await rejectionError(
            runInstallLogMaintenanceProvisioningCli(arguments_, {
                destinationRoot,
                requireRoot: () => {},
            })
        );
        expect(releaseFailure.message).toBe(
            "Log maintenance provisioning installation failed"
        );

        const rootFailure = await rejectionError(
            runInstallLogMaintenanceProvisioningCli(arguments_, {
                requireRoot: () => {
                    throw new Error("not root");
                },
            })
        );
        expect(rootFailure.message).toBe(
            "Log maintenance provisioning installation failed"
        );
        expect(() =>
            parseInstallLogMaintenanceProvisioningArguments([
                ...arguments_,
                "--destination-root=/tmp",
            ])
        ).toThrow(
            "Usage: bun installLogMaintenanceProvisioning.ts --release-root=/absolute/release/<40-hex> --release-id=<40-hex>"
        );
    });
});
