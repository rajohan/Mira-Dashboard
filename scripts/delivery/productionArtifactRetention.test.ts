import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    createLocalReleaseFixture,
    createProductionTargetFixture,
    publishProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    retainProductionArtifacts,
    type ProductionArtifactReference,
    type ProductionArtifactRetentionDependencies,
} from "./productionArtifactRetention.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";

const temporaryDirectories: string[] = [];
const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const releaseA = "a".repeat(40);
const releaseB = "b".repeat(40);
const releaseC = "c".repeat(40);
const runtimeA = "d".repeat(40);
const runtimeB = "e".repeat(40);
const runtimeC = "f".repeat(40);
const runtimeOrphan = "1".repeat(40);
const runtimeVersion = "1.4.0";

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await stat(directory).catch(() => null);
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

async function projectFixture() {
    const projectRoot = await mkdtemp(
        path.join(tmpdir(), "mira-production-artifact-retention-")
    );
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    return { projectRoot, state };
}

async function immutableTree(directory: string, fileName: string): Promise<void> {
    await mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, fileName);
    await writeFile(file, "fixture", { mode: 0o600 });
    await chmod(file, fileName === "bun" ? 0o500 : 0o400);
    await chmod(directory, 0o500);
}

async function releaseFixture(releasesDirectory: string, releaseId: string) {
    await immutableTree(path.join(releasesDirectory, releaseId), "artifact");
}

async function runtimeFixture(runtimesDirectory: string, revision: string) {
    const bunRoot = path.join(runtimesDirectory, "bun");
    await mkdir(bunRoot, { mode: 0o700 }).catch(() => {});
    await immutableTree(path.join(bunRoot, revision), "bun");
}

function retentionDependencies(
    releaseRuntimes: ReadonlyMap<string, string>
): ProductionArtifactRetentionDependencies {
    return {
        verifyRelease: (paths, releaseId) => {
            const revision = releaseRuntimes.get(releaseId);
            if (!revision) return Promise.reject(new Error("unknown release"));
            return Promise.resolve({
                manifest: {
                    runtime: { revision, version: runtimeVersion },
                    source: { commitSha: releaseId },
                },
                releaseRoot: path.join(paths.releasesDirectory, releaseId),
            } as unknown as PublishedProductionRelease);
        },
        verifyRuntime: (paths, revision) =>
            Promise.resolve({
                executable: path.join(paths.runtimesDirectory, "bun", revision, "bun"),
                identity: { revision, version: runtimeVersion },
            } satisfies InstalledProductionRuntime),
    };
}

const protectedReferences: readonly ProductionArtifactReference[] = Object.freeze([
    { releaseId: releaseA, runtimeRevision: runtimeA },
    { releaseId: releaseB, runtimeRevision: runtimeB },
]);

