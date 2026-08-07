import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readlink, unlink } from "node:fs/promises";
import path from "node:path";

import {
    createLocalReleaseFixture,
    createProductionTargetFixture,
    publishProductionDeliveryFixtures,
    removeProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
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

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

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

describe("production user-systemd service control", () => {
    test("points at exact artifacts and controls worker/web in safe order", async () => {
        const sourceReleases = await Promise.all([
            createLocalReleaseFixture(
                sourceProjectRoot,
                firstReleaseId,
                runtimeIdentity,
                temporaryDirectories
            ),
            createLocalReleaseFixture(
                sourceProjectRoot,
                secondReleaseId,
                runtimeIdentity,
                temporaryDirectories
            ),
        ]);
        const { projectRoot, runtimeSource } =
            await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishProductionDeliveryFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource,
                runtimeIdentity
            );
            const commands: string[][] = [];
            const requests: Request[] = [];
            const controller = createSystemdProductionServiceController(lease, paths, {
                execute: (_executable, arguments_) => {
                    commands.push([...arguments_]);
                    return Promise.resolve(successfulProcessResult());
                },
                fetch: (request) => {
                    requests.push(request);
                    return Promise.resolve(new Response(null, { status: 200 }));
                },
                installUnits: (observedLease, observedPaths, observedRelease) => {
                    expect(observedLease).toBe(lease);
                    expect(observedPaths).toBe(paths);
                    expect(observedRelease).toBe(fixtures.first);
                    return Promise.resolve();
                },
                readinessUrl: "http://127.0.0.1:3100/api/health/ready",
            });

            await controller.prepare(fixtures.first, fixtures.runtime);
            await controller.start(fixtures.first, fixtures.runtime);
            await controller.verifyReady(fixtures.first, fixtures.runtime);
            await controller.stop();
            expect(await readlink(path.join(paths.releasesDirectory, "current"))).toBe(
                firstReleaseId
            );
            expect(
                await readlink(path.join(paths.runtimesDirectory, "bun", "current"))
            ).toBe(runtimeIdentity.revision);
            expect(commands).toEqual([
                ["--user", "restart", "mira-dashboard-worker.service"],
                ["--user", "restart", "mira-dashboard-web.service"],
                ["--user", "is-active", "--quiet", "mira-dashboard-worker.service"],
                ["--user", "is-active", "--quiet", "mira-dashboard-web.service"],
                ["--user", "stop", "mira-dashboard-web.service"],
                ["--user", "stop", "mira-dashboard-worker.service"],
            ]);
            expect(requests).toHaveLength(1);
            expect(requests[0]?.method).toBe("HEAD");
            expect(requests[0]?.url).toBe("http://127.0.0.1:3100/api/health/ready");
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

    test("refuses to replace an untrusted current entry", async () => {
        const sourceReleases = await Promise.all([
            createLocalReleaseFixture(
                sourceProjectRoot,
                firstReleaseId,
                runtimeIdentity,
                temporaryDirectories
            ),
            createLocalReleaseFixture(
                sourceProjectRoot,
                secondReleaseId,
                runtimeIdentity,
                temporaryDirectories
            ),
        ]);
        const { projectRoot, runtimeSource } =
            await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishProductionDeliveryFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource,
                runtimeIdentity
            );
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
        const [web, worker] = await Promise.all([
            readFile(path.join(systemdRoot, "mira-dashboard-web.service"), "utf8"),
            readFile(path.join(systemdRoot, "mira-dashboard-worker.service"), "utf8"),
        ]);
        for (const unit of [web, worker]) {
            expect(unit).not.toContain("StateDirectory=");
            expect(unit).not.toContain("LogsDirectory=");
            expect(unit).not.toContain("/var/lib/");
            expect(unit).not.toContain("/var/log/");
            expect(unit).toContain(
                "Environment=MIRA_DASHBOARD_PROJECT_ROOT=%h/projects/mira-dashboard"
            );
            expect(unit).toContain(
                "WorkingDirectory=%h/projects/mira-dashboard/production/releases/current"
            );
            expect(unit).toMatch(
                /StandardOutput=append:%h\/projects\/mira-dashboard\/production\/state\/logs\//u
            );
            expect(unit).toMatch(
                /StandardError=append:%h\/projects\/mira-dashboard\/production\/state\/logs\//u
            );
        }
        expect(web).toContain("MemoryHigh=768M");
        expect(web).toContain("MemoryMax=1G");
        expect(web).toContain("TasksMax=96");
        expect(web).toContain("CPUQuota=100%");
        expect(worker).toContain("MemoryHigh=768M");
        expect(worker).toContain("MemoryMax=1536M");
        expect(worker).toContain("TasksMax=128");
        expect(worker).toContain("CPUQuota=150%");
    });
});
