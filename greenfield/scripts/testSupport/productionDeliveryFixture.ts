import {
    chmod,
    cp,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    parseDatabaseMaintenanceArguments,
    runDashboardDatabaseMaintenance,
} from "../../src/app/databaseMaintenance.ts";
import type { BuildSourceIdentity } from "../buildSourceIdentity.ts";
import {
    buildDashboardRelease,
    type ReleaseBuildCommand,
} from "../delivery/buildRelease.ts";
import type { DatabaseMaintenanceProcessOutput } from "../delivery/databaseMaintenanceProcess.ts";
import type { DashboardDeploymentLease } from "../delivery/deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "../delivery/productionDeliveryFilesystem.ts";
import {
    publishProductionRelease,
    type PublishedProductionRelease,
} from "../delivery/productionReleasePublication.ts";
import {
    installProductionRuntime,
    type InstalledProductionRuntime,
} from "../delivery/productionRuntime.ts";
import type { ReleaseRuntimeIdentity } from "../delivery/releaseIdentity.ts";

const encoder = new TextEncoder();

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await stat(directory).catch(() => null);
    if (!status?.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await restoreOwnerWrite(entryPath);
        } else if (entry.isFile()) {
            await chmod(entryPath, 0o600);
        }
    }
}

/**
 * Restores immutable fixture permissions and removes every registered temporary root.
 * @param temporaryDirectories Mutable registry of fixture roots owned by the caller.
 * @returns Completion after every registered root is absent.
 */
export async function removeProductionDeliveryFixtures(
    temporaryDirectories: string[]
): Promise<void> {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
}

async function materializeCommandOutput(
    command: ReleaseBuildCommand,
    repositoryRoot: string
): Promise<void> {
    if (command === "bun run build:browser") {
        await mkdir(path.join(repositoryRoot, "dist/browser/assets"), {
            recursive: true,
        });
        await Promise.all([
            writeFile(path.join(repositoryRoot, "dist/browser/index.html"), "dashboard"),
            writeFile(
                path.join(repositoryRoot, "dist/browser/assets/app-a1b2c3d4.js"),
                "app"
            ),
        ]);
    }
    if (command === "bun run build:processes") {
        await mkdir(path.join(repositoryRoot, "dist/processes"), { recursive: true });
        await Promise.all([
            writeFile(
                path.join(repositoryRoot, "dist/processes/databaseMaintenance.js"),
                "database-maintenance"
            ),
            writeFile(path.join(repositoryRoot, "dist/processes/web.js"), "web"),
            writeFile(path.join(repositoryRoot, "dist/processes/worker.js"), "worker"),
        ]);
    }
}

/**
 * Builds one deterministic immutable release fixture with the real manifest pipeline.
 * @param sourceProjectRoot Greenfield repository root supplying reviewed inputs.
 * @param commitSha Synthetic clean source identity for this fixture.
 * @param runtimeIdentity Exact runtime identity encoded into the manifest.
 * @param temporaryDirectories Mutable registry receiving the owned fixture root.
 * @returns Immutable local release root.
 */
export async function createLocalReleaseFixture(
    sourceProjectRoot: string,
    commitSha: string,
    runtimeIdentity: ReleaseRuntimeIdentity,
    temporaryDirectories: string[]
): Promise<string> {
    const repositoryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-release-activation-source-")
    );
    temporaryDirectories.push(repositoryRoot);
    await Promise.all([
        cp(
            path.join(sourceProjectRoot, "docs/generated"),
            path.join(repositoryRoot, "docs/generated"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, "migrations"),
            path.join(repositoryRoot, "migrations"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, "systemd"),
            path.join(repositoryRoot, "systemd"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, "scripts/delivery/provisioning"),
            path.join(repositoryRoot, "scripts/delivery/provisioning"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, ".bun-version"),
            path.join(repositoryRoot, ".bun-version")
        ),
        cp(
            path.join(sourceProjectRoot, "bun.lock"),
            path.join(repositoryRoot, "bun.lock")
        ),
        cp(
            path.join(sourceProjectRoot, "package.json"),
            path.join(repositoryRoot, "package.json")
        ),
    ]);
    const cleanSource: BuildSourceIdentity = Object.freeze({
        commitSha,
        state: "clean",
    });
    const release = await buildDashboardRelease(repositoryRoot, {
        resolveSourceIdentity: () => cleanSource,
        runCommand: materializeCommandOutput,
        runtimeIdentity,
    });
    return release.releaseRoot;
}

/**
 * Creates one project-local production target plus a harmless runtime source fixture.
 * @param temporaryDirectories Mutable registry receiving both owned roots.
 * @returns Project root and executable-shaped runtime source path.
 */
export async function createProductionTargetFixture(
    temporaryDirectories: string[]
): Promise<{ projectRoot: string; runtimeSource: string }> {
    const projectRoot = await mkdtemp(
        path.join(tmpdir(), "mira-release-activation-target-")
    );
    const runtimeRoot = await mkdtemp(
        path.join(tmpdir(), "mira-release-activation-runtime-")
    );
    temporaryDirectories.push(projectRoot, runtimeRoot);
    const runtimeSource = path.join(runtimeRoot, "bun");
    await writeFile(runtimeSource, "test-bun-runtime");
    await chmod(runtimeSource, 0o500);
    return { projectRoot, runtimeSource };
}

/**
 * Executes the real database maintenance composition in-process and preserves its wire format.
 * @param command Exact child-process argv generated by delivery code.
 * @returns Bounded process-shaped output.
 */
export async function executeDatabaseMaintenanceFixture(
    command: readonly string[]
): Promise<DatabaseMaintenanceProcessOutput> {
    try {
        const parsed = parseDatabaseMaintenanceArguments(command.slice(2));
        const result = await runDashboardDatabaseMaintenance(parsed);
        return Object.freeze({
            exitCode: 0,
            stderr: new Uint8Array(),
            stdout: encoder.encode(
                `${JSON.stringify(
                    result === undefined
                        ? { status: "MAINTAINED" }
                        : { ...result, status: "SNAPSHOT" }
                )}\n`
            ),
        });
    } catch {
        return Object.freeze({
            exitCode: 1,
            stderr: encoder.encode("maintenance failed\n"),
            stdout: new Uint8Array(),
        });
    }
}

/**
 * Installs one runtime and publishes an ordered pair of release fixtures.
 * @param lease Active fixture deployment lease.
 * @param paths Prepared fixture production paths.
 * @param sourceReleases Ordered local release roots.
 * @param runtimeSource Harmless executable-shaped source file.
 * @param runtimeIdentity Exact fixture runtime identity.
 * @returns Verified installed runtime and published release pair.
 */
export async function publishProductionDeliveryFixtures(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    sourceReleases: readonly [string, string],
    runtimeSource: string,
    runtimeIdentity: ReleaseRuntimeIdentity
): Promise<{
    first: PublishedProductionRelease;
    probeRuntime: () => Promise<ReleaseRuntimeIdentity>;
    runtime: InstalledProductionRuntime;
    second: PublishedProductionRelease;
}> {
    const probeRuntime = () => Promise.resolve(runtimeIdentity);
    const runtime = await installProductionRuntime(lease, paths, runtimeIdentity, {
        probeRuntime,
        sourceExecutable: runtimeSource,
    });
    const [first, second] = await Promise.all([
        publishProductionRelease(lease, paths, sourceReleases[0], runtimeIdentity),
        publishProductionRelease(lease, paths, sourceReleases[1], runtimeIdentity),
    ]);
    return { first, probeRuntime, runtime, second };
}
