import { Effect, Schema } from "effect";

import type { ProductionActivationRecord } from "../../src/shared/productionActivationRecord.ts";
import {
    parseProductionActivationTransition,
    type ProductionActivationPreviousDatabase,
    type ProductionActivationTransition,
} from "../../src/shared/productionActivationTransition.ts";
import {
    type DatabaseMaintenanceProcessDependencies,
    runDatabaseCandidateMaintenance,
    runDatabaseSnapshotMaintenance,
} from "./databaseMaintenanceProcess.ts";
import { retainProductionDatabaseSnapshots } from "./databaseSnapshotRetention.ts";
import {
    discardDatabaseTransitionWorkspace,
    discardOrphanDatabaseTransitionWorkspace,
    inspectDatabaseTransitionRecovery,
    prepareDatabaseRollbackCandidate,
    prepareDatabaseTransitionWorkspace,
    promoteDatabaseTransitionCandidate,
    restorePromotedDatabaseState,
    verifyDatabaseTransitionCandidate,
    type DatabaseTransitionWorkspace,
    type PromotedDatabaseState,
} from "./databaseTransitionFilesystem.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import {
    clearProductionActivationJournal,
    createProductionActivationJournal,
    loadProductionActivationJournal,
    markProductionDatabasePromoted,
    markProductionRollbackRequired,
    markProductionSnapshotPrepared,
} from "./productionActivationJournal.ts";
import {
    commitProductionActivationState,
    loadProductionActivationState,
    restorePreviousProductionActivationState,
    type ProductionActivationState,
} from "./productionActivationState.ts";
import {
    retainProductionArtifacts,
    type ProductionArtifactReference,
} from "./productionArtifactRetention.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import {
    loadPublishedProductionRelease,
    type PublishedProductionRelease,
} from "./productionReleasePublication.ts";
import {
    type InstalledProductionRuntime,
    loadInstalledProductionRuntime,
    type ProductionRuntimeVerificationDependencies,
} from "./productionRuntime.ts";
import { clearProductionProcessPointers } from "./productionRuntimePointers.ts";

const TaggedErrorClass = Schema.TaggedError;
const activationFailureMessage = "Production release activation failed";

/** Sanitized failure spanning release, process, database, and recovery boundaries. */
export class ProductionReleaseActivationError extends TaggedErrorClass<ProductionReleaseActivationError>(
    "mira-dashboard/scripts/delivery/ProductionReleaseActivationError"
)("ProductionReleaseActivationError", { message: Schema.String }) {}

/** Idempotent process-control port implemented by the project-local systemd adapter. */
export interface ProductionServiceController {
    readonly prepare: (
        release: PublishedProductionRelease,
        runtime: InstalledProductionRuntime
    ) => Promise<void>;
    readonly start: (
        release: PublishedProductionRelease,
        runtime: InstalledProductionRuntime
    ) => Promise<void>;
    readonly stop: () => Promise<void>;
    readonly verifyReady: (
        release: PublishedProductionRelease,
        runtime: InstalledProductionRuntime
    ) => Promise<void>;
}

/** Activation dependencies kept explicit for disposable-host lifecycle tests. */
export interface ProductionReleaseActivationDependencies {
    readonly artifactRetention?: typeof retainProductionArtifacts;
    readonly maintenance?: DatabaseMaintenanceProcessDependencies;
    readonly runtimeVerification?: ProductionRuntimeVerificationDependencies;
    readonly services: ProductionServiceController;
    readonly testHooks?: ProductionReleaseActivationTestHooks;
}

/** Deterministic crash-boundary hooks used only by activation lifecycle tests. */
export interface ProductionReleaseActivationTestHooks {
    readonly afterActivationCommit?: () => Promise<void> | void;
    readonly afterActivationJournalClear?: () => Promise<void> | void;
    readonly afterServicesStopped?: () => Promise<void> | void;
}

interface ActiveArtifacts {
    readonly release: PublishedProductionRelease;
    readonly runtime: InstalledProductionRuntime;
}

