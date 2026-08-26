import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    readdir,
    readFile,
    readlink,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

import { configurationEnvironmentNamesForRole } from "../../src/shared/configuration/applicationConfigurationRegistry.ts";
import type { PublishedReleaseAuthority } from "../../src/shared/publishedReleaseAuthority.ts";
import type { ReleaseManifest } from "../../src/shared/releaseManifest.ts";
import {
    createProductionTargetFixture,
    removeProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    prepareProductionDeliveryDirectories,
    type PreparedProductionDeliveryPaths,
} from "./productionDeliveryFilesystem.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";
import { pointProductionProcessesAtRelease } from "./productionRuntimePointers.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";
import {
    createSystemdProductionServiceController,
    type SystemctlProcessResult,
} from "./systemdProductionServices.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const firstReleaseId = "a".repeat(40);
const secondReleaseId = "b".repeat(40);
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "c".repeat(40),
    version: "1.4.0",
});
const temporaryDirectories: string[] = [];

function publishedAuthority(releaseId: string): PublishedReleaseAuthority {
    return {
        assets: [
            { digest: `sha256:${"d".repeat(64)}`, name: "receipt.json", size: 1 },
            { digest: `sha256:${"e".repeat(64)}`, name: "release.tar", size: 1 },
        ],
        releaseId,
        releaseManifestSha256: "f".repeat(64),
        runtime: runtimeIdentity,
        tagName: "v1.2.3",
    };
}

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

function releaseManifest(commitSha: string): ReleaseManifest {
    return {
        runtime: runtimeIdentity,
        source: { commitSha, treeState: "clean" },
    } as unknown as ReleaseManifest;
}

async function createRuntimePointerFixture(
    paths: PreparedProductionDeliveryPaths
): Promise<{
    readonly first: PublishedProductionRelease;
    readonly runtime: InstalledProductionRuntime;
    readonly second: PublishedProductionRelease;
}> {
    const bunRoot = path.join(paths.runtimesDirectory, "bun");
    const firstReleaseRoot = path.join(paths.releasesDirectory, firstReleaseId);
    const secondReleaseRoot = path.join(paths.releasesDirectory, secondReleaseId);
    const runtimeRoot = path.join(bunRoot, runtimeIdentity.revision);
    const runtimeExecutable = path.join(runtimeRoot, "bun");
    await mkdir(bunRoot, { mode: 0o700 });
    await Promise.all([
        mkdir(firstReleaseRoot, { mode: 0o500 }),
        mkdir(secondReleaseRoot, { mode: 0o500 }),
        mkdir(runtimeRoot, { mode: 0o700 }),
    ]);
    await writeFile(runtimeExecutable, "test-bun-runtime", { mode: 0o500 });
    await chmod(runtimeRoot, 0o500);
    return Object.freeze({
        first: Object.freeze({
            manifest: releaseManifest(firstReleaseId),
            releaseRoot: firstReleaseRoot,
        }),
        runtime: Object.freeze({
            executable: runtimeExecutable,
            identity: runtimeIdentity,
        }),
        second: Object.freeze({
            manifest: releaseManifest(secondReleaseId),
            releaseRoot: secondReleaseRoot,
        }),
    });
}

function successfulProcessResult(): SystemctlProcessResult {
    return Object.freeze({
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
    });
}

function inactiveProcessResult(): SystemctlProcessResult {
    return Object.freeze({
        exitCode: 3,
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
    });
}

