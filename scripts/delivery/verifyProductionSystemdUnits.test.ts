import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReleaseManifest } from "../../src/shared/releaseManifest.ts";
import { removeProductionDeliveryFixtures } from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import { productionSystemdUnits } from "./productionSystemdUnitPolicy.ts";
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

async function createVerificationFixture(): Promise<{
    readonly lease: DashboardDeploymentLease;
    readonly paths: PreparedProductionDeliveryPaths;
    readonly release: PublishedProductionRelease;
    readonly unitDirectory: string;
}> {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mira-systemd-verify-"));
    temporaryDirectories.push(fixtureRoot);
    const releaseRoot = path.join(fixtureRoot, "release");
    const releaseSystemdDirectory = path.join(releaseRoot, "systemd");
    const stateDirectory = path.join(fixtureRoot, "state");
    const unitDirectory = path.join(fixtureRoot, "root-units");
    await Promise.all([
        mkdir(releaseSystemdDirectory, { recursive: true }),
        mkdir(stateDirectory),
        mkdir(unitDirectory),
    ]);
    await chmod(unitDirectory, 0o755);

    const artifacts = [];
    for (const policy of productionSystemdUnits) {
        const source = path.join(sourceProjectRoot, policy.artifactPath);
        const destination = path.join(releaseRoot, policy.artifactPath);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
        const bytes = await readFile(destination);
        artifacts.push({
            bytes: bytes.byteLength,
            path: policy.artifactPath,
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        });
        await copyFile(destination, path.join(unitDirectory, policy.fileName));
        await chmod(path.join(unitDirectory, policy.fileName), 0o644);
    }

    const manifest = {
        artifacts,
        runtime: runtimeIdentity,
        source: { commitSha: releaseId },
    } as unknown as ReleaseManifest;
    const release = Object.freeze({ manifest, releaseRoot });
    return {
        lease: { stateDirectory } as DashboardDeploymentLease,
        paths: { stateDirectory } as PreparedProductionDeliveryPaths,
        release,
        unitDirectory,
    };
}

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

describe("root-installed production systemd unit verification", () => {
    test("accepts only exact manifest bytes under a protected root-owned analogue", async () => {
        const { lease, paths, release, unitDirectory } =
            await createVerificationFixture();
        const loadPublishedRelease = mock(
            (
                actualPaths: PreparedProductionDeliveryPaths,
                actualReleaseId: string,
                actualRuntimeRevision: string
            ) => {
                expect(actualPaths).toBe(paths);
                expect(actualReleaseId).toBe(releaseId);
                expect(actualRuntimeRevision).toBe(runtimeIdentity.revision);
                return Promise.resolve(release);
            }
        );
        let staleWebDropIn = false;
        const inspectedUnits: string[] = [];
        const identity = {
            executeSystemctl: (_executable: string, arguments_: readonly string[]) => {
                inspectedUnits.push(arguments_[3] ?? "");
                return Promise.resolve(
                    systemctlOutput(
                        arguments_[3] === "mira-dashboard-web.service" && staleWebDropIn
                            ? "/etc/systemd/system/mira-dashboard-web.service.d/stale.conf"
                            : ""
                    )
                );
            },
            expectedGroupId: process.getgid?.() ?? -1,
            expectedUserId: process.getuid?.() ?? -1,
            loadPublishedRelease,
            rootUnitDirectory: unitDirectory,
        };
        await verifyPublishedProductionSystemdUnitsInstalledAtRoot(
            lease,
            paths,
            release,
            identity
        );
        expect(inspectedUnits).toContain("mira-p@mira-dashboard-verification.service");
        expect(inspectedUnits).not.toContain("mira-p@.service");

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
        expect(failure.message).toBe("Production systemd authority verification failed");
        expect(loadPublishedRelease).toHaveBeenCalledTimes(4);
    });
});