async function prepareAndStartServices(
    services: ProductionServiceController,
    artifacts: ActiveArtifacts
): Promise<void> {
    await services.prepare(artifacts.release, artifacts.runtime);
    await services.start(artifacts.release, artifacts.runtime);
}

function sameRecord(
    left: ProductionActivationRecord | null | undefined,
    right: ProductionActivationRecord | null | undefined
): boolean {
    if (left === null || left === undefined || right === null || right === undefined) {
        return (
            (left === null || left === undefined) &&
            (right === null || right === undefined)
        );
    }
    const samePrevious =
        left.previous === null || right.previous === null
            ? left.previous === right.previous
            : left.previous.databaseSnapshotTransitionId ===
                  right.previous.databaseSnapshotTransitionId &&
              left.previous.releaseId === right.previous.releaseId &&
              left.previous.runtimeRevision === right.previous.runtimeRevision;
    return (
        left.formatVersion === right.formatVersion &&
        left.transitionId === right.transitionId &&
        left.current.releaseId === right.current.releaseId &&
        left.current.runtimeRevision === right.current.runtimeRevision &&
        samePrevious
    );
}

function activationError(): ProductionReleaseActivationError {
    return new ProductionReleaseActivationError({ message: activationFailureMessage });
}

function activationSnapshotReferences(
    record: ProductionActivationRecord
): readonly string[] {
    return Object.freeze([
        record.transitionId,
        ...(record.previous === null
            ? []
            : [record.previous.databaseSnapshotTransitionId]),
    ]);
}

async function retainCommittedDatabaseSnapshots(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    activation: ProductionActivationState
): Promise<void> {
    await retainProductionDatabaseSnapshots(lease, paths, {
        activationTransitionIds:
            activation.record === undefined
                ? []
                : activationSnapshotReferences(activation.record),
    });
}

function activationArtifactReferences(
    record: ProductionActivationRecord | undefined,
    candidate?: ActiveArtifacts
): readonly ProductionArtifactReference[] {
    const candidates: readonly (ProductionArtifactReference | undefined)[] = [
        record === undefined
            ? undefined
            : {
                  releaseId: record.current.releaseId,
                  runtimeRevision: record.current.runtimeRevision,
              },
        record?.previous === null || record?.previous === undefined
            ? undefined
            : {
                  releaseId: record.previous.releaseId,
                  runtimeRevision: record.previous.runtimeRevision,
              },
        candidate === undefined
            ? undefined
            : {
                  releaseId: candidate.release.manifest.source.commitSha,
                  runtimeRevision: candidate.runtime.identity.revision,
              },
    ];
    const references = candidates.filter(
        (reference): reference is ProductionArtifactReference => reference !== undefined
    );
    return Object.freeze(
        references.filter(
            (reference, index) =>
                references.findIndex(
                    ({ releaseId }) => releaseId === reference.releaseId
                ) === index
        )
    );
}

async function retainCommittedProductionArtifacts(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    activation: ProductionActivationState,
    dependencies: ProductionReleaseActivationDependencies,
    candidate?: ActiveArtifacts
): Promise<void> {
    await (dependencies.artifactRetention ?? retainProductionArtifacts)(
        lease,
        paths,
        activationArtifactReferences(activation.record, candidate),
        { runtimeVerification: dependencies.runtimeVerification }
    );
}

async function loadActiveArtifacts(
    paths: PreparedProductionDeliveryPaths,
    record: ProductionActivationRecord,
    dependencies: ProductionReleaseActivationDependencies
): Promise<ActiveArtifacts> {
    const release = await loadPublishedProductionRelease(
        paths,
        record.current.releaseId,
        record.current.runtimeRevision
    );
    const runtime = await loadInstalledProductionRuntime(
        paths,
        release.manifest.runtime,
        dependencies.runtimeVerification
    );
    return Object.freeze({ release, runtime });
}

