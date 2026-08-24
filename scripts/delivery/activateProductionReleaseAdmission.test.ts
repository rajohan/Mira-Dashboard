import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import type { ReleaseManifest } from "../../src/shared/releaseManifest.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import {
    deliverProductionReleaseUnderLease,
    type ActivateProductionReleaseArguments,
} from "./activateProductionRelease.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    assertProductionArtifactCapacity,
    assertProductionArtifactCopyCapacity,
    productionArtifactCapacityReserveBytes,
    productionArtifactCapacityReserveInodes,
    runtimeSourceOwnershipIsTrusted,
} from "./productionArtifactCapacity.ts";
import { retainProductionArtifacts } from "./productionArtifactRetention.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import {
    prepareProductionArtifactAdmission,
    type ProductionServiceController,
} from "./productionReleaseActivation.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";

const temporaryDirectories: string[] = [];
const releaseA = "a".repeat(40);
const releaseB = "b".repeat(40);
const staleRelease = "c".repeat(40);
const runtimeA = "d".repeat(40);
const runtimeB = "e".repeat(40);
const staleRuntime = "f".repeat(40);
const runtimeVersion = "1.4.0";

function filesystemCapacity(availableBytes: bigint, availableInodes = 1_000_000n) {
    return Object.freeze({ availableBytes, availableInodes, blockSize: 4096n });
}

const services: ProductionServiceController = Object.freeze({
    provision: async () => {},
    prepare: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    verifyReady: () => Promise.resolve(),
    verifySmoke: () => Promise.resolve(),
});

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await lstat(directory).catch(() => null);
    if (!status?.isDirectory()) return;
    await chmod(directory, 0o700).catch(() => {});
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await restoreOwnerWrite(entryPath);
        } else if (entry.isFile()) {
            await chmod(entryPath, 0o600).catch(() => {});
        }
    }
}

async function createFixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-production-admission-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "mira-release-source-"));
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "mira-runtime-source-"));
    temporaryDirectories.push(projectRoot, sourceRoot, runtimeRoot);
    const releaseRoot = path.join(sourceRoot, "release");
    const runtimeSource = path.join(runtimeRoot, "bun");
    await mkdir(releaseRoot, { mode: 0o700 });
    await writeFile(path.join(releaseRoot, "artifact"), "release", { mode: 0o600 });
    await writeFile(runtimeSource, "runtime", { mode: 0o500 });
    await chmod(runtimeSource, 0o500);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    return { projectRoot, releaseRoot, runtimeSource, state };
}

function manifest(releaseId: string, runtimeRevision: string): ReleaseManifest {
    return {
        runtime: { revision: runtimeRevision, version: runtimeVersion },
        source: { commitSha: releaseId },
    } as unknown as ReleaseManifest;
}

function options(
    projectRoot: string,
    releaseRoot: string,
    runtimeSource: string
): ActivateProductionReleaseArguments {
    return Object.freeze({
        projectRoot,
        readinessUrl: "http://127.0.0.1:3100/api/health/ready",
        releaseRoot,
        runtimeSource,
    });
}

async function immutableTree(
    directory: string,
    fileName: string,
    fileMode: number
): Promise<void> {
    await mkdir(directory, { mode: 0o700, recursive: true });
    const file = path.join(directory, fileName);
    await writeFile(file, "fixture", { mode: 0o600 });
    await chmod(file, fileMode);
    await chmod(directory, 0o500);
}

