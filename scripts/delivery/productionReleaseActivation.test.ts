import { Database } from "bun:sqlite";
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
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import type { ProductionActivationRecord } from "../../src/shared/productionActivationRecord.ts";
import { parseProductionActivationTransition } from "../../src/shared/productionActivationTransition.ts";
import {
    createLocalReleaseFixture,
    createProductionTargetFixture,
    executeDatabaseMaintenanceFixture,
    publishProductionDeliveryFixtures,
    removeProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import {
    runDatabaseCandidateMaintenance,
    runDatabaseSnapshotMaintenance,
} from "./databaseMaintenanceProcess.ts";
import {
    prepareDatabaseTransitionWorkspace,
    promoteDatabaseTransitionCandidate,
    verifyDatabaseTransitionCandidate,
} from "./databaseTransitionFilesystem.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    createProductionActivationJournal,
    loadProductionActivationJournal,
    markProductionDatabasePromoted,
    markProductionRollbackRequired,
    markProductionSnapshotPrepared,
} from "./productionActivationJournal.ts";
import {
    commitProductionActivationState,
    loadProductionActivationState,
} from "./productionActivationState.ts";
import type { ProductionArtifactReference } from "./productionArtifactRetention.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import {
    activatePublishedProductionRelease,
    type ProductionServiceController,
    type ProductionReleaseActivationTestHooks,
} from "./productionReleaseActivation.ts";
import { type PublishedProductionRelease } from "./productionReleasePublication.ts";
import { pointProductionProcessesAtRelease } from "./productionRuntimePointers.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const firstReleaseId = "a".repeat(40);
const secondReleaseId = "b".repeat(40);
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "c".repeat(40),
    version: "1.4.0",
});
const releaseFixtureDirectories: string[] = [];
const temporaryDirectories: string[] = [];
let sharedSourceReleases: readonly [string, string] | undefined;
let sharedPublishedFixture:
    | Readonly<{
          activatedProjectRoot: string;
          initialActivation: ProductionActivationRecord;
          firstManifest: PublishedProductionRelease["manifest"];
          projectRoot: string;
          secondManifest: PublishedProductionRelease["manifest"];
      }>
    | undefined;

setDefaultTimeout(15_000);

beforeAll(async () => {
    sharedSourceReleases = await Promise.all([
        createLocalReleaseFixture(
            sourceProjectRoot,
            firstReleaseId,
            runtimeIdentity,
            releaseFixtureDirectories
        ),
        createLocalReleaseFixture(
            sourceProjectRoot,
            secondReleaseId,
            runtimeIdentity,
            releaseFixtureDirectories
        ),
    ]);
    const { projectRoot, runtimeSource } = await createProductionTargetFixture(
        releaseFixtureDirectories
    );
    const state = await prepareProtectedProductionStatePath(projectRoot);
    sharedPublishedFixture = await withDeploymentLease(
        state.stateDirectory,
        async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const published = await publishProductionDeliveryFixtures(
                lease,
                paths,
                sourceReleaseFixtures(),
                runtimeSource,
                runtimeIdentity
            );
            const pristineProjectRoot = await mkdtemp(
                path.join(tmpdir(), "mira-release-activation-published-")
            );
            releaseFixtureDirectories.push(pristineProjectRoot);
            await cp(
                path.join(projectRoot, "production"),
                path.join(pristineProjectRoot, "production"),
                { recursive: true }
            );
            await unlink(
                path.join(pristineProjectRoot, "production/state/.deployment.lock")
            );
            const services = new TestServiceController();
            const initialActivation = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    published.first,
                    published.runtime,
                    activationDependencies(services, published.probeRuntime)
                )
            );
            return Object.freeze({
                activatedProjectRoot: projectRoot,
                firstManifest: published.first.manifest,
                initialActivation,
                projectRoot: pristineProjectRoot,
                secondManifest: published.second.manifest,
            });
        }
    );
});

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

afterAll(async () => {
    await removeProductionDeliveryFixtures(releaseFixtureDirectories);
});

function sourceReleaseFixtures(): readonly [string, string] {
    if (sharedSourceReleases === undefined) {
        throw new Error("Production release fixtures are not initialized");
    }
    return sharedSourceReleases;
}

function publishedFixtureSource() {
    if (sharedPublishedFixture === undefined) {
        throw new Error("Published production fixture is not initialized");
    }
    return sharedPublishedFixture;
}