async function loadExactArtifacts(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string,
    runtimeRevision: string,
    dependencies: ProductionReleaseActivationDependencies
): Promise<ActiveArtifacts> {
    const release = await loadPublishedProductionRelease(
        paths,
        releaseId,
        runtimeRevision
    );
    const runtime = await loadInstalledProductionRuntime(
        paths,
        release.manifest.runtime,
        dependencies.runtimeVerification
    );
    return Object.freeze({ release, runtime });
}

async function verifyCandidateArtifacts(
    paths: PreparedProductionDeliveryPaths,
    candidateRelease: PublishedProductionRelease,
    candidateRuntime: InstalledProductionRuntime,
    dependencies: ProductionReleaseActivationDependencies
): Promise<ActiveArtifacts> {
    const verified = await loadExactArtifacts(
        paths,
        candidateRelease.manifest.source.commitSha,
        candidateRuntime.identity.revision,
        dependencies
    );
    if (
        JSON.stringify(verified.release.manifest) !==
            JSON.stringify(candidateRelease.manifest) ||
        verified.release.releaseRoot !== candidateRelease.releaseRoot ||
        verified.runtime.executable !== candidateRuntime.executable ||
        JSON.stringify(verified.runtime.identity) !==
            JSON.stringify(candidateRuntime.identity)
    ) {
        throw activationError();
    }
    return verified;
}

function journalFor(
    transitionId: string,
    activation: ProductionActivationState,
    candidate: ActiveArtifacts
): ProductionActivationTransition {
    return parseProductionActivationTransition({
        candidate: {
            releaseId: candidate.release.manifest.source.commitSha,
            runtimeRevision: candidate.runtime.identity.revision,
        },
        formatVersion: 1,
        phase: "service-stop-requested",
        previousActivation: activation.record ?? null,
        previousDatabase: { state: "unrecorded" },
        transitionId,
    });
}

function previousDatabaseForSnapshot(
    snapshot: Awaited<ReturnType<typeof runDatabaseSnapshotMaintenance>>
): ProductionActivationPreviousDatabase {
    return snapshot.state === "absent"
        ? { state: "absent" }
        : {
              manifest: snapshot.manifest,
              sourceDatabase: snapshot.sourceDatabase,
              state: "present",
          };
}

function nextActivationRecord(
    transitionId: string,
    activation: ProductionActivationState,
    candidate: ActiveArtifacts
): ProductionActivationRecord {
    return {
        current: {
            releaseId: candidate.release.manifest.source.commitSha,
            runtimeRevision: candidate.runtime.identity.revision,
        },
        formatVersion: 1,
        previous: activation.record
            ? {
                  databaseSnapshotTransitionId: transitionId,
                  releaseId: activation.record.current.releaseId,
                  runtimeRevision: activation.record.current.runtimeRevision,
              }
            : null,
        transitionId,
    };
}

async function reconcileActivationCommit(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionActivationState,
    next: ProductionActivationRecord
): Promise<ProductionActivationState> {
    try {
        return await commitProductionActivationState(lease, paths, expected, next);
    } catch {
        const observed = await loadProductionActivationState(lease, paths);
        if (!sameRecord(observed.record, next)) throw activationError();
        return observed;
    }
}

async function reconcileActivationRollback(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expected: ProductionActivationState,
    previous: ProductionActivationRecord | null
): Promise<ProductionActivationState> {
    try {
        return await restorePreviousProductionActivationState(
            lease,
            paths,
            expected,
            previous
        );
    } catch {
        const observed = await loadProductionActivationState(lease, paths);
        if (!sameRecord(observed.record, previous ?? undefined)) {
            throw activationError();
        }
        return observed;
    }
}