describe("production artifact pre-admission lifecycle", () => {
    test("admits a root-owned bootstrap runtime only under root-controlled ancestors", () => {
        expect(runtimeSourceOwnershipIsTrusted(0n, 1000n, 0o755n, true)).toBeTrue();
        expect(runtimeSourceOwnershipIsTrusted(0n, 1000n, 0o755n, false)).toBeFalse();
        expect(runtimeSourceOwnershipIsTrusted(0n, 1000n, 0o775n, true)).toBeFalse();
        expect(runtimeSourceOwnershipIsTrusted(1000n, 1000n, 0o500n, false)).toBeTrue();
    });

    test("activates only after admission, install, and publication settle", async () => {
        const fixture = await createFixture();
        await withDeploymentLease(fixture.state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(fixture.state);
            const candidateManifest = manifest(releaseA, runtimeA);
            const events: string[] = [];
            const transitionId = "019fd974-54a2-74dd-a64b-d4186f8d8828";
            const activation = {
                current: { releaseId: releaseA, runtimeRevision: runtimeA },
                formatVersion: 1 as const,
                previous: null,
                transitionId,
            };

            const result = await deliverProductionReleaseUnderLease(
                lease,
                paths,
                options(fixture.projectRoot, fixture.releaseRoot, fixture.runtimeSource),
                candidateManifest,
                services,
                {
                    activateRelease: () => {
                        events.push("activate");
                        return Effect.succeed(activation);
                    },
                    artifactAdmission: () => {
                        events.push("retain");
                        return Promise.resolve();
                    },
                    capacityAdmission: () => {
                        events.push("capacity");
                        return Promise.resolve();
                    },
                    installRuntime: () => {
                        events.push("install");
                        return Promise.resolve({
                            executable: path.join(
                                paths.runtimesDirectory,
                                "bun",
                                runtimeA,
                                "bun"
                            ),
                            identity: candidateManifest.runtime,
                        });
                    },
                    publishRelease: () => {
                        events.push("publish");
                        return Promise.resolve({
                            manifest: candidateManifest,
                            releaseRoot: path.join(paths.releasesDirectory, releaseA),
                        });
                    },
                }
            );

            expect(result).toEqual(activation);
            expect(events).toEqual([
                "retain",
                "capacity",
                "install",
                "publish",
                "activate",
            ]);
        });
    });

    test("cleans every distinct installed runtime after repeated publication failure", async () => {
        const fixture = await createFixture();
        await withDeploymentLease(fixture.state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(fixture.state);
            const installed = new Set<string>([staleRuntime]);
            const events: string[] = [];
            const dependencies = {
                artifactAdmission: () => {
                    events.push("retain");
                    installed.clear();
                    return Promise.resolve();
                },
                capacityAdmission: () => {
                    events.push("capacity");
                    expect(installed.size).toBe(0);
                    return Promise.resolve();
                },
                installRuntime: (
                    _lease: typeof lease,
                    _paths: typeof paths,
                    identity: ReleaseRuntimeIdentity
                ) => {
                    events.push(`install:${identity.revision}`);
                    installed.add(identity.revision);
                    return Promise.resolve({
                        executable: path.join(
                            paths.runtimesDirectory,
                            "bun",
                            identity.revision,
                            "bun"
                        ),
                        identity,
                    } satisfies InstalledProductionRuntime);
                },
                publishRelease: () => {
                    events.push("publish-failed");
                    return Promise.reject(new Error("simulated publication failure"));
                },
            };

            for (const [releaseId, runtimeRevision] of [
                [releaseA, runtimeA],
                [releaseB, runtimeB],
            ] as const) {
                const failure = await rejectionError(
                    deliverProductionReleaseUnderLease(
                        lease,
                        paths,
                        options(
                            fixture.projectRoot,
                            fixture.releaseRoot,
                            fixture.runtimeSource
                        ),
                        manifest(releaseId, runtimeRevision),
                        services,
                        dependencies
                    )
                );
                expect(failure.message).toBe("Production release activation failed");
                expect(installed.size).toBe(0);
            }

            expect(events).toEqual([
                "retain",
                "capacity",
                `install:${runtimeA}`,
                "publish-failed",
                "retain",
                "retain",
                "capacity",
                `install:${runtimeB}`,
                "publish-failed",
                "retain",
            ]);
        });
    });

    test("reaps verified stale artifacts before evaluating low-space capacity", async () => {
        const fixture = await createFixture();
        await withDeploymentLease(fixture.state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(fixture.state);
            await immutableTree(
                path.join(paths.releasesDirectory, staleRelease),
                "artifact",
                0o400
            );
            await immutableTree(
                path.join(paths.runtimesDirectory, "bun", staleRuntime),
                "bun",
                0o500
            );
            const staleReleasePath = path.join(paths.releasesDirectory, staleRelease);
            const staleRuntimePath = path.join(
                paths.runtimesDirectory,
                "bun",
                staleRuntime
            );
            const candidateManifest = manifest(releaseA, runtimeA);
            const availableCapacity = async () => {
                const staleExists =
                    (await lstat(staleReleasePath).catch(() => null)) !== null ||
                    (await lstat(staleRuntimePath).catch(() => null)) !== null;
                return filesystemCapacity(
                    staleExists
                        ? 0n
                        : productionArtifactCapacityReserveBytes + 1024n * 1024n
                );
            };
            const capacityDependencies = {
                availableCapacity,
                verifySourceRelease: () => Promise.resolve(candidateManifest),
            };

            const preRetentionFailure = await rejectionError(
                assertProductionArtifactCapacity(
                    lease,
                    paths,
                    fixture.releaseRoot,
                    candidateManifest,
                    fixture.runtimeSource,
                    capacityDependencies
                )
            );
            expect(preRetentionFailure.message).toBe(
                "Production artifact capacity admission failed"
            );

            const artifactAdmission: typeof prepareProductionArtifactAdmission = (
                activeLease,
                activePaths,
                dependencies
            ) =>
                prepareProductionArtifactAdmission(activeLease, activePaths, {
                    ...dependencies,
                    artifactRetention: (retentionLease, retentionPaths, references) =>
                        retainProductionArtifacts(
                            retentionLease,
                            retentionPaths,
                            references,
                            {
                                verifyRelease: (_verifiedPaths, releaseId) =>
                                    Promise.resolve({
                                        manifest: manifest(releaseId, staleRuntime),
                                        releaseRoot: path.join(
                                            retentionPaths.releasesDirectory,
                                            releaseId
                                        ),
                                    } as PublishedProductionRelease),
                                verifyRuntime: (_verifiedPaths, revision) =>
                                    Promise.resolve({
                                        executable: path.join(
                                            retentionPaths.runtimesDirectory,
                                            "bun",
                                            revision,
                                            "bun"
                                        ),
                                        identity: {
                                            revision,
                                            version: runtimeVersion,
                                        },
                                    }),
                            }
                        ),
                });
            let capacityChecks = 0;
            const failure = await rejectionError(
                deliverProductionReleaseUnderLease(
                    lease,
                    paths,
                    options(
                        fixture.projectRoot,
                        fixture.releaseRoot,
                        fixture.runtimeSource
                    ),
                    candidateManifest,
                    services,
                    {
                        artifactAdmission,
                        capacityAdmission: (
                            activeLease,
                            activePaths,
                            sourceReleaseRoot,
                            sourceManifest,
                            sourceExecutable
                        ) => {
                            capacityChecks += 1;
                            return assertProductionArtifactCapacity(
                                activeLease,
                                activePaths,
                                sourceReleaseRoot,
                                sourceManifest,
                                sourceExecutable,
                                {
                                    availableCapacity,
                                    verifySourceRelease: () =>
                                        Promise.resolve(sourceManifest),
                                }
                            );
                        },
                        installRuntime: () =>
                            Promise.reject(new Error("simulated install failure")),
                    }
                )
            );

            expect(failure.message).toBe("Production release activation failed");
            expect(capacityChecks).toBe(1);
            expect(await lstat(staleReleasePath).catch(() => null)).toBeNull();
            expect(await lstat(staleRuntimePath).catch(() => null)).toBeNull();
        });
    });

    test("does not charge current immutable slots a second time", async () => {
        const fixture = await createFixture();
        await withDeploymentLease(fixture.state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(fixture.state);
            await immutableTree(
                path.join(paths.releasesDirectory, releaseA),
                "artifact",
                0o400
            );
            await immutableTree(
                path.join(paths.runtimesDirectory, "bun", runtimeA),
                "bun",
                0o500
            );
            let capacityMeasurements = 0;

            await assertProductionArtifactCapacity(
                lease,
                paths,
                fixture.releaseRoot,
                manifest(releaseA, runtimeA),
                fixture.runtimeSource,
                {
                    availableCapacity: () => {
                        capacityMeasurements += 1;
                        return Promise.resolve(filesystemCapacity(0n));
                    },
                    verifySourceRelease: () =>
                        Promise.resolve(manifest(releaseA, runtimeA)),
                }
            );

            expect(capacityMeasurements).toBe(0);
        });
    });

    test("fails closed when the supplied identity does not match the source tree", async () => {
        const fixture = await createFixture();
        await withDeploymentLease(fixture.state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(fixture.state);
            const failure = await rejectionError(
                assertProductionArtifactCapacity(
                    lease,
                    paths,
                    fixture.releaseRoot,
                    manifest(releaseA, runtimeA),
                    fixture.runtimeSource,
                    {
                        availableCapacity: () =>
                            Promise.resolve(
                                filesystemCapacity(
                                    productionArtifactCapacityReserveBytes + 1024n * 1024n
                                )
                            ),
                        verifySourceRelease: () =>
                            Promise.resolve(manifest(releaseB, runtimeB)),
                    }
                )
            );

            expect(failure.message).toBe("Production artifact capacity admission failed");
        });
    });

    test("charges allocation blocks for many tiny files instead of logical bytes", async () => {
        const fixture = await createFixture();
        const paths = await prepareProductionDeliveryDirectories(fixture.state);
        const fileBytes = Object.freeze(Array.from({ length: 100 }, () => 1n));
        const failure = await rejectionError(
            assertProductionArtifactCopyCapacity(
                paths.productionDirectory,
                Object.freeze({ fileBytes, newDirectoryCount: 1n }),
                {
                    availableCapacity: () =>
                        Promise.resolve(
                            filesystemCapacity(
                                productionArtifactCapacityReserveBytes + 100n
                            )
                        ),
                }
            )
        );

        expect(failure.message).toBe("Production artifact capacity admission failed");
    });

    test("preserves a fixed free-inode reserve", async () => {
        const fixture = await createFixture();
        const paths = await prepareProductionDeliveryDirectories(fixture.state);
        const objectCount = 3n;
        const failure = await rejectionError(
            assertProductionArtifactCopyCapacity(
                paths.productionDirectory,
                Object.freeze({
                    fileBytes: Object.freeze([4096n, 4096n]),
                    newDirectoryCount: 1n,
                }),
                {
                    availableCapacity: () =>
                        Promise.resolve(
                            filesystemCapacity(
                                productionArtifactCapacityReserveBytes + 1024n * 1024n,
                                objectCount + productionArtifactCapacityReserveInodes - 1n
                            )
                        ),
                }
            )
        );

        expect(failure.message).toBe("Production artifact capacity admission failed");
    });
});
