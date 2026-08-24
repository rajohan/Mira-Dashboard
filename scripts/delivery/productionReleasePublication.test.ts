import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    setDefaultTimeout,
    test,
} from "bun:test";
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

import { releaseBuildCommands } from "../../src/shared/releaseManifest.ts";
import type { BuildSourceIdentity } from "../buildSourceIdentity.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { buildDashboardRelease, type ReleaseBuildCommand } from "./buildRelease.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    assertProductionArtifactCapacity,
    productionArtifactCapacityReserveBytes,
} from "./productionArtifactCapacity.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { publishProductionRelease } from "./productionReleasePublication.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import {
    type ReleaseRuntimeIdentity,
    verifyReleaseArtifactIdentity,
} from "./releaseIdentity.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];
const commitSha = "b".repeat(40);
const cleanSource: BuildSourceIdentity = Object.freeze({
    commitSha,
    commitTitle: "Test release",
    state: "clean",
});
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "a".repeat(40),
    version: "1.4.0",
});
const releaseFixtureDirectories: string[] = [];
const documentationFixture = "# Production release publication fixture\n";
let sharedSourceReleaseRoot: string | undefined;

setDefaultTimeout(15_000);

function filesystemCapacity(availableBytes: bigint) {
    return Object.freeze({
        availableBytes,
        availableInodes: 1_000_000n,
        blockSize: 4096n,
    });
}

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

afterEach(async () => {
    await removeDirectories(temporaryDirectories);
});

beforeAll(async () => {
    sharedSourceReleaseRoot = await localReleaseFixture();
});

afterAll(async () => {
    await removeDirectories(releaseFixtureDirectories);
});