describe("production release and runtime retention", () => {
    test("uses real manifest and runtime verification before retiring an old release", async () => {
        const runtimeIdentity = Object.freeze({
            revision: runtimeA,
            version: runtimeVersion,
        });
        const sourceReleases = await Promise.all([
            createLocalReleaseFixture(
                sourceProjectRoot,
                releaseA,
                runtimeIdentity,
                temporaryDirectories
            ),
            createLocalReleaseFixture(
                sourceProjectRoot,
                releaseB,
                runtimeIdentity,
                temporaryDirectories
            ),
        ] as const);
        const { projectRoot, runtimeSource } =
            await createProductionTargetFixture(temporaryDirectories);
        const state = await prepareProtectedProductionStatePath(projectRoot);

        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const published = await publishProductionDeliveryFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource,
                runtimeIdentity
            );

            await retainProductionArtifacts(
                lease,
                paths,
                [
                    {
                        releaseId: published.first.manifest.source.commitSha,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                ],
                {
                    runtimeVerification: {
                        probeRuntime: published.probeRuntime,
                    },
                }
            );

            const retainedReleases = await readdir(paths.releasesDirectory);
            expect(retainedReleases.toSorted()).toEqual([releaseA]);
            expect(await readdir(path.join(paths.runtimesDirectory, "bun"))).toEqual([
                runtimeA,
            ]);
        });
    }, 15_000);

    test("retains only active, rollback, and pointer-referenced immutable artifacts", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            for (const releaseId of [releaseA, releaseB, releaseC]) {
                await releaseFixture(paths.releasesDirectory, releaseId);
            }
            for (const revision of [runtimeA, runtimeB, runtimeC, runtimeOrphan]) {
                await runtimeFixture(paths.runtimesDirectory, revision);
            }
            await Promise.all([
                symlink(releaseA, path.join(paths.releasesDirectory, "current")),
                symlink(runtimeA, path.join(paths.runtimesDirectory, "bun", "current")),
            ]);

            await retainProductionArtifacts(
                lease,
                paths,
                protectedReferences,
                retentionDependencies(
                    new Map([
                        [releaseA, runtimeA],
                        [releaseB, runtimeB],
                        [releaseC, runtimeC],
                    ])
                )
            );

            const retainedReleases = await readdir(paths.releasesDirectory);
            const retainedRuntimes = await readdir(
                path.join(paths.runtimesDirectory, "bun")
            );
            expect(retainedReleases.toSorted()).toEqual([releaseA, releaseB, "current"]);
            expect(retainedRuntimes.toSorted()).toEqual(["current", runtimeA, runtimeB]);
        });
    });

    test("reaps crash-left pointer stages after both managed roots verify", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await releaseFixture(paths.releasesDirectory, releaseC);
            await runtimeFixture(paths.runtimesDirectory, runtimeC);
            const releaseStage = `.current-${Bun.randomUUIDv7()}`;
            const runtimeStage = `.current-${Bun.randomUUIDv7()}`;
            await Promise.all([
                symlink(releaseC, path.join(paths.releasesDirectory, releaseStage)),
                symlink(
                    runtimeC,
                    path.join(paths.runtimesDirectory, "bun", runtimeStage)
                ),
            ]);

            await retainProductionArtifacts(
                lease,
                paths,
                [{ releaseId: releaseC, runtimeRevision: runtimeC }],
                retentionDependencies(new Map([[releaseC, runtimeC]]))
            );

            expect(await readdir(paths.releasesDirectory)).toEqual([releaseC]);
            expect(await readdir(path.join(paths.runtimesDirectory, "bun"))).toEqual([
                runtimeC,
            ]);
        });
    });

    test("rejects an untrusted pointer stage before removing a valid stage", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await releaseFixture(paths.releasesDirectory, releaseC);
            await runtimeFixture(paths.runtimesDirectory, runtimeC);
            const releaseStage = `.current-${Bun.randomUUIDv7()}`;
            const runtimeStage = `.current-${Bun.randomUUIDv7()}`;
            await Promise.all([
                symlink(releaseC, path.join(paths.releasesDirectory, releaseStage)),
                symlink(
                    "../outside",
                    path.join(paths.runtimesDirectory, "bun", runtimeStage)
                ),
            ]);

            const failure = await rejectionError(
                retainProductionArtifacts(
                    lease,
                    paths,
                    [{ releaseId: releaseC, runtimeRevision: runtimeC }],
                    retentionDependencies(new Map([[releaseC, runtimeC]]))
                )
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readdir(paths.releasesDirectory)).toContain(releaseStage);
            expect(await readdir(path.join(paths.runtimesDirectory, "bun"))).toContain(
                runtimeStage
            );
        });
    });

    test("fails before pruning when the release root contains an unknown entry", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await releaseFixture(paths.releasesDirectory, releaseC);
            await writeFile(path.join(paths.releasesDirectory, "unexpected"), "fixture");

            const failure = await rejectionError(
                retainProductionArtifacts(
                    lease,
                    paths,
                    [],
                    retentionDependencies(new Map([[releaseC, runtimeC]]))
                )
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readdir(path.join(paths.releasesDirectory, releaseC))).toEqual([
                "artifact",
            ]);
        });
    });

    test("verifies the runtime root before pruning a valid stale release", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await releaseFixture(paths.releasesDirectory, releaseC);
            await runtimeFixture(paths.runtimesDirectory, runtimeC);
            await writeFile(
                path.join(paths.runtimesDirectory, "bun", "unexpected"),
                "fixture"
            );

            const failure = await rejectionError(
                retainProductionArtifacts(
                    lease,
                    paths,
                    [],
                    retentionDependencies(new Map([[releaseC, runtimeC]]))
                )
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readdir(path.join(paths.releasesDirectory, releaseC))).toEqual([
                "artifact",
            ]);
            expect(
                await readdir(path.join(paths.runtimesDirectory, "bun", runtimeC))
            ).toEqual(["bun"]);
        });
    });

    test("does not remove a replacement swapped into a selected release path", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const stale = path.join(paths.releasesDirectory, releaseC);
            const moved = path.join(paths.releasesDirectory, `.raced-${releaseC}`);
            await releaseFixture(paths.releasesDirectory, releaseC);
            await runtimeFixture(paths.runtimesDirectory, runtimeC);
            const dependencies = retentionDependencies(new Map([[releaseC, runtimeC]]));

            const failure = await rejectionError(
                retainProductionArtifacts(lease, paths, [], {
                    ...dependencies,
                    beforeEntryRetired: async (kind, identity) => {
                        expect([kind, identity]).toEqual(["release", releaseC]);
                        await rename(stale, moved);
                        await releaseFixture(paths.releasesDirectory, releaseC);
                    },
                })
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readdir(stale)).toEqual(["artifact"]);
        });
    });

    test("rejects a same-device nested mount before reaping any validated tree", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const ordinaryRetired = path.join(
                paths.releasesDirectory,
                `.retire-${releaseB}`
            );
            const mountedRetired = path.join(
                paths.releasesDirectory,
                `.retire-${releaseC}`
            );
            const nestedMount = path.join(mountedRetired, "nested");
            await immutableTree(ordinaryRetired, "artifact");
            await mkdir(mountedRetired, { mode: 0o700 });
            await immutableTree(nestedMount, "artifact");
            await chmod(mountedRetired, 0o500);
            const canonicalNestedMount = await realpath(nestedMount);

            const failure = await rejectionError(
                retainProductionArtifacts(lease, paths, [], {
                    ...retentionDependencies(new Map()),
                    readMountId: async (fileDescriptor) =>
                        (await realpath(`/proc/self/fd/${fileDescriptor}`)) ===
                        canonicalNestedMount
                            ? 2n
                            : 1n,
                })
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readdir(ordinaryRetired)).toEqual(["artifact"]);
            expect(await readdir(nestedMount)).toEqual(["artifact"]);
        });
    });

    test("does not remove a replacement swapped in before a file is retired", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const retiredTree = path.join(paths.releasesDirectory, `.retire-${releaseC}`);
            const artifact = path.join(retiredTree, "artifact");
            const selected = path.join(retiredTree, "selected");
            await immutableTree(retiredTree, "artifact");

            const failure = await rejectionError(
                retainProductionArtifacts(lease, paths, [], {
                    ...retentionDependencies(new Map()),
                    beforeFileRetired: async (fileName) => {
                        expect(fileName).toBe("artifact");
                        await rename(artifact, selected);
                        await writeFile(artifact, "replacement", { mode: 0o600 });
                        await chmod(artifact, 0o400);
                    },
                })
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readFile(selected, "utf8")).toBe("fixture");
            expect(await readFile(artifact, "utf8")).toBe("replacement");
        });
    });

    test("does not unlink a replacement swapped into the private file tombstone", async () => {
        // This hook precedes the descriptor/path revalidation and proves observed drift fails
        // closed. Linux has no later inode-conditional unlink; authorized same-UID writers are
        // serialized by the deployment lease as documented by the production boundary.
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const retiredTree = path.join(paths.releasesDirectory, `.retire-${releaseC}`);
            const selected = path.join(retiredTree, "selected");
            let replacementPath: string | undefined;
            await immutableTree(retiredTree, "artifact");

            const failure = await rejectionError(
                retainProductionArtifacts(lease, paths, [], {
                    ...retentionDependencies(new Map()),
                    afterFileRetired: async (fileName, retiredName) => {
                        expect(fileName).toBe("artifact");
                        replacementPath = path.join(retiredTree, retiredName);
                        await rename(replacementPath, selected);
                        await writeFile(replacementPath, "replacement", {
                            mode: 0o600,
                        });
                        await chmod(replacementPath, 0o400);
                    },
                })
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readFile(selected, "utf8")).toBe("fixture");
            expect(replacementPath).toBeDefined();
            expect(await readFile(replacementPath!, "utf8")).toBe("replacement");
        });
    });

    test("reaps bounded crash-left release and runtime retire trees", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await immutableTree(
                path.join(paths.releasesDirectory, `.retire-${releaseC}`),
                "artifact"
            );
            const bunRoot = path.join(paths.runtimesDirectory, "bun");
            await mkdir(bunRoot, { mode: 0o700 });
            await immutableTree(path.join(bunRoot, `.retire-${runtimeC}`), "bun");

            await retainProductionArtifacts(
                lease,
                paths,
                [],
                retentionDependencies(new Map())
            );

            expect(await readdir(paths.releasesDirectory)).toEqual([]);
            expect(await readdir(bunRoot)).toEqual([]);
        });
    });

    test("reaps crash-retired twins after the same identities are published again", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await Promise.all([
                releaseFixture(paths.releasesDirectory, releaseC),
                immutableTree(
                    path.join(paths.releasesDirectory, `.retire-${releaseC}`),
                    "artifact"
                ),
            ]);
            const bunRoot = path.join(paths.runtimesDirectory, "bun");
            await mkdir(bunRoot, { mode: 0o700 });
            await Promise.all([
                immutableTree(path.join(bunRoot, runtimeC), "bun"),
                immutableTree(path.join(bunRoot, `.retire-${runtimeC}`), "bun"),
            ]);

            await retainProductionArtifacts(
                lease,
                paths,
                [{ releaseId: releaseC, runtimeRevision: runtimeC }],
                retentionDependencies(new Map([[releaseC, runtimeC]]))
            );

            expect(await readdir(paths.releasesDirectory)).toEqual([releaseC]);
            expect(await readdir(bunRoot)).toEqual([runtimeC]);
        });
    });

    test("rejects an undocumented previous pointer before pruning", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await releaseFixture(paths.releasesDirectory, releaseC);
            await runtimeFixture(paths.runtimesDirectory, runtimeC);
            await symlink(releaseC, path.join(paths.releasesDirectory, "previous"));

            const failure = await rejectionError(
                retainProductionArtifacts(
                    lease,
                    paths,
                    [{ releaseId: releaseC, runtimeRevision: runtimeC }],
                    retentionDependencies(new Map([[releaseC, runtimeC]]))
                )
            );

            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readdir(path.join(paths.releasesDirectory, releaseC))).toEqual([
                "artifact",
            ]);
        });
    });

    test("resumes after a crash immediately following the retire rename", async () => {
        const { state } = await projectFixture();
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await releaseFixture(paths.releasesDirectory, releaseC);
            await runtimeFixture(paths.runtimesDirectory, runtimeC);
            const dependencies = retentionDependencies(new Map([[releaseC, runtimeC]]));

            const failure = await rejectionError(
                retainProductionArtifacts(lease, paths, [], {
                    ...dependencies,
                    afterEntryRetired: (kind) => {
                        if (kind === "release") throw new Error("simulated crash");
                    },
                })
            );
            expect(failure.message).toBe("Production artifact retention failed");
            expect(await readdir(paths.releasesDirectory)).toEqual([
                `.retire-${releaseC}`,
            ]);

            await retainProductionArtifacts(lease, paths, [], dependencies);

            expect(await readdir(paths.releasesDirectory)).toEqual([]);
            expect(await readdir(path.join(paths.runtimesDirectory, "bun"))).toEqual([]);
        });
    });
});
