import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    createLocalReleaseFixture,
    removeProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    installPublishedProductionSystemdUnits,
    parseInstallProductionSystemdUnitsArguments,
} from "./installProductionSystemdUnits.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { publishProductionRelease } from "./productionReleasePublication.ts";
import { installProductionRuntime } from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";
import type { SystemctlProcessResult } from "./systemctlProcess.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const releaseId = "a".repeat(40);
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "b".repeat(40),
    version: "1.4.0",
});
const releaseFixtureDirectories: string[] = [];
const temporaryDirectories: string[] = [];
const installationLifecycleTestTimeoutMs = 15_000;
let sharedSourceRelease: string | undefined;

beforeAll(async () => {
    sharedSourceRelease = await createLocalReleaseFixture(
        sourceProjectRoot,
        releaseId,
        runtimeIdentity,
        releaseFixtureDirectories
    );
});

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

afterAll(async () => {
    await removeProductionDeliveryFixtures(releaseFixtureDirectories);
});

function sourceReleaseFixture(): string {
    if (sharedSourceRelease === undefined) {
        throw new Error("Production release fixture is not initialized");
    }
    return sharedSourceRelease;
}

function successfulSystemctl(): SystemctlProcessResult {
    return Object.freeze({
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
    });
}

async function installationFixture() {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "mira-systemd-home-"));
    temporaryDirectories.push(homeDirectory);
    const projectRoot = path.join(homeDirectory, "projects/mira-dashboard");
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    const sourceRelease = sourceReleaseFixture();
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "mira-systemd-runtime-"));
    temporaryDirectories.push(runtimeRoot);
    const runtimeSource = path.join(runtimeRoot, "bun");
    await writeFile(runtimeSource, "test-bun-runtime", { mode: 0o500 });
    const state = await prepareProtectedProductionStatePath(projectRoot);
    const userUnitDirectory = path.join(homeDirectory, ".config/systemd/user");
    return {
        homeDirectory,
        projectRoot,
        runtimeSource,
        sourceRelease,
        state,
        userUnitDirectory,
    };
}

describe("production systemd unit installation", () => {
    test(
        "installs only manifest units atomically and reloads without service mutation",
        async () => {
            const fixture = await installationFixture();
            const commands: string[][] = [];
            await withDeploymentLease(fixture.state.stateDirectory, async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(fixture.state);
                const runtime = await installProductionRuntime(
                    lease,
                    paths,
                    runtimeIdentity,
                    {
                        probeRuntime: () => Promise.resolve(runtimeIdentity),
                        sourceExecutable: fixture.runtimeSource,
                    }
                );
                const release = await publishProductionRelease(
                    lease,
                    paths,
                    fixture.sourceRelease,
                    runtime.identity
                );
                const execute = (_executable: string, arguments_: readonly string[]) => {
                    commands.push([...arguments_]);
                    return Promise.resolve(successfulSystemctl());
                };
                const dependencies = {
                    execute,
                    homeDirectory: fixture.homeDirectory,
                    userUnitDirectory: fixture.userUnitDirectory,
                };

                await installPublishedProductionSystemdUnits(
                    lease,
                    paths,
                    release,
                    dependencies
                );
                await installPublishedProductionSystemdUnits(
                    lease,
                    paths,
                    release,
                    dependencies
                );
                const reloadFailure = await rejectionError(
                    installPublishedProductionSystemdUnits(lease, paths, release, {
                        ...dependencies,
                        execute: (_executable, arguments_) => {
                            commands.push([...arguments_]);
                            return Promise.resolve({
                                exitCode: 1,
                                stderr: new Uint8Array(),
                                stdout: new Uint8Array(),
                            });
                        },
                    })
                );
                expect(reloadFailure.message).toBe(
                    "Production systemd unit installation failed"
                );

                for (const fileName of [
                    "mira-dashboard-web.service",
                    "mira-dashboard-worker.service",
                ]) {
                    const installedPath = path.join(fixture.userUnitDirectory, fileName);
                    const sourcePath = path.join(
                        release.releaseRoot,
                        "systemd",
                        fileName
                    );
                    expect(await readFile(installedPath)).toEqual(
                        await readFile(sourcePath)
                    );
                    const installedStatus = await stat(installedPath);
                    expect(installedStatus.mode & 0o7777).toBe(0o600);
                    expect(installedStatus.nlink).toBe(1);
                }
            });

            expect(commands).toEqual([
                ["--user", "daemon-reload"],
                ["--user", "daemon-reload"],
                ["--user", "daemon-reload"],
            ]);
            expect(commands.flat()).not.toContain("start");
            expect(commands.flat()).not.toContain("restart");
            expect(commands.flat()).not.toContain("enable");
        },
        installationLifecycleTestTimeoutMs
    );

    test("rejects an untrusted destination and a destination identity swap", async () => {
        const fixture = await installationFixture();
        await withDeploymentLease(fixture.state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(fixture.state);
            const runtime = await installProductionRuntime(
                lease,
                paths,
                runtimeIdentity,
                {
                    probeRuntime: () => Promise.resolve(runtimeIdentity),
                    sourceExecutable: fixture.runtimeSource,
                }
            );
            const release = await publishProductionRelease(
                lease,
                paths,
                fixture.sourceRelease,
                runtime.identity
            );
            const dependencies = {
                execute: () => Promise.resolve(successfulSystemctl()),
                homeDirectory: fixture.homeDirectory,
                userUnitDirectory: fixture.userUnitDirectory,
            };
            await installPublishedProductionSystemdUnits(
                lease,
                paths,
                release,
                dependencies
            );
            const webUnit = path.join(
                fixture.userUnitDirectory,
                "mira-dashboard-web.service"
            );
            const displaced = `${webUnit}.displaced`;
            const swapFailure = await rejectionError(
                installPublishedProductionSystemdUnits(lease, paths, release, {
                    ...dependencies,
                    filesystemTestHooks: {
                        async beforeRename(fileName) {
                            if (fileName !== "mira-dashboard-web.service") return;
                            await rename(webUnit, displaced);
                            await symlink(displaced, webUnit);
                        },
                    },
                })
            );
            expect(swapFailure.message).toBe(
                "Production systemd unit installation failed"
            );

            await chmod(fixture.userUnitDirectory, 0o733);
            const permissionFailure = await rejectionError(
                installPublishedProductionSystemdUnits(
                    lease,
                    paths,
                    release,
                    dependencies
                )
            );
            expect(permissionFailure.message).toBe(
                "Production systemd unit installation failed"
            );
        });
    });

    test("parses only the exact project, release, runtime, and user-unit arguments", () => {
        const homeDirectory = "/home/dashboard";
        const projectRoot = `${homeDirectory}/projects/mira-dashboard`;
        const userUnitDirectory = `${homeDirectory}/.config/systemd/user`;
        expect(
            parseInstallProductionSystemdUnitsArguments([
                `--project-root=${projectRoot}`,
                `--release-id=${releaseId}`,
                `--runtime-revision=${runtimeIdentity.revision}`,
                `--user-unit-directory=${userUnitDirectory}`,
            ])
        ).toEqual({
            projectRoot,
            releaseId,
            runtimeRevision: runtimeIdentity.revision,
            userUnitDirectory,
        });
        expect(() =>
            parseInstallProductionSystemdUnitsArguments([
                `--project-root=${projectRoot}`,
                `--release-id=${releaseId}`,
                `--release-id=${releaseId}`,
                `--user-unit-directory=${userUnitDirectory}`,
            ])
        ).toThrow("Usage:");
    });
});
