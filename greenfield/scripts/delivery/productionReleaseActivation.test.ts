import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, readdir } from "node:fs/promises";
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
import { createProductionActivationJournal } from "./productionActivationJournal.ts";
import { loadProductionActivationState } from "./productionActivationState.ts";
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
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

async function localReleaseFixture(commitSha: string): Promise<string> {
    return createLocalReleaseFixture(
        sourceProjectRoot,
        commitSha,
        runtimeIdentity,
        temporaryDirectories
    );
}

function createProjectFixture() {
    return createProductionTargetFixture(temporaryDirectories);
}

class TestServiceController implements ProductionServiceController {
    readonly events: string[] = [];
    rejectReadyReleaseId: string | undefined;
    rejectStartReleaseId: string | undefined;

    prepare(release: PublishedProductionRelease): Promise<void> {
        this.events.push(`prepare:${release.manifest.source.commitSha}`);
        return Promise.resolve();
    }

    start(release: PublishedProductionRelease): Promise<void> {
        const releaseId = release.manifest.source.commitSha;
        this.events.push(`start:${releaseId}`);
        return releaseId === this.rejectStartReleaseId
            ? Promise.reject(new Error("candidate partially started"))
            : Promise.resolve();
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
        const sourceReleases = await Promise.all([
            localReleaseFixture(firstReleaseId),
            localReleaseFixture(secondReleaseId),
        ]);
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
        const sourceReleases = await Promise.all([
            localReleaseFixture(firstReleaseId),
            localReleaseFixture(secondReleaseId),
        ]);
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
            expect(services.events.slice(-9)).toEqual([
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                `ready:${secondReleaseId}`,
                "stop",
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
            ]);
            expect(await readdir(paths.stateDirectory)).not.toContain(
                "activation-transition.json"
            );

            services.rejectReadyReleaseId = undefined;
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
            expect(services.events.slice(-8)).toEqual([
                `prepare:${firstReleaseId}`,
                "stop",
                `prepare:${secondReleaseId}`,
                `start:${secondReleaseId}`,
                "stop",
                `prepare:${firstReleaseId}`,
                `start:${firstReleaseId}`,
                `ready:${firstReleaseId}`,
            ]);
        });
    });

    test("keeps a committed candidate when post-commit cleanup is interrupted", async () => {
        const sourceReleases = await Promise.all([
            localReleaseFixture(firstReleaseId),
            localReleaseFixture(secondReleaseId),
        ]);
        for (const boundary of [
            "afterActivationCommit",
            "afterActivationJournalClear",
        ] as const) {
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
                let hookCalls = 0;
                const upgraded = await Effect.runPromise(
                    activatePublishedProductionRelease(
                        lease,
                        paths,
                        fixtures.second,
                        fixtures.runtime,
                        activationDependencies(services, fixtures.probeRuntime, {
                            [boundary]: () => {
                                hookCalls += 1;
                                throw new Error("simulated cleanup interruption");
                            },
                        })
                    )
                );

                const activation = await loadProductionActivationState(lease, paths);
                const stateEntries = await readdir(paths.stateDirectory);
                expect(hookCalls).toBe(1);
                expect(upgraded.current.releaseId).toBe(secondReleaseId);
                expect(activation.record).toEqual(upgraded);
                expect(stateEntries).not.toContain("activation-transition.json");
                expect(
                    stateEntries.filter((entry) =>
                        entry.startsWith(".database-transition-")
                    )
                ).toEqual([]);
                expect(services.events.at(-1)).toBe(`ready:${secondReleaseId}`);
            });
        }
    });

    test("recovers a crash after database promotion but before journal advancement", async () => {
        const sourceReleases = await Promise.all([
            localReleaseFixture(firstReleaseId),
            localReleaseFixture(secondReleaseId),
        ]);
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
            await createProductionActivationJournal(
                lease,
                paths,
                parseProductionActivationTransition({
                    candidate: {
                        releaseId: secondReleaseId,
                        runtimeRevision: runtimeIdentity.revision,
                    },
                    formatVersion: 1,
                    phase: "prepared",
                    previousActivation: initial,
                    previousDatabase: {
                        manifest: snapshot.manifest,
                        sourceDatabase: snapshot.sourceDatabase,
                        state: "present",
                    },
                    transitionId,
                })
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