async function removeDirectories(directories: string[]): Promise<void> {
    for (const directory of directories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
}

function sourceReleaseFixture(): string {
    if (sharedSourceReleaseRoot === undefined) {
        throw new Error("Production release fixture is not initialized");
    }
    return sharedSourceReleaseRoot;
}

async function repositoryFixture(): Promise<string> {
    const repositoryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-production-release-source-")
    );
    releaseFixtureDirectories.push(repositoryRoot);
    await mkdir(path.join(repositoryRoot, "docs/generated"), { recursive: true });
    await Promise.all([
        writeFile(
            path.join(repositoryRoot, "docs/generated/README.md"),
            documentationFixture
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
    return repositoryRoot;
}

async function materializeCommandOutput(
    command: ReleaseBuildCommand,
    repositoryRoot: string
): Promise<void> {
    if (command === "bun run build browser") {
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
    if (command === "bun run build processes") {
        await mkdir(path.join(repositoryRoot, "dist/processes"), { recursive: true });
        await Promise.all([
            writeFile(
                path.join(repositoryRoot, "dist/processes/databaseMaintenance.js"),
                "database-maintenance"
            ),
            writeFile(
                path.join(repositoryRoot, "dist/processes/productionDelivery.js"),
                "production-delivery"
            ),
            writeFile(
                path.join(repositoryRoot, "dist/processes/productionProvisioning.js"),
                "production-provisioning"
            ),
            writeFile(
                path.join(repositoryRoot, "dist/processes/openClawHeartbeat.js"),
                "openclaw-heartbeat"
            ),
            writeFile(path.join(repositoryRoot, "dist/processes/web.js"), "web"),
            writeFile(path.join(repositoryRoot, "dist/processes/worker.js"), "worker"),
        ]);
    }
}

async function localReleaseFixture(): Promise<string> {
    const repositoryRoot = await repositoryFixture();
    const observedCommands: ReleaseBuildCommand[] = [];
    const release = await buildDashboardRelease(repositoryRoot, {
        resolveSourceIdentity: () => Promise.resolve(cleanSource),
        runCommand: async (command, root) => {
            observedCommands.push(command);
            await materializeCommandOutput(command, root);
        },
        runtimeIdentity,
    });
    expect(observedCommands).toEqual(releaseBuildCommands);
    return release.releaseRoot;
}

async function productionProjectFixture(): Promise<string> {
    const projectRoot = await mkdtemp(
        path.join(tmpdir(), "mira-production-release-target-")
    );
    temporaryDirectories.push(projectRoot);
    return projectRoot;
}

describe("production release publication", () => {
    test("publishes one immutable commit release idempotently under the project root", async () => {
        const sourceReleaseRoot = sourceReleaseFixture();
        const projectRoot = await productionProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const first = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const publication = await publishProductionRelease(
                lease,
                paths,
                sourceReleaseRoot,
                runtimeIdentity
            );
            return { paths, publication };
        });
        const second = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            return publishProductionRelease(
                lease,
                paths,
                sourceReleaseRoot,
                runtimeIdentity
            );
        });

        expect(first.publication.releaseRoot).toBe(
            path.join(first.paths.releasesDirectory, commitSha)
        );
        expect(second).toEqual(first.publication);
        const releaseStatus = await stat(first.publication.releaseRoot);
        const manifestStatus = await stat(
            path.join(first.publication.releaseRoot, "release-manifest.json")
        );
        expect(releaseStatus.mode & 0o777).toBe(0o500);
        expect(manifestStatus.mode & 0o777).toBe(0o400);
        expect(await readdir(first.paths.releasesDirectory)).toEqual([commitSha]);
    });

    test("rejects staged tampering and removes only its owned candidate", async () => {
        const sourceReleaseRoot = sourceReleaseFixture();
        const projectRoot = await productionProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const result = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const failure = await rejectionError(
                publishProductionRelease(
                    lease,
                    paths,
                    sourceReleaseRoot,
                    runtimeIdentity,
                    {
                        afterCopy: (stagingRoot) =>
                            writeFile(
                                path.join(stagingRoot, "server/web.js"),
                                "tampered"
                            ),
                    }
                )
            );
            return { failure, paths };
        });

        expect(result.failure.message).toBe("Production release publication failed");
        expect(await readdir(result.paths.releasesDirectory)).toEqual([]);
    });

    test("rejects source growth after outer capacity admission before writing a stage", async () => {
        const sourceReleaseRoot = await localReleaseFixture();
        const projectRoot = await productionProjectFixture();
        const runtimeRoot = await mkdtemp(
            path.join(tmpdir(), "mira-publication-runtime-source-")
        );
        temporaryDirectories.push(runtimeRoot);
        const runtimeSource = path.join(runtimeRoot, "bun");
        await writeFile(runtimeSource, "runtime", { mode: 0o500 });
        await chmod(runtimeSource, 0o500);
        const sourceManifest = await verifyReleaseArtifactIdentity(sourceReleaseRoot);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const result = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await assertProductionArtifactCapacity(
                lease,
                paths,
                sourceReleaseRoot,
                sourceManifest,
                runtimeSource,
                {
                    availableCapacity: () =>
                        Promise.resolve(
                            filesystemCapacity(
                                productionArtifactCapacityReserveBytes +
                                    1024n * 1024n * 1024n
                            )
                        ),
                }
            );
            let inlineCapacityChecks = 0;
            const failure = await rejectionError(
                publishProductionRelease(
                    lease,
                    paths,
                    sourceReleaseRoot,
                    runtimeIdentity,
                    {
                        availableCapacity: () => {
                            inlineCapacityChecks += 1;
                            return Promise.resolve(
                                filesystemCapacity(
                                    productionArtifactCapacityReserveBytes + 1n
                                )
                            );
                        },
                        beforeCopy: async () => {
                            const sourceFile = path.join(
                                sourceReleaseRoot,
                                "server/web.js"
                            );
                            await chmod(sourceFile, 0o600);
                            await writeFile(sourceFile, "grown-after-admission");
                            await chmod(sourceFile, 0o400);
                        },
                    }
                )
            );
            return { failure, inlineCapacityChecks, paths };
        });

        expect(result.failure.message).toBe("Production release publication failed");
        expect(result.inlineCapacityChecks).toBe(0);
        expect(await readdir(result.paths.releasesDirectory)).toEqual([]);
    });

    test("rechecks current free space immediately before copying a stable release", async () => {
        const sourceReleaseRoot = sourceReleaseFixture();
        const projectRoot = await productionProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const result = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            let inlineCapacityChecks = 0;
            const failure = await rejectionError(
                publishProductionRelease(
                    lease,
                    paths,
                    sourceReleaseRoot,
                    runtimeIdentity,
                    {
                        availableCapacity: () => {
                            inlineCapacityChecks += 1;
                            return Promise.resolve(
                                filesystemCapacity(productionArtifactCapacityReserveBytes)
                            );
                        },
                    }
                )
            );
            return { failure, inlineCapacityChecks, paths };
        });

        expect(result.failure.message).toBe("Production release publication failed");
        expect(result.inlineCapacityChecks).toBe(1);
        expect(await readdir(result.paths.releasesDirectory)).toEqual([]);
    });

    test("never overwrites or removes a pre-existing commit path", async () => {
        const sourceReleaseRoot = sourceReleaseFixture();
        const projectRoot = await productionProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const result = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const existing = path.join(paths.releasesDirectory, commitSha);
            await mkdir(existing, { mode: 0o500 });
            const failure = await rejectionError(
                publishProductionRelease(lease, paths, sourceReleaseRoot, runtimeIdentity)
            );
            return { existing, failure };
        });

        expect(result.failure.message).toBe("Production release publication failed");
        const existingStatus = await stat(result.existing);
        expect(existingStatus.isDirectory()).toBeTrue();
    });
});
