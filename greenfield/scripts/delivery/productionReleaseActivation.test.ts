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
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

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
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import {
    activatePublishedProductionRelease,
    type ProductionServiceController,
    type ProductionReleaseActivationTestHooks,
} from "./productionReleaseActivation.ts";
import { type PublishedProductionRelease } from "./productionReleasePublication.ts";
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

function createProjectFixture() {
    return createProductionTargetFixture(temporaryDirectories);
}

class TestServiceController implements ProductionServiceController {
    readonly events: string[] = [];
    onStart: ((release: PublishedProductionRelease) => Promise<void> | void) | undefined;
    rejectReadyReleaseId: string | undefined;
    rejectStartReleaseId: string | undefined;

    prepare(release: PublishedProductionRelease): Promise<void> {
        this.events.push(`prepare:${release.manifest.source.commitSha}`);
        return Promise.resolve();
    }

    async start(release: PublishedProductionRelease): Promise<void> {
        const releaseId = release.manifest.source.commitSha;
        this.events.push(`start:${releaseId}`);
        await this.onStart?.(release);
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
}

function activationDependencies(
    services: TestServiceController,
    probeRuntime: () => Promise<ReleaseRuntimeIdentity>,
    testHooks?: ProductionReleaseActivationTestHooks
) {
    return Object.freeze({
        maintenance: {
            execute: executeDatabaseMaintenanceFixture,
            runtimeVerification: { probeRuntime },
        },
        runtimeVerification: { probeRuntime },
        services,
        testHooks,
    });
}

function publishFixtures(
    lease: Parameters<typeof publishProductionDeliveryFixtures>[0],
    paths: Parameters<typeof publishProductionDeliveryFixtures>[1],
    sourceReleases: readonly [string, string],
    runtimeSource: string
) {
    return publishProductionDeliveryFixtures(
        lease,
        paths,
        sourceReleases,
        runtimeSource,
        runtimeIdentity
    );
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
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            const authoritativeAtStart: string[] = [];
            services.onStart = async (release) => {
                const observed = await loadProductionActivationState(lease, paths);
                const releaseId = release.manifest.source.commitSha;
                expect(observed.record?.current.releaseId).toBe(releaseId);
                authoritativeAtStart.push(releaseId);
            };
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
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
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                `ready:${secondReleaseId}`,
            ]);
            expect(authoritativeAtStart).toEqual([firstReleaseId, secondReleaseId]);
            const activation = await loadProductionActivationState(lease, paths);
            const stateEntries = await readdir(paths.stateDirectory);
            expect(activation.record).toEqual(upgraded);
            expect(stateEntries).not.toContain("activation-transition.json");
            expect(
                stateEntries.filter((entry) => entry.startsWith(".database-transition-"))
            ).toEqual([]);
        });
    });

    test("restores the previous release and database when candidate readiness fails", async () => {
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies
                )
            );
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
            expect(services.events.slice(-10)).toEqual([
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                `ready:${secondReleaseId}`,
                `prepare:${secondReleaseId}`,
                "stop",
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
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies
                )
            );
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
            expect(services.events.slice(-9)).toEqual([
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                `prepare:${secondReleaseId}`,
                "stop",
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
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            const initial = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    activationDependencies(services, fixtures.probeRuntime)
                )
            );
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
            expect(services.events.slice(-7)).toEqual([
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
            ]);
        });
    });

    test("keeps a committed candidate when post-commit cleanup is interrupted", async () => {
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            const baseDependencies = activationDependencies(
                services,
                fixtures.probeRuntime
            );
            await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    baseDependencies
                )
            );
            const crashStages: string[] = [];
            for (const scenario of [
                {
                    boundary: "afterActivationCommit" as const,
                    candidate: fixtures.second,
                    expectedReleaseId: secondReleaseId,
                },
                {
                    boundary: "afterActivationJournalClear" as const,
                    candidate: fixtures.first,
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
                    `ready:${scenario.expectedReleaseId}`
                );
                expect(
                    await readdir(path.join(paths.stateDirectory, "backups"))
                ).not.toContain(crashStages.at(-1));
            }
        });
    }, 15_000);

    test("reports committed retention failure and retries it on the same candidate", async () => {
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    activationDependencies(services, fixtures.probeRuntime)
                )
            );
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
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies
                )
            );
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
        const sourceReleases = sourceReleaseFixtures();
        const { projectRoot, runtimeSource } = await createProjectFixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const fixtures = await publishFixtures(
                lease,
                paths,
                sourceReleases,
                runtimeSource
            );
            const services = new TestServiceController();
            const dependencies = activationDependencies(services, fixtures.probeRuntime);
            const initial = await Effect.runPromise(
                activatePublishedProductionRelease(
                    lease,
                    paths,
                    fixtures.first,
                    fixtures.runtime,
                    dependencies
                )
            );
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