async function restorePreviousDatabase(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    promoted: PromotedDatabaseState,
    workspace: DatabaseTransitionWorkspace,
    previous: ActiveArtifacts | undefined,
    dependencies: ProductionReleaseActivationDependencies
): Promise<void> {
    if (promoted.previous.state === "absent") {
        await restorePromotedDatabaseState(lease, paths, promoted);
        return;
    }
    if (!previous) throw activationError();
    await prepareDatabaseRollbackCandidate(promoted, workspace);
    await runDatabaseCandidateMaintenance(
        lease,
        paths,
        previous.release,
        previous.runtime,
        workspace.transitionId,
        workspace.candidateDirectory,
        dependencies.maintenance
    );
    const rollbackCandidate = await verifyDatabaseTransitionCandidate(workspace);
    await restorePromotedDatabaseState(lease, paths, promoted, rollbackCandidate);
}

async function discardTransitionWorkspace(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    transitionId: string,
    workspace: DatabaseTransitionWorkspace | undefined
): Promise<void> {
    await (workspace
        ? discardDatabaseTransitionWorkspace(lease, paths, workspace)
        : discardOrphanDatabaseTransitionWorkspace(lease, paths, transitionId));
}

async function restorePreviousProcessState(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    previous: ActiveArtifacts | undefined,
    dependencies: ProductionReleaseActivationDependencies
): Promise<void> {
    if (previous) {
        await prepareAndStartServices(dependencies.services, previous);
        await dependencies.services.verifyReady(previous.release, previous.runtime);
        return;
    }
    await clearProductionProcessPointers(lease, paths);
}

function activationMatchesCandidate(
    activation: ProductionActivationState,
    journal: ProductionActivationTransition
): boolean {
    return (
        activation.record?.transitionId === journal.transitionId &&
        activation.record.current.releaseId === journal.candidate.releaseId &&
        activation.record.current.runtimeRevision === journal.candidate.runtimeRevision
    );
}

async function rollbackTransition(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    journal: ProductionActivationTransition,
    activation: ProductionActivationState,
    dependencies: ProductionReleaseActivationDependencies
): Promise<ProductionActivationState> {
    const candidateCommitted = activationMatchesCandidate(activation, journal);
    const previousAuthoritative = sameRecord(
        activation.record,
        journal.previousActivation
    );
    if (
        journal.phase === "service-stop-requested" &&
        (candidateCommitted || !previousAuthoritative)
    ) {
        throw activationError();
    }
    if (!candidateCommitted && !previousAuthoritative) throw activationError();

    const previous = journal.previousActivation
        ? await loadActiveArtifacts(paths, journal.previousActivation, dependencies)
        : undefined;
    const stopOwner =
        candidateCommitted || !previous
            ? await loadExactArtifacts(
                  paths,
                  journal.candidate.releaseId,
                  journal.candidate.runtimeRevision,
                  dependencies
              )
            : previous;
    await dependencies.services.prepare(stopOwner.release, stopOwner.runtime);
    await dependencies.services.stop();
    if (journal.phase === "service-stop-requested") {
        await discardOrphanDatabaseTransitionWorkspace(
            lease,
            paths,
            journal.transitionId
        );
        await restorePreviousProcessState(lease, paths, previous, dependencies);
        await clearProductionActivationJournal(lease, paths, journal);
        return activation;
    }
    const recovery = await inspectDatabaseTransitionRecovery(lease, paths, journal);
    if (recovery.state === "promoted") {
        await restorePreviousDatabase(
            lease,
            paths,
            recovery.promoted,
            recovery.workspace,
            previous,
            dependencies
        );
    }
    const restoredActivation = candidateCommitted
        ? await reconcileActivationRollback(
              lease,
              paths,
              activation,
              journal.previousActivation
          )
        : activation;
    await discardOrphanDatabaseTransitionWorkspace(lease, paths, journal.transitionId);
    await restorePreviousProcessState(lease, paths, previous, dependencies);
    await clearProductionActivationJournal(lease, paths, journal);
    return restoredActivation;
}