async function createProjectFixture(initiallyActivated = true): Promise<string> {
    const fixture = publishedFixtureSource();
    const projectRoot = await mkdtemp(
        path.join(tmpdir(), "mira-release-activation-target-")
    );
    temporaryDirectories.push(projectRoot);
    await cp(
        path.join(
            initiallyActivated ? fixture.activatedProjectRoot : fixture.projectRoot,
            "production"
        ),
        path.join(projectRoot, "production"),
        { recursive: true }
    );
    return projectRoot;
}

function initialActivationFixture() {
    return publishedFixtureSource().initialActivation;
}

class TestServiceController implements ProductionServiceController {
    readonly events: string[] = [];
    onStart:
        | ((
              release: PublishedProductionRelease,
              runtime: Parameters<ProductionServiceController["start"]>[1]
          ) => Promise<void> | void)
        | undefined;
    rejectReadyReleaseId: string | undefined;
    rejectStartReleaseId: string | undefined;

    provision(release: PublishedProductionRelease): Promise<void> {
        this.events.push(`provision:${release.manifest.source.commitSha}`);
        return Promise.resolve();
    }

    prepare(release: PublishedProductionRelease): Promise<void> {
        this.events.push(`prepare:${release.manifest.source.commitSha}`);
        return Promise.resolve();
    }

    async start(
        release: PublishedProductionRelease,
        runtime: Parameters<ProductionServiceController["start"]>[1]
    ): Promise<void> {
        const releaseId = release.manifest.source.commitSha;
        this.events.push(`start:${releaseId}`);
        await this.onStart?.(release, runtime);
        if (releaseId === this.rejectStartReleaseId) {
            throw new Error("candidate partially started");
        }
    }

    stop(): Promise<void> {
        this.events.push("stop");
        return Promise.resolve();
    }

    verifyReady(release: PublishedProductionRelease): Promise<void> {
        const releaseId = release.manifest.source.commitSha;
        this.events.push(`ready:${releaseId}`);
        return releaseId === this.rejectReadyReleaseId
            ? Promise.reject(new Error("candidate not ready"))
            : Promise.resolve();
    }

    verifySmoke(release: PublishedProductionRelease): Promise<void> {
        this.events.push(`smoke:${release.manifest.source.commitSha}`);
        return Promise.resolve();
    }
}

function activationDependencies(
    services: TestServiceController,
    probeRuntime: () => Promise<ReleaseRuntimeIdentity>,
    testHooks?: ProductionReleaseActivationTestHooks,
    observeRetention?: (
        references: readonly ProductionArtifactReference[]
    ) => Promise<void> | void
) {
    return Object.freeze({
        artifactRetention: async (
            _lease: unknown,
            _paths: unknown,
            references: readonly ProductionArtifactReference[]
        ) => {
            await observeRetention?.(references);
        },
        maintenance: {
            execute: executeDatabaseMaintenanceFixture,
            runtimeVerification: { probeRuntime },
        },
        runtimeVerification: { probeRuntime },
        services,
        testHooks,
    });
}

function clonedPublishedFixtures(
    paths: Parameters<typeof publishProductionDeliveryFixtures>[1]
) {
    const fixture = publishedFixtureSource();
    const probeRuntime = () => Promise.resolve(runtimeIdentity);
    return Object.freeze({
        first: Object.freeze({
            manifest: fixture.firstManifest,
            releaseRoot: path.join(paths.releasesDirectory, firstReleaseId),
        }),
        probeRuntime,
        runtime: Object.freeze({
            executable: path.join(
                paths.runtimesDirectory,
                "bun",
                runtimeIdentity.revision,
                "bun"
            ),
            identity: runtimeIdentity,
        }),
        second: Object.freeze({
            manifest: fixture.secondManifest,
            releaseRoot: path.join(paths.releasesDirectory, secondReleaseId),
        }),
    });
}

function readMigrationReleaseId(databaseFile: string): string {
    const database = new Database(databaseFile, { readonly: true, strict: true });
    try {
        const row = database
            .query<{ releaseId: string }, []>(
                "SELECT MIN(release_id) AS releaseId FROM schema_migrations"
            )
            .get();
        if (!row) throw new Error("Missing migration ledger");
        return row.releaseId;
    } finally {
        database.close(false);
    }
}

