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
    activateHostOperationsProvisioning,
    parseInstallHostOperationsProvisioningArguments,
    runInstallHostOperationsProvisioningCli,
} from "./provisioning/host-operations/installHostOperationsProvisioning.ts";
import {
    hostOperationsProvisioningArtifacts,
    hostOperationsProvisioningSourceArtifactPaths,
} from "./provisioning/host-operations/policy.ts";

const releaseId = "a".repeat(40);
const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];
const currentUserId = typeof process.getuid === "function" ? process.getuid() : -1;
const currentGroupId = typeof process.getgid === "function" ? process.getgid() : -1;
const supplementaryGroupId =
    typeof process.getgroups === "function"
        ? process.getgroups().find((groupId) => groupId !== currentGroupId)
        : undefined;
const fixtureSourceIdentity = Object.freeze({
    groupId: BigInt(currentGroupId),
    userId: BigInt(currentUserId),
});

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

async function changeOwnerRecursively(
    entryPath: string,
    userId: number,
    groupId: number
): Promise<void> {
    const status = await lstat(entryPath);
    if (status.isDirectory() && !status.isSymbolicLink()) {
        for (const entry of await readdir(entryPath, { withFileTypes: true })) {
            await changeOwnerRecursively(
                path.join(entryPath, entry.name),
                userId,
                groupId
            );
        }
    }
    await chown(entryPath, userId, groupId);
}

async function releaseFixture(
    options: Readonly<{
        readonly owner?: Readonly<{ readonly groupId: number; readonly userId: number }>;
    }> = {}
): Promise<string> {
    const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-host-operations-release-")
    );
    temporaryRoots.push(temporaryRoot);
    const releaseRoot = path.join(temporaryRoot, releaseId);
    const source = path.join(
        sourceProjectRoot,
        "scripts/delivery/provisioning/host-operations"
    );
    const destination = path.join(
        releaseRoot,
        "scripts/delivery/provisioning/host-operations"
    );
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true });
    await cp(path.join(sourceProjectRoot, "systemd"), path.join(releaseRoot, "systemd"), {
        recursive: true,
    });
    const artifacts = [];
    for (const artifactPath of hostOperationsProvisioningSourceArtifactPaths) {
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
        "scripts/delivery/provisioning/host-operations",
        "scripts/delivery/provisioning",
        "scripts/delivery",
        "scripts",
        "systemd",
        "",
    ]) {
        await chmod(path.join(releaseRoot, directory), 0o500);
    }
    if (
        options.owner !== undefined &&
        (options.owner.userId !== currentUserId ||
            options.owner.groupId !== currentGroupId)
    ) {
        await changeOwnerRecursively(
            releaseRoot,
            options.owner.userId,
            options.owner.groupId
        );
    }
    return releaseRoot;
}

async function runtimeBoundaryFixture(releaseRoot: string) {
    const trustRoot = await mkdtemp(path.join(tmpdir(), "mira-host-operations-runtime-"));
    temporaryRoots.push(trustRoot);
    const runtimeDirectory = path.join(trustRoot, "runtime");
    const executablePath = path.join(runtimeDirectory, "bun");
    await mkdir(runtimeDirectory, { mode: 0o700 });
    await writeFile(executablePath, "fixed test runtime", { mode: 0o555 });
    await chmod(executablePath, 0o555);
    await chmod(runtimeDirectory, 0o500);
    await chmod(trustRoot, 0o500);
    const entrypointPath = path.join(
        releaseRoot,
        "scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts"
    );
    return Object.freeze({
        actualExecutablePath: executablePath,
        actualEntrypointPath: entrypointPath,
        expectedEntrypointPath: entrypointPath,
        expectedExecutablePath: executablePath,
        ...fixtureSourceIdentity,
        trustRoot,
    });
}

