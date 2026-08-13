import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    createLocalReleaseFixture,
    createProductionTargetFixture,
    removeProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { publishProductionRelease } from "./productionReleasePublication.ts";
import { installProductionRuntime } from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";
import { verifyPublishedProductionSystemdUnitsInstalledAtRoot } from "./verifyProductionSystemdUnits.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const releaseId = "d".repeat(40);
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "e".repeat(40),
    version: "1.4.0",
});
const temporaryDirectories: string[] = [];

function systemctlOutput(value: string) {
    return Object.freeze({
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode(`${value}\n`),
    });
}

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

describe("root-installed production systemd unit verification", () => {
    test("accepts only exact manifest bytes under a protected root-owned analogue", async () => {
        const sourceRelease = await createLocalReleaseFixture(
            sourceProjectRoot,
            releaseId,
            runtimeIdentity,
            temporaryDirectories
        );
        const { projectRoot, runtimeSource } =
            await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const unitDirectory = await mkdtemp(path.join(tmpdir(), "mira-root-units-"));
        temporaryDirectories.push(unitDirectory);
        await chmod(unitDirectory, 0o755);

        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const runtime = await installProductionRuntime(
                lease,
                paths,
                runtimeIdentity,
                {
                    probeRuntime: () => Promise.resolve(runtimeIdentity),
                    sourceExecutable: runtimeSource,
                }
            );
            const release = await publishProductionRelease(
                lease,
                paths,
                sourceRelease,
                runtime.identity
            );
            for (const fileName of [
                "mira-dashboard-web.service",
                "mira-dashboard-worker.service",
            ]) {
                const destination = path.join(unitDirectory, fileName);
                await copyFile(
                    path.join(release.releaseRoot, "systemd", fileName),
                    destination
                );
                await chmod(destination, 0o644);
            }
            let staleWebDropIn = false;
            const identity = {
                executeSystemctl: (_executable: string, arguments_: readonly string[]) =>
                    Promise.resolve(
                        systemctlOutput(
                            arguments_[3] === "mira-dashboard-web.service" &&
                                staleWebDropIn
                                ? "/etc/systemd/system/mira-dashboard-web.service.d/stale.conf"
                                : ""
                        )
                    ),
                expectedGroupId: process.getgid?.() ?? -1,
                expectedUserId: process.getuid?.() ?? -1,
                rootUnitDirectory: unitDirectory,
            };
            await verifyPublishedProductionSystemdUnitsInstalledAtRoot(
                lease,
                paths,
                release,
                identity
            );

            staleWebDropIn = true;
            const dropInFailure = await rejectionError(
                verifyPublishedProductionSystemdUnitsInstalledAtRoot(
                    lease,
                    paths,
                    release,
                    identity
                )
            );
            expect(dropInFailure.message).toBe(
                "Production systemd authority verification failed"
            );
            staleWebDropIn = false;

            await writeFile(
                path.join(unitDirectory, "mira-dashboard-web.service"),
                "tampered\n",
                { mode: 0o644 }
            );
            const failure = await rejectionError(
                verifyPublishedProductionSystemdUnitsInstalledAtRoot(
                    lease,
                    paths,
                    release,
                    identity
                )
            );
            expect(failure.message).toBe(
                "Production systemd authority verification failed"
            );
        });
    });
});