async function recoverExistingTransition(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    dependencies: ProductionReleaseActivationDependencies
): Promise<ProductionActivationState> {
    const journal = await loadProductionActivationJournal(lease, paths);
    const activation = await loadProductionActivationState(lease, paths);
    if (!journal) return activation;

    const committed = activationMatchesCandidate(activation, journal);
    if (committed && journal.phase !== "rollback-required") {
        if (journal.phase !== "database-promoted") throw activationError();
        const currentRecord = activation.record;
        if (!currentRecord) throw activationError();
        const current = await loadActiveArtifacts(paths, currentRecord, dependencies);
        try {
            await prepareAndStartServices(dependencies.services, current);
            await dependencies.services.verifyReady(current.release, current.runtime);
        } catch {
            const rollback = await markProductionRollbackRequired(lease, paths, journal);
            return rollbackTransition(lease, paths, rollback, activation, dependencies);
        }
        await discardOrphanDatabaseTransitionWorkspace(
            lease,
            paths,
            journal.transitionId
        );
        await clearProductionActivationJournal(lease, paths, journal);
        return activation;
    }
    return rollbackTransition(lease, paths, journal, activation, dependencies);
}

/**
 * Reconciles any durable transition before a new release/runtime copy is admitted, then
 * removes every artifact not referenced by the authoritative current/rollback state.
 * Recovery runs first so an in-flight journal candidate remains available until its outcome is
 * known. Callers must hold the same deployment lease for the later install and publication.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param dependencies Process control and verification boundaries required by recovery.
 */
export async function prepareProductionArtifactAdmission(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    dependencies: ProductionReleaseActivationDependencies
): Promise<void> {
    try {
        const activation = await recoverExistingTransition(lease, paths, dependencies);
        await retainCommittedProductionArtifacts(lease, paths, activation, dependencies);
    } catch {
        throw activationError();
    }
}