async function installerTestHooks(
    releaseRoot: string,
    destinationRoot?: string,
    options: Readonly<{ readonly admitFixtureSource?: boolean }> = {}
) {
    return {
        ...(destinationRoot === undefined ? {} : { destinationRoot }),
        ...(options.admitFixtureSource === false
            ? {}
            : { expectedSourceIdentity: fixtureSourceIdentity }),
        requireRoot: () => {},
        runtimeBoundary: await runtimeBoundaryFixture(releaseRoot),
    };
}

async function destinationFixture(
    options: Readonly<{
        readonly includeLibexec?: boolean;
        readonly includeSysusers?: boolean;
    }> = {}
): Promise<string> {
    const destinationRoot = await mkdtemp(
        path.join(tmpdir(), "mira-host-operations-destination-")
    );
    temporaryRoots.push(destinationRoot);
    await chmod(destinationRoot, 0o700);
    const directories = ["etc/polkit-1/rules.d", "etc/systemd/system"];
    if (options.includeSysusers === false) directories.push("etc");
    else directories.push("etc/sysusers.d");
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

async function argumentsFor(releaseRoot: string): Promise<readonly string[]> {
    const manifestBytes = await readFile(path.join(releaseRoot, "release-manifest.json"));
    return [
        `--release-root=${releaseRoot}`,
        `--release-id=${releaseId}`,
        `--release-manifest-sha256=${sha256(manifestBytes)}`,
    ];
}

describe("root host-operations provisioning installer", () => {
    test("activates only fixed sysusers and root-systemd topology commands", async () => {
        const commands: Array<readonly [string, readonly string[]]> = [];
        await activateHostOperationsProvisioning((executable, arguments_) => {
            commands.push([executable, [...arguments_]]);
            return Promise.resolve({
                exitCode: 0,
                stderr: new Uint8Array(),
                stdout: new Uint8Array(),
            });
        });

        expect(commands).toEqual([
            [
                "/usr/bin/systemd-sysusers",
                ["/etc/sysusers.d/mira-dashboard-production-authority.conf"],
            ],
            ["/usr/bin/systemctl", ["daemon-reload"]],
            [
                "/usr/bin/systemctl",
                ["enable", "mira-dashboard-worker.service", "mira-dashboard-web.service"],
            ],
        ]);
        const failure = await rejectionError(
            activateHostOperationsProvisioning(() =>
                Promise.resolve({
                    exitCode: 1,
                    stderr: new Uint8Array(),
                    stdout: new Uint8Array(),
                })
            )
        );
        expect(failure.message).toBe("Host operations provisioning installation failed");
    });

    test("installs exact manifest bytes atomically without activating host policy", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);

        expect(
            await runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                hooks
            )
        ).toEqual({ releaseId, status: "INSTALLED" });
        await runInstallHostOperationsProvisioningCli(
            await argumentsFor(releaseRoot),
            hooks
        );

        for (const artifact of hostOperationsProvisioningArtifacts) {
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

    test("accepts a root-owned non-writable system directory with a service group", async () => {
        if (supplementaryGroupId === undefined) return;
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const rulesDirectory = path.join(destinationRoot, "etc/polkit-1/rules.d");
        await chown(rulesDirectory, currentUserId, supplementaryGroupId);
        await chmod(rulesDirectory, 0o750);

        expect(
            await runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                await installerTestHooks(releaseRoot, destinationRoot)
            )
        ).toEqual({ releaseId, status: "INSTALLED" });
    });

    test("creates and validates reviewed target directories on a fresh host", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture({
            includeLibexec: false,
            includeSysusers: false,
        });
        const libexec = path.join(destinationRoot, "usr/local/libexec");
        const sysusers = path.join(destinationRoot, "etc/sysusers.d");
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);

        expect(
            await runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                hooks
            )
        ).toEqual({ releaseId, status: "INSTALLED" });

        for (const directory of [libexec, sysusers]) {
            const status = await lstat(directory);
            expect(status.isDirectory()).toBeTrue();
            expect(status.isSymbolicLink()).toBeFalse();
            expect(status.mode & 0o7777).toBe(0o755);
        }
        expect(
            await readFile(path.join(libexec, "mira-dashboard-host-operation"))
        ).toEqual(
            await readFile(
                path.join(
                    releaseRoot,
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-host-operation"
                )
            )
        );
    });

    test("restores exact immutable release bytes during an explicit rollback reinstall", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);
        const arguments_ = await argumentsFor(releaseRoot);
        await runInstallHostOperationsProvisioningCli(arguments_, hooks);

        const target = hostOperationsProvisioningArtifacts[1];
        const installedPath = path.join(destinationRoot, target.destinationPath.slice(1));
        await writeFile(installedPath, "superseded release bytes", {
            mode: target.mode,
        });

        expect(await runInstallHostOperationsProvisioningCli(arguments_, hooks)).toEqual({
            releaseId,
            status: "INSTALLED",
        });
        expect(await readFile(installedPath)).toEqual(
            await readFile(path.join(releaseRoot, target.artifactPath))
        );
    });

    test("preflights every existing destination before creating libexec", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture({ includeLibexec: false });
        const libexec = path.join(destinationRoot, "usr/local/libexec");
        await chmod(path.join(destinationRoot, "etc/systemd/system"), 0o777);
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);

        const failure = await rejectionError(
            runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                hooks
            )
        );
        expect(failure.message).toBe("Host operations provisioning installation failed");
        const missing = await rejectionError(lstat(libexec));
        expect((missing as NodeJS.ErrnoException).code).toBe("ENOENT");
    });

    test("preflights a later existing target file before creating libexec", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture({ includeLibexec: false });
        const libexec = path.join(destinationRoot, "usr/local/libexec");
        const systemdTarget = path.join(
            destinationRoot,
            "etc/systemd/system/mira-dashboard-host-system-update.service"
        );
        await writeFile(systemdTarget, "unsafe", { mode: 0o600 });
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);

        const failure = await rejectionError(
            runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                hooks
            )
        );
        expect(failure.message).toBe("Host operations provisioning installation failed");
        const missing = await rejectionError(lstat(libexec));
        expect((missing as NodeJS.ErrnoException).code).toBe("ENOENT");
    });

    test("fails before replacement for untrusted destinations and target swaps", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const arguments_ = await argumentsFor(releaseRoot);
        const baseHooks = await installerTestHooks(releaseRoot, destinationRoot);
        await runInstallHostOperationsProvisioningCli(arguments_, baseHooks);

        const first = hostOperationsProvisioningArtifacts[0];
        const firstTarget = path.join(destinationRoot, first.destinationPath.slice(1));
        const displaced = `${firstTarget}.displaced`;
        const swapFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(arguments_, {
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
            "Host operations provisioning installation failed"
        );

        await rm(firstTarget);
        await rename(displaced, firstTarget);
        await chmod(path.dirname(firstTarget), 0o777);
        const permissionFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(arguments_, baseHooks)
        );
        expect(permissionFailure.message).toBe(
            "Host operations provisioning installation failed"
        );
    });

    test("rejects changed release bytes, non-root execution, and extra arguments", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const arguments_ = await argumentsFor(releaseRoot);
        const sourceArtifact = path.join(
            releaseRoot,
            hostOperationsProvisioningArtifacts[0].artifactPath
        );
        await chmod(sourceArtifact, 0o600);
        await writeFile(sourceArtifact, "changed");
        await chmod(sourceArtifact, 0o400);
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);

        const releaseFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(arguments_, hooks)
        );
        expect(releaseFailure.message).toBe(
            "Host operations provisioning installation failed"
        );

        const rootFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(arguments_, {
                ...(await installerTestHooks(releaseRoot)),
                requireRoot: () => {
                    throw new Error("not root");
                },
            })
        );
        expect(rootFailure.message).toBe(
            "Host operations provisioning installation failed"
        );
        expect(() =>
            parseInstallHostOperationsProvisioningArguments([
                ...arguments_,
                "--destination-root=/tmp",
            ])
        ).toThrow(
            "Usage: bun installHostOperationsProvisioning.ts --release-root=/absolute/release/<40-hex> --release-id=<40-hex> --release-manifest-sha256=<64-hex>"
        );
    });

    test("requires one externally supplied exact manifest digest", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);
        const arguments_ = await argumentsFor(releaseRoot);
        const digestIndex = arguments_.findIndex((argument) =>
            argument.startsWith("--release-manifest-sha256=")
        );
        expect(digestIndex).toBeGreaterThanOrEqual(0);

        const wrongDigestArguments = [...arguments_];
        wrongDigestArguments[digestIndex] = `--release-manifest-sha256=${"f".repeat(64)}`;
        const failure = await rejectionError(
            runInstallHostOperationsProvisioningCli(wrongDigestArguments, hooks)
        );
        expect(failure.message).toBe("Host operations provisioning installation failed");

        expect(() =>
            parseInstallHostOperationsProvisioningArguments(
                arguments_.filter(
                    (argument) => !argument.startsWith("--release-manifest-sha256=")
                )
            )
        ).toThrow(
            "Usage: bun installHostOperationsProvisioning.ts --release-root=/absolute/release/<40-hex> --release-id=<40-hex> --release-manifest-sha256=<64-hex>"
        );
    });

    test("rejects an internally consistent release not owned by root", async () => {
        const nonRootOwner =
            currentUserId === 0 && currentGroupId === 0
                ? { groupId: 65_534, userId: 65_534 }
                : { groupId: currentGroupId, userId: currentUserId };
        const releaseRoot = await releaseFixture({ owner: nonRootOwner });
        const destinationRoot = await destinationFixture();
        const releaseStatus = await lstat(releaseRoot);
        const hooks = await installerTestHooks(releaseRoot, destinationRoot, {
            admitFixtureSource: false,
        });
        expect([releaseStatus.uid, releaseStatus.gid]).not.toEqual([0, 0]);

        const failure = await rejectionError(
            runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                hooks
            )
        );
        expect(failure.message).toBe("Host operations provisioning installation failed");
    });

    test("rejects a writable or unexpected provisioning runtime and entrypoint", async () => {
        const releaseRoot = await releaseFixture();
        const destinationRoot = await destinationFixture();
        const hooks = await installerTestHooks(releaseRoot, destinationRoot);
        await chmod(hooks.runtimeBoundary.expectedExecutablePath, 0o755);

        const writableFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                hooks
            )
        );
        expect(writableFailure.message).toBe(
            "Host operations provisioning installation failed"
        );

        await chmod(hooks.runtimeBoundary.expectedExecutablePath, 0o555);
        const unexpectedFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(await argumentsFor(releaseRoot), {
                ...hooks,
                runtimeBoundary: {
                    ...hooks.runtimeBoundary,
                    actualExecutablePath: `${hooks.runtimeBoundary.actualExecutablePath}.other`,
                },
            })
        );
        expect(unexpectedFailure.message).toBe(
            "Host operations provisioning installation failed"
        );

        const entrypointFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(await argumentsFor(releaseRoot), {
                ...hooks,
                runtimeBoundary: {
                    ...hooks.runtimeBoundary,
                    actualEntrypointPath: path.join(
                        releaseRoot,
                        "scripts/delivery/provisioning/host-operations/policy.ts"
                    ),
                },
            })
        );
        expect(entrypointFailure.message).toBe(
            "Host operations provisioning installation failed"
        );

        await chmod(hooks.runtimeBoundary.trustRoot, 0o520);
        const ancestorFailure = await rejectionError(
            runInstallHostOperationsProvisioningCli(
                await argumentsFor(releaseRoot),
                hooks
            )
        );
        expect(ancestorFailure.message).toBe(
            "Host operations provisioning installation failed"
        );
    });
});