describe("production release activation", () => {
    test("commits initial and upgraded release/database pairs under one lease", async () => {
        const projectRoot = await createProjectFixture(false);
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const retentionReferences: ProductionArtifactReference[][] = [];
            const authoritativeAtStart: Array<string | undefined> = [];
            services.onStart = async () => {
                const observed = await loadProductionActivationState(lease, paths);
                authoritativeAtStart.push(observed.record?.current.releaseId);
            };
            const dependencies = activationDependencies(
                services,
                fixtures.probeRuntime,
                undefined,
                (references) => {
                    retentionReferences.push([...references]);
                }
            );
            const initial = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies
                )
            );
            const upgraded = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.second,
                    fixtures.runtime,
                    dependencies
                )
            );

            expect(initial.current.releaseId).toBe(firstReleaseId);
            expect(initial.previous).toBeNull();
            expect(upgraded.current.releaseId).toBe(secondReleaseId);
            expect(upgraded.previous).toEqual({
                databaseSnapshotTransitionId: upgraded.transitionId,
                releaseId: firstReleaseId,
                runtimeRevision: runtimeIdentity.revision,
            });
            expect(
                readMigrationReleaseId(
                    path.join(paths.stateDirectory, "mira-dashboard.db")
                )
            ).toBe(firstReleaseId);
            expect(services.events).toEqual([
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                "stop",
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
                `smoke:${firstReleaseId}`,
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                "stop",
                `provision:${secondReleaseId}`,
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                `ready:${secondReleaseId}`,
                `smoke:${secondReleaseId}`,
            ]);
            expect(authoritativeAtStart).toEqual([undefined, firstReleaseId]);
            expect(retentionReferences).toEqual([
                [
                    {
                        releaseId: firstReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                ],
                [
                    {
                        releaseId: firstReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                ],
                [
                    {
                        releaseId: firstReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                    {
                        releaseId: secondReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                ],
                [
                    {
                        releaseId: secondReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                    {
                        releaseId: firstReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                ],
            ]);
            const activation = await loadProductionActivationState(lease, paths);
            const stateEntries = await readdir(paths.stateDirectory);
            expect(activation.record).toEqual(upgraded);
            expect(stateEntries).not.toContain("activation-transition.json");
            expect(
                stateEntries.filter((entry) => entry.startsWith(".database-transition-"))
            ).toEqual([]);
        });
    });

    test("uses caller-owned transitions and pairs rollback snapshots in both directions", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const upgradeTransitionId = Bun.randomUUIDv7();
            const upgraded = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.second,
                    fixtures.runtime,
                    dependencies,
                    { transitionId: upgradeTransitionId }
                )
            );
            expect(upgraded.transitionId).toBe(upgradeTransitionId);

            const rollbackTransitionId = Bun.randomUUIDv7();
            const rolledBack = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies,
                    {
                        targetDatabaseSnapshotTransitionId: upgradeTransitionId,
                        transitionId: rollbackTransitionId,
                    }
                )
            );
            expect(rolledBack).toEqual({
                current: {
                    releaseId: firstReleaseId,
                    runtimeRevision: runtimeIdentity.revision,
                },
                formatVersion: 1,
                previous: {
                    databaseSnapshotTransitionId: rollbackTransitionId,
                    releaseId: secondReleaseId,
                    runtimeRevision: runtimeIdentity.revision,
                },
                transitionId: rollbackTransitionId,
            });

            const returnTransitionId = Bun.randomUUIDv7();
            const returned = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.second,
                    fixtures.runtime,
                    dependencies,
                    {
                        targetDatabaseSnapshotTransitionId: rollbackTransitionId,
                        transitionId: returnTransitionId,
                    }
                )
            );
            expect(returned.current.releaseId).toBe(secondReleaseId);
            expect(returned.previous).toEqual({
                databaseSnapshotTransitionId: returnTransitionId,
                releaseId: firstReleaseId,
                runtimeRevision: runtimeIdentity.revision,
            });
        });
    });

    test("clears first-activation pointers after start or readiness failure", async () => {
        for (const failureBoundary of ["start", "readiness"] as const) {
            const projectRoot = await createProjectFixture(false);
            const state = await prepareProtectedProductionStatePath(projectRoot);
            await withDeploymentLease(state.stateDirectory, async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(state);
                const fixtures = clonedPublishedFixtures(paths);
                const services = new TestServiceController();
                services.onStart = (release, runtime) =>
                    pointProductionProcessesAtRelease(lease, paths, release, runtime);
                if (failureBoundary === "start") {
                    services.rejectStartReleaseId = firstReleaseId;
                } else {
                    services.rejectReadyReleaseId = firstReleaseId;
                }

                const failure = await rejectionError(
                    Effect.runPromise(
                        activatePublishedProductionRelease(
                            lease,
                            paths,
                            fixtures.first,
                            fixtures.runtime,
                            activationDependencies(services, fixtures.probeRuntime)
                        )
                    )
                );

                expect(failure.message).toBe("Production release activation failed");
                const rolledBack = await loadProductionActivationState(lease, paths);
                expect(rolledBack.record).toBeUndefined();
                expect(await readdir(paths.releasesDirectory)).not.toContain("current");
                expect(
                    await readdir(path.join(paths.runtimesDirectory, "bun"))
                ).not.toContain("current");

                services.rejectStartReleaseId = undefined;
                services.rejectReadyReleaseId = undefined;
                const activated = await Effect.runPromise(
                    activatePublishedProductionRelease(
                        lease,
                        paths,
                        fixtures.second,
                        fixtures.runtime,
                        {
                            maintenance: {
                                execute: executeDatabaseMaintenanceFixture,
                                runtimeVerification: {
                                    probeRuntime: fixtures.probeRuntime,
                                },
                            },
                            runtimeVerification: {
                                probeRuntime: fixtures.probeRuntime,
                            },
                            services,
                        }
                    )
                );

                expect(activated.current.releaseId).toBe(secondReleaseId);
                expect(
                    await readlink(path.join(paths.releasesDirectory, "current"))
                ).toBe(secondReleaseId);
                expect(
                    await readlink(path.join(paths.runtimesDirectory, "bun", "current"))
                ).toBe(runtimeIdentity.revision);
                expect(await readdir(paths.releasesDirectory)).not.toContain(
                    firstReleaseId
                );
            });
        }
    });

    test("restores the previous release and database when candidate readiness fails", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = initialActivationFixture();
            services.rejectReadyReleaseId = secondReleaseId;
            const failure = await rejectionError(
                Effect.runPromise(
                    activatePublishedProductionRelease(
                        lease,
                        paths,
                        fixtures.second,
                        fixtures.runtime,
                        dependencies
                    )
                )
            );

            expect(failure.message).toBe("Production release activation failed");
            const activation = await loadProductionActivationState(lease, paths);
            expect(activation.record).toEqual(initial);
            expect(
                readMigrationReleaseId(
                    path.join(paths.stateDirectory, "mira-dashboard.db")
                )
            ).toBe(firstReleaseId);
            expect(services.events.slice(-14)).toEqual([
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                "stop",
                `provision:${secondReleaseId}`,
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                `ready:${secondReleaseId}`,
                `provision:${secondReleaseId}`,
                `prepare:${secondReleaseId}`,
                "stop",
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
            ]);
            expect(await readdir(paths.stateDirectory)).not.toContain(
                "activation-transition.json"
            );
        });
    });

    test("restores the previous release and database after a partial candidate start", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = initialActivationFixture();
            services.rejectStartReleaseId = secondReleaseId;
            const partialStartFailure = await rejectionError(
                Effect.runPromise(
                    activatePublishedProductionRelease(
                        lease,
                        paths,
                        fixtures.second,
                        fixtures.runtime,
                        dependencies
                    )
                )
            );
            const activationAfterPartialStart = await loadProductionActivationState(
                lease,
                paths
            );
            expect(partialStartFailure.message).toBe(
                "Production release activation failed"
            );
            expect(activationAfterPartialStart.record).toEqual(initial);
            expect(
                readMigrationReleaseId(
                    path.join(paths.stateDirectory, "mira-dashboard.db")
                )
            ).toBe(firstReleaseId);
            expect(services.events.slice(-13)).toEqual([
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                "stop",
                `provision:${secondReleaseId}`,
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                `provision:${secondReleaseId}`,
                `prepare:${secondReleaseId}`,
                "stop",
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
            ]);
            expect(await readdir(paths.stateDirectory)).not.toContain(
                "activation-transition.json"
            );
        });
    });

    test("recovers the active service after interruption immediately after stop", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const initial = initialActivationFixture();
            let observedPhase: string | undefined;
            const failure = await rejectionError(
                Effect.runPromise(
                    activatePublishedProductionRelease(
                        lease,
                        paths,
                        fixtures.second,
                        fixtures.runtime,
                        activationDependencies(services, fixtures.probeRuntime, {
                            afterServicesStopped: async () => {
                                const observedJournal =
                                    await loadProductionActivationJournal(lease, paths);
                                observedPhase = observedJournal?.phase;
                                throw new Error("simulated process interruption");
                            },
                        })
                    )
                )
            );

            expect(failure.message).toBe("Production release activation failed");
            expect(observedPhase).toBe("service-stop-requested");
            const recoveredActivation = await loadProductionActivationState(lease, paths);
            expect(recoveredActivation.record).toEqual(initial);
            expect(await loadProductionActivationJournal(lease, paths)).toBeUndefined();
            expect(services.events.slice(-8)).toEqual([
                "stop",
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                "stop",
                `provision:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
            ]);
        });
    });

    test("keeps a committed candidate when post-commit cleanup is interrupted", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const crashStages: string[] = [];
            for (const scenario of [
                {
                    boundary: "afterActivationCommit" as const,
                    candidate: fixtures.second,
                    expectedFinalEvent: "ready" as const,
                    expectedReleaseId: secondReleaseId,
                },
                {
                    boundary: "afterActivationJournalClear" as const,
                    candidate: fixtures.first,
                    expectedFinalEvent: "smoke" as const,
                    expectedReleaseId: firstReleaseId,
                },
            ]) {
                let hookCalls = 0;
                const upgraded = await Effect.runPromise(
                    activatePublishedProductionRelease(
                        lease,
                        paths,
                        scenario.candidate,
                        fixtures.runtime,
                        activationDependencies(services, fixtures.probeRuntime, {
                            [scenario.boundary]: async () => {
                                hookCalls += 1;
                                const crashId = Bun.randomUUIDv7();
                                const crashStage = `.stage-${crashId}`;
                                crashStages.push(crashStage);
                                await mkdir(
                                    path.join(
                                        paths.stateDirectory,
                                        "backups",
                                        crashStage
                                    ),
                                    { mode: 0o700 }
                                );
                                throw new Error("simulated cleanup interruption");
                            },
                        })
                    )
                );

                const activation = await loadProductionActivationState(lease, paths);
                const stateEntries = await readdir(paths.stateDirectory);
                expect(hookCalls).toBe(1);
                expect(upgraded.current.releaseId).toBe(scenario.expectedReleaseId);
                expect(activation.record).toEqual(upgraded);
                expect(stateEntries).not.toContain("activation-transition.json");
                expect(
                    stateEntries.filter((entry) =>
                        entry.startsWith(".database-transition-")
                    )
                ).toEqual([]);
                expect(services.events.at(-1)).toBe(
                    `${scenario.expectedFinalEvent}:${scenario.expectedReleaseId}`
                );
                expect(
                    await readdir(path.join(paths.stateDirectory, "backups"))
                ).not.toContain(crashStages.at(-1));
            }
        });
    }, 15_000);

    test("reports committed retention failure and retries it on the same candidate", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const unknownEntry = path.join(
                paths.stateDirectory,
                "backups",
                "unexpected-retention-entry"
            );
            const failure = await rejectionError(
                Effect.runPromise(
                    activatePublishedProductionRelease(
                        lease,
                        paths,
                        fixtures.second,
                        fixtures.runtime,
                        activationDependencies(services, fixtures.probeRuntime, {
                            afterActivationJournalClear: async () => {
                                await writeFile(unknownEntry, "fixture", { mode: 0o600 });
                                throw new Error(
                                    "simulated interruption after journal clear"
                                );
                            },
                        })
                    )
                )
            );
            expect(failure.message).toBe("Production release activation failed");
            const committedState = await loadProductionActivationState(lease, paths);
            expect(committedState.record?.current.releaseId).toBe(secondReleaseId);

            await unlink(unknownEntry);
            const retried = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.second,
                    fixtures.runtime,
                    activationDependencies(services, fixtures.probeRuntime)
                )
            );
            expect(retried.current.releaseId).toBe(secondReleaseId);
        });
    });

    test("recovers a durable rollback request after candidate activation commit", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = initialActivationFixture();
            const previousState = await loadProductionActivationState(lease, paths);
            const transitionId = Bun.randomUUIDv7();
            const snapshot = await runDatabaseSnapshotMaintenance(
                lease,
                paths,
                fixtures.first,
                fixtures.runtime,
                transitionId,
                "present",
                dependencies.maintenance
            );
            if (snapshot.state !== "present") throw new Error("Expected snapshot");
            const stopRequested = await createProductionActivationJournal(
                lease,
                paths,
                parseProductionActivationTransition({
                    candidate: {
                        releaseId: secondReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                    formatVersion: 1,
                    phase: "service-stop-requested",
                    previousActivation: initial,
                    previousDatabase: { state: "unrecorded" },
                    transitionId,
                })
            );
            const prepared = await markProductionSnapshotPrepared(
                lease,
                paths,
                stopRequested,
                {
                    manifest: snapshot.manifest,
                    sourceDatabase: snapshot.sourceDatabase,
                    state: "present",
                }
            );
            const workspace = await prepareDatabaseTransitionWorkspace(
                lease,
                paths,
                transitionId,
                snapshot
            );
            await runDatabaseCandidateMaintenance(
                lease,
                paths,
                fixtures.second,
                fixtures.runtime,
                transitionId,
                workspace.candidateDirectory,
                dependencies.maintenance
            );
            await promoteDatabaseTransitionCandidate(
                lease,
                paths,
                await verifyDatabaseTransitionCandidate(workspace)
            );
            const promoted = await markProductionDatabasePromoted(lease, paths, prepared);
            await commitProductionActivationState(lease, paths, previousState, {
                current: {
                    releaseId: secondReleaseId,
                    runtimeRevision: runtimeIdentity.revision,
                },
                formatVersion: 1,
                previous: {
                    databaseSnapshotTransitionId: transitionId,
                    releaseId: firstReleaseId,
                    runtimeRevision: runtimeIdentity.revision,
                },
                transitionId,
            });
            await markProductionRollbackRequired(lease, paths, promoted);

            const recovered = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies
                )
            );

            expect(recovered).toEqual(initial);
            const recoveredState = await loadProductionActivationState(lease, paths);
            expect(recoveredState.record).toEqual(initial);
            expect(
                readMigrationReleaseId(
                    path.join(paths.stateDirectory, "mira-dashboard.db")
                )
            ).toBe(firstReleaseId);
            const stateEntries = await readdir(paths.stateDirectory);
            expect(stateEntries).not.toContain("activation-transition.json");
            expect(
                stateEntries.filter((entry) => entry.startsWith(".database-transition-"))
            ).toEqual([]);
        });
    });

    test("recovers a crash after database promotion but before journal advancement", async () => {
        const projectRoot = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = clonedPublishedFixtures(paths);
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = initialActivationFixture();
            const transitionId = Bun.randomUUIDv7();
            const snapshot = await runDatabaseSnapshotMaintenance(
                lease,
                paths,
                fixtures.first,
                fixtures.runtime,
                transitionId,
                "present",
                dependencies.maintenance
            );
            if (snapshot.state !== "present") throw new Error("Expected snapshot");
            const stopRequested = await createProductionActivationJournal(
                lease,
                paths,
                parseProductionActivationTransition({
                    candidate: {
                        releaseId: secondReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                    formatVersion: 1,
                    phase: "service-stop-requested",
                    previousActivation: initial,
                    previousDatabase: { state: "unrecorded" },
                    transitionId,
                })
            );
            await markProductionSnapshotPrepared(lease, paths, stopRequested, {
                manifest: snapshot.manifest,
                sourceDatabase: snapshot.sourceDatabase,
                state: "present",
            });
            const workspace = await prepareDatabaseTransitionWorkspace(
                lease,
                paths,
                transitionId,
                snapshot
            );
            await runDatabaseCandidateMaintenance(
                lease,
                paths,
                fixtures.second,
                fixtures.runtime,
                transitionId,
                workspace.candidateDirectory,
                dependencies.maintenance
            );
            const promoted = await promoteDatabaseTransitionCandidate(
                lease,
                paths,
                await verifyDatabaseTransitionCandidate(workspace)
            );
            const promotedStatus = await lstat(
                path.join(paths.stateDirectory, "mira-dashboard.db"),
                { bigint: true }
            );
            const promotedInode = promotedStatus.ino;
            expect(promoted.fileIdentity.ino).toBe(promotedInode);

            const recovered = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies
                )
            );
            const restoredStatus = await lstat(
                path.join(paths.stateDirectory, "mira-dashboard.db"),
                { bigint: true }
            );
            const restoredInode = restoredStatus.ino;
            expect(restoredInode).not.toBe(promotedInode);
            expect(recovered).toEqual(initial);
            expect(
                readMigrationReleaseId(
                    path.join(paths.stateDirectory, "mira-dashboard.db")
                )
            ).toBe(firstReleaseId);
            expect(await readdir(paths.stateDirectory)).not.toContain(
                "activation-transition.json"
            );
        });
    });
});