async function activateRelease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    candidateRelease: PublishedProductionRelease,
    candidateRuntime: InstalledProductionRuntime,
    dependencies: ProductionReleaseActivationDependencies
): Promise<ProductionActivationRecord> {
    const activation = await recoverExistingTransition(lease, paths, dependencies);
    await retainCommittedDatabaseSnapshots(lease, paths, activation);
    const candidate = await verifyCandidateArtifacts(
        paths,
        candidateRelease,
        candidateRuntime,
        dependencies
    );
    await retainCommittedProductionArtifacts(
        lease,
        paths,
        activation,
        dependencies,
        candidate
    );
    if (
        activation.record?.current.releaseId ===
            candidate.release.manifest.source.commitSha &&
        activation.record.current.runtimeRevision === candidate.runtime.identity.revision
    ) {
        await prepareAndStartServices(dependencies.services, candidate);
        await dependencies.services.verifyReady(candidate.release, candidate.runtime);
        return activation.record;
    }

    const previous = activation.record
        ? await loadActiveArtifacts(paths, activation.record, dependencies)
        : undefined;
    const transitionId = Bun.randomUUIDv7();
    const expectedCommitted = nextActivationRecord(transitionId, activation, candidate);
    let journal: ProductionActivationTransition | undefined;
    let workspace: DatabaseTransitionWorkspace | undefined;
    let promoted: PromotedDatabaseState | undefined;
    try {
        const stopOwner = previous ?? candidate;
        await dependencies.services.prepare(stopOwner.release, stopOwner.runtime);
        journal = await createProductionActivationJournal(
            lease,
            paths,
            journalFor(transitionId, activation, candidate)
        );
        await dependencies.services.stop();
        await dependencies.testHooks?.afterServicesStopped?.();
        const snapshotOwner = previous ?? candidate;
        const snapshot = await runDatabaseSnapshotMaintenance(
            lease,
            paths,
            snapshotOwner.release,
            snapshotOwner.runtime,
            transitionId,
            previous ? "present" : "absent",
            dependencies.maintenance
        );
        journal = await markProductionSnapshotPrepared(
            lease,
            paths,
            journal,
            previousDatabaseForSnapshot(snapshot)
        );
        workspace = await prepareDatabaseTransitionWorkspace(
            lease,
            paths,
            transitionId,
            snapshot
        );
        await runDatabaseCandidateMaintenance(
            lease,
            paths,
            candidate.release,
            candidate.runtime,
            transitionId,
            workspace.candidateDirectory,
            dependencies.maintenance
        );
        const verifiedCandidate = await verifyDatabaseTransitionCandidate(workspace);
        promoted = await promoteDatabaseTransitionCandidate(
            lease,
            paths,
            verifiedCandidate
        );
        journal = await markProductionDatabasePromoted(lease, paths, journal);
        const committedState = await reconcileActivationCommit(
            lease,
            paths,
            activation,
            expectedCommitted
        );
        const committed = committedState.record;
        if (!committed) throw activationError();
        await dependencies.testHooks?.afterActivationCommit?.();
        try {
            await prepareAndStartServices(dependencies.services, candidate);
            await dependencies.services.verifyReady(candidate.release, candidate.runtime);
        } catch {
            journal = await markProductionRollbackRequired(lease, paths, journal);
            throw activationError();
        }
        await discardDatabaseTransitionWorkspace(lease, paths, workspace);
        workspace = undefined;
        await clearProductionActivationJournal(lease, paths, journal);
        journal = undefined;
        await dependencies.testHooks?.afterActivationJournalClear?.();
        await retainCommittedDatabaseSnapshots(lease, paths, committedState);
        await retainCommittedProductionArtifacts(
            lease,
            paths,
            committedState,
            dependencies
        );
        return committed;
    } catch {
        const observedJournal = await loadProductionActivationJournal(lease, paths).catch(
            () => journal
        );
        const observedActivation = await loadProductionActivationState(
            lease,
            paths
        ).catch(() => activation);
        if (observedJournal) {
            const recovered = await recoverExistingTransition(lease, paths, dependencies);
            if (sameRecord(recovered.record, expectedCommitted)) {
                await retainCommittedDatabaseSnapshots(lease, paths, recovered);
                await retainCommittedProductionArtifacts(
                    lease,
                    paths,
                    recovered,
                    dependencies
                );
                return expectedCommitted;
            }
            throw activationError();
        }
        if (sameRecord(observedActivation.record, expectedCommitted)) {
            await discardTransitionWorkspace(lease, paths, transitionId, workspace);
            await retainCommittedDatabaseSnapshots(lease, paths, observedActivation);
            await retainCommittedProductionArtifacts(
                lease,
                paths,
                observedActivation,
                dependencies
            );
            return expectedCommitted;
        }

        try {
            await dependencies.services.stop();
            const rollbackPromoted = promoted;
            const rollbackWorkspace = workspace;
            if (rollbackPromoted && rollbackWorkspace) {
                await restorePreviousDatabase(
                    lease,
                    paths,
                    rollbackPromoted,
                    rollbackWorkspace,
                    previous,
                    dependencies
                );
            }
            await discardTransitionWorkspace(
                lease,
                paths,
                transitionId,
                rollbackWorkspace
            );
            if (previous) {
                await prepareAndStartServices(dependencies.services, previous);
                await dependencies.services.verifyReady(
                    previous.release,
                    previous.runtime
                );
            }
        } catch {
            // Keep the durable journal and private workspace for the next recovery pass.
            throw activationError();
        }
        throw activationError();
    }
}

/**
 * Activates one published release and database as a crash-recoverable pair.
 * @param lease Active wider deployment lease.
 * @param paths Exact project-local production paths.
 * @param candidateRelease Verified immutable candidate release.
 * @param candidateRuntime Exact installed candidate Bun runtime.
 * @param dependencies Process control and injectable verification boundaries.
 * @returns Typed Effect yielding the authoritative committed activation record.
 */
export function activatePublishedProductionRelease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    candidateRelease: PublishedProductionRelease,
    candidateRuntime: InstalledProductionRuntime,
    dependencies: ProductionReleaseActivationDependencies
): Effect.Effect<ProductionActivationRecord, ProductionReleaseActivationError> {
    return Effect.tryPromise({
        catch: () => activationError(),
        try: () =>
            activateRelease(
                lease,
                paths,
                candidateRelease,
                candidateRuntime,
                dependencies
            ),
    });
}