describe("production root-systemd service control", () => {
    test("rejects published authority whose escaped systemd unit exceeds the limit", async () => {
        const { projectRoot } = await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await createRuntimePointerFixture(paths);
            const authority = {
                ...publishedAuthority(firstReleaseId),
                tagName: `v1.2.3.${"a".repeat(64)}`,
            } as PublishedReleaseAuthority;
            const controller = createSystemdProductionServiceController(lease, paths, {
                execute: () => Promise.resolve(successfulProcessResult()),
                readinessUrl: "http://127.0.0.1:3100/api/health/ready",
                releaseAuthority: authority,
            });
            expect(
                controller.provision(fixtures.first, fixtures.runtime)
            ).rejects.toThrow("Production service control failed");
        });
    });

    test("points at exact artifacts and controls worker/web in safe order", async () => {
        const { projectRoot } = await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await createRuntimePointerFixture(paths);
            const commands: string[][] = [];
            const deadlines: (number | undefined)[] = [];
            const requests: Request[] = [];
            const smokes: string[] = [];
            const controller = createSystemdProductionServiceController(lease, paths, {
                execute: (_executable, arguments_, options_) => {
                    commands.push([...arguments_]);
                    deadlines.push(options_?.deadlineMs);
                    return Promise.resolve(successfulProcessResult());
                },
                fetch: (request) => {
                    requests.push(request);
                    return Promise.resolve(new Response(null, { status: 200 }));
                },
                verifyUnits: (observedLease, observedPaths, observedRelease) => {
                    expect(observedLease).toBe(lease);
                    expect(observedPaths).toBe(paths);
                    expect(observedRelease).toBe(fixtures.first);
                    return Promise.resolve();
                },
                readinessUrl: "http://127.0.0.1:3100/api/health/ready",
                releaseAuthority: publishedAuthority(firstReleaseId),
                smoke: (observedPaths, release, runtime, readinessUrl, transitionId) => {
                    expect(observedPaths).toBe(paths);
                    expect(release).toBe(fixtures.first);
                    expect(runtime).toBe(fixtures.runtime);
                    expect(readinessUrl).toBe("http://127.0.0.1:3100/api/health/ready");
                    smokes.push(transitionId);
                    return Promise.resolve();
                },
            });

            await controller.provision(fixtures.first, fixtures.runtime);
            await controller.prepare(fixtures.first, fixtures.runtime);
            await controller.start(fixtures.first, fixtures.runtime);
            await controller.verifyReady(fixtures.first, fixtures.runtime);
            const smokeTransitionId = Bun.randomUUIDv7();
            await controller.verifySmoke(
                fixtures.first,
                fixtures.runtime,
                smokeTransitionId
            );
            await controller.settle?.(fixtures.first, fixtures.runtime);
            await controller.stop();
            expect(await readlink(path.join(paths.releasesDirectory, "current"))).toBe(
                firstReleaseId
            );
            expect(
                await readlink(path.join(paths.runtimesDirectory, "bun", "current"))
            ).toBe(runtimeIdentity.revision);
            expect(commands).toEqual([
                [
                    "start",
                    `mira-p@${firstReleaseId}--v1.2.3--${"d".repeat(64)}--${"e".repeat(64)}.service`,
                ],
                ["restart", "mira-dashboard-worker.service"],
                ["restart", "mira-dashboard-web.service"],
                ["is-active", "--quiet", "mira-dashboard-worker.service"],
                ["is-active", "--quiet", "mira-dashboard-web.service"],
                ["is-active", "--quiet", "mira-dashboard-worker.service"],
                ["is-active", "--quiet", "mira-dashboard-web.service"],
                ["is-active", "--quiet", "mira-dashboard-worker.service"],
                ["is-active", "--quiet", "mira-dashboard-web.service"],
                ["start", `mira-p@${firstReleaseId}--local--settled.service`],
                ["stop", "mira-dashboard-web.service"],
                ["stop", "mira-dashboard-worker.service"],
            ]);
            expect(deadlines[0]).toBe(930_000);
            expect(deadlines[9]).toBe(930_000);
            expect(
                deadlines
                    .filter((_deadline, index) => index !== 0 && index !== 9)
                    .every((deadline) => deadline === undefined)
            ).toBe(true);
            expect(requests).toHaveLength(1);
            expect(requests[0]?.method).toBe("HEAD");
            expect(requests[0]?.url).toBe("http://127.0.0.1:3100/api/health/ready");
            expect(smokes).toEqual([smokeTransitionId]);
            expect(() =>
                createSystemdProductionServiceController(lease, paths, {
                    readinessUrl: "http://[::1]:3100/api/health/ready",
                })
            ).toThrow("Production service control failed");

            for (const inactiveUnit of [
                "mira-dashboard-worker.service",
                "mira-dashboard-web.service",
            ]) {
                const checkedUnits: string[] = [];
                let readinessRequests = 0;
                const inactiveController = createSystemdProductionServiceController(
                    lease,
                    paths,
                    {
                        execute: (_executable, arguments_) => {
                            const unit = arguments_.at(-1);
                            if (unit) checkedUnits.push(unit);
                            return Promise.resolve(
                                unit === inactiveUnit
                                    ? inactiveProcessResult()
                                    : successfulProcessResult()
                            );
                        },
                        fetch: () => {
                            readinessRequests += 1;
                            return Promise.resolve(new Response(null, { status: 200 }));
                        },
                        readinessUrl: "http://127.0.0.1:3100/api/health/ready",
                    }
                );
                const inactiveFailure = await rejectionError(
                    inactiveController.verifyReady(fixtures.first, fixtures.runtime)
                );
                expect(inactiveFailure.message).toBe("Production service control failed");
                expect(checkedUnits).toEqual(
                    inactiveUnit === "mira-dashboard-worker.service"
                        ? ["mira-dashboard-worker.service"]
                        : ["mira-dashboard-worker.service", "mira-dashboard-web.service"]
                );
                expect(readinessRequests).toBe(0);
            }

            let activeChecks = 0;
            let readinessRequests = 0;
            const exitedDuringReadiness = createSystemdProductionServiceController(
                lease,
                paths,
                {
                    execute: (_executable, arguments_) => {
                        if (arguments_.includes("is-active")) activeChecks += 1;
                        return Promise.resolve(
                            activeChecks === 3
                                ? inactiveProcessResult()
                                : successfulProcessResult()
                        );
                    },
                    fetch: () => {
                        readinessRequests += 1;
                        return Promise.resolve(new Response(null, { status: 200 }));
                    },
                    readinessUrl: "http://127.0.0.1:3100/api/health/ready",
                }
            );
            const exitedFailure = await rejectionError(
                exitedDuringReadiness.verifyReady(fixtures.first, fixtures.runtime)
            );
            expect(exitedFailure.message).toBe("Production service control failed");
            expect(activeChecks).toBe(3);
            expect(readinessRequests).toBe(1);

            await pointProductionProcessesAtRelease(
                lease,
                paths,
                fixtures.second,
                fixtures.runtime
            );
            expect(await readlink(path.join(paths.releasesDirectory, "current"))).toBe(
                secondReleaseId
            );
        });
    });

    test("provisions retained rollback authority from the root-staged release", async () => {
        const { projectRoot } = await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await createRuntimePointerFixture(paths);
            const commands: string[][] = [];
            const controller = createSystemdProductionServiceController(lease, paths, {
                execute: (_executable, arguments_) => {
                    commands.push([...arguments_]);
                    return Promise.resolve(successfulProcessResult());
                },
                readinessUrl: "http://127.0.0.1:3100/api/health/ready",
            });

            await controller.provision(fixtures.first, fixtures.runtime);

            expect(commands).toEqual([
                ["start", `mira-p@${firstReleaseId}--local.service`],
            ]);
        });
    });

    test("removes crash-left pointer stages before replacing current", async () => {
        const { projectRoot } = await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await createRuntimePointerFixture(paths);
            await pointProductionProcessesAtRelease(
                lease,
                paths,
                fixtures.first,
                fixtures.runtime
            );
            const releaseStage = `.current-${Bun.randomUUIDv7()}`;
            const runtimeStage = `.current-${Bun.randomUUIDv7()}`;
            await symlink(
                firstReleaseId,
                path.join(paths.releasesDirectory, releaseStage),
                "dir"
            );
            await symlink(
                runtimeIdentity.revision,
                path.join(paths.runtimesDirectory, "bun", runtimeStage),
                "dir"
            );

            await pointProductionProcessesAtRelease(
                lease,
                paths,
                fixtures.second,
                fixtures.runtime
            );

            expect(await readlink(path.join(paths.releasesDirectory, "current"))).toBe(
                secondReleaseId
            );
            expect(
                await readlink(path.join(paths.runtimesDirectory, "bun", "current"))
            ).toBe(runtimeIdentity.revision);
            expect(await readdir(paths.releasesDirectory)).not.toContain(releaseStage);
            expect(
                await readdir(path.join(paths.runtimesDirectory, "bun"))
            ).not.toContain(runtimeStage);
        });
    });

    test("refuses to remove an untrusted pointer-stage symlink", async () => {
        const { projectRoot } = await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await createRuntimePointerFixture(paths);
            await pointProductionProcessesAtRelease(
                lease,
                paths,
                fixtures.first,
                fixtures.runtime
            );
            const validStageName = `.current-${Bun.randomUUIDv7()}`;
            await symlink(
                firstReleaseId,
                path.join(paths.releasesDirectory, validStageName),
                "dir"
            );
            const stageName = `.current-${Bun.randomUUIDv7()}`;
            const stagePath = path.join(paths.releasesDirectory, stageName);
            await symlink("../outside", stagePath, "dir");

            const failure = await rejectionError(
                pointProductionProcessesAtRelease(
                    lease,
                    paths,
                    fixtures.second,
                    fixtures.runtime
                )
            );

            expect(failure.message).toBe("Production runtime pointer update failed");
            expect(await readlink(path.join(paths.releasesDirectory, "current"))).toBe(
                firstReleaseId
            );
            expect(await readdir(paths.releasesDirectory)).toContain(validStageName);
            expect(await readlink(stagePath)).toBe("../outside");
        });
    });

    test("bounds crash-left pointer-stage inventory before mutation", async () => {
        const { projectRoot } = await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await createRuntimePointerFixture(paths);
            await pointProductionProcessesAtRelease(
                lease,
                paths,
                fixtures.first,
                fixtures.runtime
            );
            for (let index = 0; index < 129; index += 1) {
                await symlink(
                    firstReleaseId,
                    path.join(paths.releasesDirectory, `.current-${Bun.randomUUIDv7()}`),
                    "dir"
                );
            }

            const failure = await rejectionError(
                pointProductionProcessesAtRelease(
                    lease,
                    paths,
                    fixtures.second,
                    fixtures.runtime
                )
            );

            expect(failure.message).toBe("Production runtime pointer update failed");
            expect(await readlink(path.join(paths.releasesDirectory, "current"))).toBe(
                firstReleaseId
            );
        });
    });

    test("refuses to replace an untrusted current entry", async () => {
        const { projectRoot } = await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await createRuntimePointerFixture(paths);
            await pointProductionProcessesAtRelease(
                lease,
                paths,
                fixtures.first,
                fixtures.runtime
            );
            const current = path.join(paths.releasesDirectory, "current");
            await unlink(current);
            await mkdir(current, { mode: 0o700 });
            const failure = await rejectionError(
                pointProductionProcessesAtRelease(
                    lease,
                    paths,
                    fixtures.second,
                    fixtures.runtime
                )
            );
            expect(failure.message).toBe("Production runtime pointer update failed");
        });
    });

    test("ships project-local logs and the reviewed resource ceilings", async () => {
        const systemdRoot = path.join(sourceProjectRoot, "systemd");
        const [web, worker, webRuntime] = await Promise.all([
            readFile(path.join(systemdRoot, "mira-dashboard-web.service"), "utf8"),
            readFile(path.join(systemdRoot, "mira-dashboard-worker.service"), "utf8"),
            readFile(
                path.join(
                    sourceProjectRoot,
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-web-runtime"
                ),
                "utf8"
            ),
        ]);
        const webExecStart = webRuntime;
        const workerExecStart = worker
            .split("\n")
            .find((line) => line.startsWith("ExecStart="));
        for (const unit of [web, worker]) {
            expect(unit).not.toContain("StateDirectory=");
            expect(unit).not.toContain("LogsDirectory=");
            expect(unit).not.toContain("/var/lib/");
            expect(unit).not.toContain("/var/log/");
            expect(unit).toContain(
                "Environment=MIRA_DASHBOARD_PROJECT_ROOT=/home/ubuntu/projects/mira-dashboard"
            );
            expect(unit).toContain(
                "Environment=MIRA_DASHBOARD_WORKSPACE_ROOT=/home/ubuntu/.openclaw/workspace"
            );
            expect(unit).toContain(
                "WorkingDirectory=/home/ubuntu/projects/mira-dashboard/production/releases/current"
            );
            expect(unit).toMatch(
                /StandardOutput=append:\/home\/ubuntu\/projects\/mira-dashboard\/production\/state\/logs\//u
            );
            expect(unit).toMatch(
                /StandardError=append:\/home\/ubuntu\/projects\/mira-dashboard\/production\/state\/logs\//u
            );
            expect(unit).toContain("WantedBy=multi-user.target");
        }
        expect(web).toContain("MemoryHigh=768M");
        expect(web).toContain(
            "Environment=MIRA_DASHBOARD_OPENCLAW_ROOT=/home/ubuntu/.openclaw"
        );
        expect(webRuntime).toContain(
            "--preserve-env=NODE_ENV,MIRA_DASHBOARD_PROJECT_ROOT,MIRA_DASHBOARD_OPENCLAW_ROOT,MIRA_DASHBOARD_WORKSPACE_ROOT"
        );
        expect(webRuntime).toContain("--no-exit-on-missing-only-secrets");
        expect(webRuntime).toContain(
            `--only-secrets ${configurationEnvironmentNamesForRole("web").join(",")}`
        );
        expect(webExecStart).not.toContain("MOLTBOOK_API_KEY");
        expect(web).toContain(
            "UnsetEnvironment=MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD DOCKER_LOGIN DOCKER_TOKEN MIRA_GITHUB_USERNAME MIRA_GITHUB_TOKEN RAJOHAN_GITHUB_TOKEN MOLTBOOK_API_KEY MOLTBOOK_AGENT_NAME"
        );
        expect(worker).toContain(
            "Environment=MIRA_DASHBOARD_OPENCLAW_ROOT=/home/ubuntu/.openclaw"
        );
        expect(worker).toContain(
            "--preserve-env=NODE_ENV,MIRA_DASHBOARD_PROJECT_ROOT,MIRA_DASHBOARD_OPENCLAW_ROOT,MIRA_DASHBOARD_WORKSPACE_ROOT"
        );
        expect(worker).toContain("--no-exit-on-missing-only-secrets");
        expect(worker).toContain(
            `--only-secrets ${configurationEnvironmentNamesForRole("worker").join(",")}`
        );
        expect(workerExecStart).toContain("ELEVENLABS_API_KEY");
        expect(workerExecStart).toContain("OPENROUTER_API_KEY");
        expect(workerExecStart).toContain("SYNTHETIC_API_KEY");
        expect(workerExecStart).not.toContain("MIRA_DASHBOARD_TOTP_KEYRING");
        expect(worker).toContain("UnsetEnvironment=MIRA_DASHBOARD_TOTP_KEYRING");
        expect(web).toContain("MemoryMax=1G");
        expect(web).toContain("TasksMax=96");
        expect(web).toContain("User=mira-dashboard-web");
        expect(web).toContain("Group=mira-dashboard-web");
        expect(worker).toContain("User=ubuntu");
        expect(worker).toContain("Group=ubuntu");
        expect(worker).toContain("SupplementaryGroups=docker");
        expect(web).not.toContain("SupplementaryGroups=");
        expect(web).toContain("ProtectHome=tmpfs");
        expect(web).toContain(
            "BindReadOnlyPaths=/home/ubuntu/projects/mira-dashboard:/run/mira-dashboard-web-mounts/project"
        );
        expect(web).toContain(
            "BindPaths=/home/ubuntu/projects/mira-dashboard/production/state:/run/mira-dashboard-web-mounts/state"
        );
        expect(web).toContain(
            "BindReadOnlyPaths=/home/ubuntu/.openclaw:/run/mira-dashboard-web-mounts/openclaw"
        );
        expect(web).toContain(
            "InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/opt/docker"
        );
        expect(web).toContain("ExecStart=!/usr/local/libexec/mira-dashboard-web-runtime");
        for (const [path, kind] of [
            ["/run/docker.sock", "sock"],
            ["/var/run/docker.sock", "sock"],
            ["/opt/docker", "dir"],
            ["/run/systemd/private", "sock"],
            ["/run/dbus/system_bus_socket", "sock"],
        ]) {
            expect(webRuntime).toContain(`assert_inaccessible_mount ${path} ${kind}`);
        }
        expect(webRuntime).toContain('"tmpfs[/systemd/inaccessible/$kind]"');
        expect(webRuntime).not.toContain("[ ! -e /run/docker.sock ]");
        expect(webRuntime).toContain("--clear-groups");
        expect(webRuntime).toContain("--bounding-set=-all");
        expect(webRuntime).toContain(
            'mapping="X-mount.idmap=u:${owner_uid}:${web_uid}:1 g:${owner_gid}:${web_gid}:1"'
        );
        expect(worker).not.toContain("InaccessiblePaths=");
        expect(web).toContain("PrivateTmp=true");
        expect(web).toContain("BindReadOnlyPaths=-/tmp/openclaw");
        expect(web).not.toContain("\nBindPaths=-/tmp/openclaw");
        // Atomic replacement creates a stage file beside its target before
        // renameat2 exchange. A read-only OpenClaw root with exact-file
        // exceptions would therefore fail at runtime; the descriptor writer's
        // reviewed replacement manifest is the write boundary instead.
        expect(worker).not.toContain("ReadOnlyPaths=/home/ubuntu/.openclaw");
        expect(worker).not.toContain("ReadWritePaths=/home/ubuntu/.openclaw");
        expect(worker).toContain("PrivateTmp=true\nBindPaths=-/tmp/openclaw");
        expect(worker).not.toContain("BindReadOnlyPaths=-/tmp/openclaw");
        expect(web).toContain("CPUQuota=100%");
        expect(worker).toContain("MemoryHigh=768M");
        expect(worker).toContain("MemoryMax=1536M");
        expect(worker).toContain("TasksMax=128");
        expect(worker).toContain("CPUQuota=150%");
    });

    test("projects only web secrets without exposing the operator Doppler credential", async () => {
        const [web, webRuntime] = await Promise.all([
            readFile(
                path.join(sourceProjectRoot, "systemd/mira-dashboard-web.service"),
                "utf8"
            ),
            readFile(
                path.join(
                    sourceProjectRoot,
                    "scripts/delivery/provisioning/host-operations/mira-dashboard-web-runtime"
                ),
                "utf8"
            ),
        ]);

        expect(web).toContain("BindReadOnlyPaths=/home/ubuntu/.doppler");
        expect(web.match(/BindReadOnlyPaths=.*\/home\/ubuntu\/\.doppler/gu)).toHaveLength(
            1
        );
        expect(web).not.toContain("/run/mira-dashboard-web-mounts/doppler");
        expect(webRuntime).not.toContain(
            "mount_idmapped \\\n    /run/mira-dashboard-web-mounts/doppler"
        );
        expect(webRuntime).toContain(
            '"$(/usr/bin/stat -c %u:%g:%a -- "$operator_doppler")" = "$owner_uid:$owner_gid:700"'
        );
        expect(webRuntime).toContain(
            '"$(/usr/bin/stat -c %u:%g:%a:%h -- "$operator_doppler_config")" = "$owner_uid:$owner_gid:600:1"'
        );
        expect(webRuntime).toContain('-- /usr/bin/test -r "$operator_doppler"');
        expect(webRuntime).toContain('-- /usr/bin/test -x "$operator_doppler"');
        expect(webRuntime).toContain('/usr/bin/umount -- "$operator_doppler"');
        expect(webRuntime).toContain('[ ! -e "$operator_doppler_config" ]');

        const dopplerLaunch = webRuntime.indexOf("/usr/local/bin/doppler \\\n");
        const credentialHidden = webRuntime.indexOf(
            '/usr/bin/umount -- "$operator_doppler"'
        );
        const irreversibleDrop = webRuntime.indexOf(
            "exec /usr/bin/setpriv \\\n",
            credentialHidden
        );
        expect(dopplerLaunch).toBeGreaterThanOrEqual(0);
        expect(credentialHidden).toBeGreaterThanOrEqual(0);
        expect(irreversibleDrop).toBeGreaterThan(credentialHidden);
        expect(webRuntime).toContain("--config-dir=/home/ubuntu/.doppler");
        expect(webRuntime).toContain("--no-read-env");
        expect(webRuntime).toContain("--fallback-readonly");
        expect(webRuntime).toContain("--no-liveness-ping");
        expect(webRuntime).toContain(
            "-- /usr/local/libexec/mira-dashboard-web-runtime projected-web-runtime"
        );
        expect(webRuntime).not.toContain("DOPPLER_TOKEN");
    });
});
