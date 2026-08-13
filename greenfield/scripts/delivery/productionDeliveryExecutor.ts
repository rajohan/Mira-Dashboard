import { Database } from "bun:sqlite";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import * as v from "valibot";

import { healthReadinessPath } from "../../src/contracts/system.ts";
import {
    deliveryProductionOperationMaximumBytes,
    deliveryProductionOperationPhases,
    deliveryProductionProtocol,
    parseDeliveryProductionOperationCapsule,
    serializeDeliveryProductionOperationRecord,
    type DeliveryProductionOperationCapsule,
    type DeliveryProductionOperationInspection,
    type DeliveryProductionOperationPhase,
    type DeliveryProductionOperationRecord,
    type DeliveryProductionTerminalRecord,
    type DeliveryProductionTerminalResult,
} from "../../src/shared/deliveryProductionOperation.ts";
import type { ProductionActivationRecord } from "../../src/shared/productionActivationRecord.ts";
import { lowercaseUuidV7Schema } from "../../src/shared/validation.ts";
import { resolveBuildSourceIdentity } from "../buildSourceIdentity.ts";
import { buildDashboardRelease } from "./buildRelease.ts";
import { withDeploymentLease, type DashboardDeploymentLease } from "./deploymentLease.ts";
import { loadProductionActivationState } from "./productionActivationState.ts";
import { assertProductionArtifactCapacity } from "./productionArtifactCapacity.ts";
import {
    prepareProductionDeliveryDirectories,
    type PreparedProductionDeliveryPaths,
} from "./productionDeliveryFilesystem.ts";
import {
    advanceDeliveryProductionOperation,
    clearDeliveryProductionOperation,
    completeDeliveryProductionOperation,
    createDeliveryProductionOperation,
    inspectDeliveryProductionOperation,
    inspectDeliveryProductionReceipt,
} from "./productionDeliveryOperationFilesystem.ts";
import {
    activatePublishedProductionRelease,
    prepareProductionArtifactAdmission,
    type ProductionReleaseActivationDependencies,
    type ProductionReleaseActivationOptions,
    type ProductionServiceController,
} from "./productionReleaseActivation.ts";
import {
    loadPublishedProductionRelease,
    publishProductionRelease,
    type PublishedProductionRelease,
} from "./productionReleasePublication.ts";
import {
    installProductionRuntime,
    loadInstalledProductionRuntime,
    type InstalledProductionRuntime,
} from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import { verifyPreviewTailscaleOperator } from "./provisioning/preview-tailscale/operator.ts";
import { verifyReleaseIdentity } from "./releaseIdentity.ts";
import { createSystemdProductionServiceController } from "./systemdProductionServices.ts";

const executorFailureMessage = "Production Delivery executor failed";
const executorUsage =
    "Usage: bun productionDelivery.js --operation=prepare|inspect|inspect-active|clear|cutover --project-root=/absolute/project [--readiness-url=http://127.0.0.1:PORT/api/health/ready] [--transition=uuid-v7]";
const absoluteProjectRootSchema = v.pipe(
    v.string(executorUsage),
    v.maxLength(4096, executorUsage),
    v.check(
        (value) =>
            path.isAbsolute(value) &&
            path.resolve(value) === value &&
            path.parse(value).root !== value &&
            !value.includes("\0"),
        executorUsage
    )
);
const readinessUrlSchema = v.pipe(
    v.string(executorUsage),
    v.url(executorUsage),
    v.check((value) => {
        try {
            const url = new URL(value);
            return (
                url.protocol === "http:" &&
                url.hostname === "127.0.0.1" &&
                url.pathname === healthReadinessPath &&
                url.username.length === 0 &&
                url.password.length === 0 &&
                url.search.length === 0 &&
                url.hash.length === 0
            );
        } catch {
            return false;
        }
    }, executorUsage)
);
const argumentsSchema = v.variant("operation", [
    v.strictObject({
        operation: v.literal("prepare"),
        projectRoot: absoluteProjectRootSchema,
    }),
    v.strictObject({
        operation: v.literal("inspect"),
        projectRoot: absoluteProjectRootSchema,
        transitionId: lowercaseUuidV7Schema(executorUsage),
    }),
    v.strictObject({
        operation: v.literal("inspect-active"),
        projectRoot: absoluteProjectRootSchema,
    }),
    v.strictObject({
        operation: v.literal("clear"),
        projectRoot: absoluteProjectRootSchema,
        transitionId: lowercaseUuidV7Schema(executorUsage),
    }),
    v.strictObject({
        operation: v.literal("cutover"),
        projectRoot: absoluteProjectRootSchema,
        readinessUrl: readinessUrlSchema,
        transitionId: lowercaseUuidV7Schema(executorUsage),
    }),
]);

export type ProductionDeliveryExecutorArguments = Readonly<
    v.InferOutput<typeof argumentsSchema>
>;

export interface ProductionDeliveryExecutorDependencies {
    readonly activate?: typeof activatePublishedProductionRelease;
    readonly artifactAdmission?: typeof prepareProductionArtifactAdmission;
    readonly buildRelease?: typeof buildDashboardRelease;
    readonly capacityAdmission?: typeof assertProductionArtifactCapacity;
    readonly createServices?: (
        lease: DashboardDeploymentLease,
        paths: PreparedProductionDeliveryPaths,
        readinessUrl: string
    ) => ProductionReleaseActivationDependencies["services"];
    readonly loadActivation?: typeof loadProductionActivationState;
    readonly loadArtifacts?: (
        paths: PreparedProductionDeliveryPaths,
        releaseId: string,
        runtimeRevision: string
    ) => Promise<
        Readonly<{
            release: PublishedProductionRelease;
            runtime: InstalledProductionRuntime;
        }>
    >;
    readonly installRuntime?: typeof installProductionRuntime;
    readonly nowMs?: () => number;
    readonly publishRelease?: typeof publishProductionRelease;
    readonly resolveSourceIdentity?: typeof resolveBuildSourceIdentity;
    readonly verifyQueuedRunBeforeSnapshot?: (
        paths: PreparedProductionDeliveryPaths,
        capsule: DeliveryProductionOperationCapsule
    ) => Promise<void>;
    readonly verifyPreviewTailscaleOperator?: () => Promise<void>;
    readonly verifyLocalRelease?: typeof verifyReleaseIdentity;
}

function failure(): Error {
    return new Error(executorFailureMessage);
}

interface QueuedProductionRunRow {
    readonly actionKey: string;
    readonly enqueueSha256: string;
    readonly idempotencyKey: string;
    readonly leaseExpiresAt: number | null;
    readonly leaseOwnerId: string | null;
    readonly leaseToken: string | null;
    readonly payloadJson: string;
    readonly queuedAtMs: number;
    readonly requestedById: string;
    readonly requestedByKind: string;
    readonly state: string;
}

interface EnqueueAuditRow {
    readonly action: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly authenticatorId: string | null;
    readonly occurredAtMs: number;
    readonly outcome: string;
    readonly requestId: string | null;
    readonly targetId: string;
    readonly targetType: string;
}

function sha256(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function verifyQueuedRunBeforeSnapshot(
    paths: PreparedProductionDeliveryPaths,
    capsule: DeliveryProductionOperationCapsule
): Promise<void> {
    const databasePath = path.join(paths.stateDirectory, "mira-dashboard.db");
    let database: Database | undefined;
    try {
        if (typeof process.getuid !== "function") throw failure();
        const [canonical, before] = await Promise.all([
            realpath(databasePath),
            lstat(databasePath, { bigint: true }),
        ]);
        if (
            canonical !== databasePath ||
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1n ||
            before.uid !== BigInt(process.getuid()) ||
            (before.mode & 0o7777n) !== 0o600n
        ) {
            throw failure();
        }
        database = new Database(databasePath, { readonly: true, strict: true });
        const run = database
            .query<QueuedProductionRunRow, [string]>(`
                SELECT
                    action_key AS actionKey,
                    enqueue_sha256 AS enqueueSha256,
                    idempotency_key AS idempotencyKey,
                    lease_expires_at AS leaseExpiresAt,
                    lease_owner_id AS leaseOwnerId,
                    lease_token AS leaseToken,
                    payload_json AS payloadJson,
                    queued_at AS queuedAtMs,
                    requested_by_id AS requestedById,
                    requested_by_kind AS requestedByKind,
                    state
                FROM job_runs
                WHERE id = ?1
                LIMIT 2
            `)
            .all(capsule.runId);
        const audit = database
            .query<EnqueueAuditRow, [string]>(`
                SELECT
                    action,
                    actor_id AS actorId,
                    actor_kind AS actorKind,
                    authenticator_id AS authenticatorId,
                    occurred_at AS occurredAtMs,
                    outcome,
                    request_id AS requestId,
                    target_id AS targetId,
                    target_type AS targetType
                FROM audit_events
                WHERE id = ?1
                LIMIT 2
            `)
            .all(capsule.enqueue.audit.eventId);
        const expectedPayload = JSON.stringify(capsule.enqueue.payload);
        if (
            run.length !== 1 ||
            audit.length !== 1 ||
            run[0]?.actionKey !== capsule.enqueue.actionKey ||
            run[0].state !== "queued" ||
            run[0].leaseOwnerId !== null ||
            run[0].leaseToken !== null ||
            run[0].leaseExpiresAt !== null ||
            run[0].enqueueSha256 !== capsule.enqueue.enqueueSha256 ||
            run[0].idempotencyKey !== capsule.enqueue.idempotencyKey ||
            run[0].payloadJson !== expectedPayload ||
            sha256(run[0].payloadJson) !== capsule.enqueue.payloadSha256 ||
            run[0].queuedAtMs !== capsule.enqueue.queuedAtMs ||
            run[0].requestedById !== capsule.enqueue.actor.id ||
            run[0].requestedByKind !== capsule.enqueue.actor.kind ||
            audit[0]?.action !== "delivery.operation.enqueue" ||
            audit[0].actorId !== capsule.enqueue.actor.id ||
            audit[0].actorKind !== capsule.enqueue.actor.kind ||
            audit[0].authenticatorId !== capsule.enqueue.actor.authenticatorId ||
            audit[0].occurredAtMs !== capsule.enqueue.queuedAtMs ||
            audit[0].outcome !== "accepted" ||
            audit[0].requestId !== capsule.enqueue.audit.requestId ||
            audit[0].targetId !== capsule.runId ||
            audit[0].targetType !== "job-run"
        ) {
            throw failure();
        }
        const after = await lstat(databasePath, { bigint: true });
        if (
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.ctimeNs !== before.ctimeNs ||
            after.size !== before.size ||
            after.uid !== before.uid ||
            (after.mode & 0o7777n) !== 0o600n
        ) {
            throw failure();
        }
    } catch {
        throw failure();
    } finally {
        database?.close(false);
    }
}

function readNamedArguments(arguments_: readonly string[]): Record<string, string> {
    const result = Object.create(null) as Record<string, string>;
    for (const argument of arguments_) {
        const separator = argument.indexOf("=");
        if (!argument.startsWith("--") || separator <= 2)
            throw new TypeError(executorUsage);
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!value || Object.hasOwn(result, name)) throw new TypeError(executorUsage);
        result[name] = value;
    }
    return result;
}

/**
 * Parses one of the three fixed, non-secret immutable executor operations.
 * @param arguments_ Fixed executor command-line arguments.
 * @returns A validated immutable executor operation.
 */
export function parseProductionDeliveryExecutorArguments(
    arguments_: readonly string[]
): ProductionDeliveryExecutorArguments {
    const named = readNamedArguments(arguments_);
    if (
        Object.keys(named).some(
            (name) =>
                !["operation", "project-root", "readiness-url", "transition"].includes(
                    name
                )
        )
    ) {
        throw new TypeError(executorUsage);
    }
    return Object.freeze(
        v.parse(argumentsSchema, {
            operation: named.operation,
            projectRoot: named["project-root"],
            ...(named["readiness-url"] === undefined
                ? {}
                : { readinessUrl: named["readiness-url"] }),
            ...(named.transition === undefined ? {} : { transitionId: named.transition }),
        })
    );
}

function activationMatchesCurrent(
    activation: ProductionActivationRecord | undefined,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>
): boolean {
    const current = record.capsule.cas.current;
    return (
        activation?.transitionId === current.activationTransitionId &&
        activation.current.releaseId === current.releaseId &&
        activation.current.runtimeRevision === current.runtimeRevision
    );
}

function activationMatchesTarget(
    activation: ProductionActivationRecord | undefined,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>
): boolean {
    const { current, target } = record.capsule.cas;
    return (
        activation?.transitionId === record.capsule.transitionId &&
        activation.current.releaseId === target.releaseId &&
        activation.current.runtimeRevision === target.runtimeRevision &&
        activation.previous?.databaseSnapshotTransitionId ===
            current.rollbackSnapshotTransitionId &&
        activation.previous.releaseId === current.releaseId &&
        activation.previous.runtimeRevision === current.runtimeRevision
    );
}

function requireProtocol(release: PublishedProductionRelease): void {
    if (
        !release.manifest.deliveryProtocols.includes(deliveryProductionProtocol) ||
        !release.manifest.processRoles.includes("production-delivery")
    ) {
        throw failure();
    }
}

async function loadExactArtifacts(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string,
    runtimeRevision: string
): Promise<
    Readonly<{ release: PublishedProductionRelease; runtime: InstalledProductionRuntime }>
> {
    const release = await loadPublishedProductionRelease(
        paths,
        releaseId,
        runtimeRevision
    );
    requireProtocol(release);
    const runtime = await loadInstalledProductionRuntime(paths, release.manifest.runtime);
    return Object.freeze({ release, runtime });
}

async function loadCurrentArtifacts(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string,
    runtimeRevision: string
): Promise<
    Readonly<{ release: PublishedProductionRelease; runtime: InstalledProductionRuntime }>
> {
    const release = await loadPublishedProductionRelease(
        paths,
        releaseId,
        runtimeRevision
    );
    const runtime = await loadInstalledProductionRuntime(paths, release.manifest.runtime);
    return Object.freeze({ release, runtime });
}

async function pathState(candidate: string): Promise<"missing" | "present"> {
    try {
        await lstat(candidate);
        return "present";
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
            return "missing";
        }
        throw failure();
    }
}

/**
 * Builds, capacity-admits, installs, and publishes one exact clean main release.
 * @param lease Held production deployment lease.
 * @param paths Descriptor-verified production paths.
 * @param projectRoot Canonical Dashboard project root.
 * @param record Exact in-progress operation record.
 * @param current Verified active release and runtime.
 * @param dependencies Optional fixed delivery seams.
 * @returns The verified published target release and runtime.
 */
export async function prepareProductionDeliveryTargetUnderLease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    projectRoot: string,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    current: Readonly<{
        release: PublishedProductionRelease;
        runtime: InstalledProductionRuntime;
    }>,
    dependencies: ProductionDeliveryExecutorDependencies
): Promise<
    Readonly<{ release: PublishedProductionRelease; runtime: InstalledProductionRuntime }>
> {
    const target = record.capsule.cas.target;
    const checkoutRoot = path.join(projectRoot, "production/checkout");
    const source = await (
        dependencies.resolveSourceIdentity ?? resolveBuildSourceIdentity
    )(checkoutRoot);
    if (source.state !== "clean" || source.commitSha !== target.releaseId) {
        throw failure();
    }

    const publishedRoot = path.join(paths.releasesDirectory, target.releaseId);
    if ((await pathState(publishedRoot)) === "present") {
        return loadExactArtifacts(paths, target.releaseId, target.runtimeRevision);
    }

    const localReleaseRoot = path.join(checkoutRoot, "dist/releases", target.releaseId);
    let sourceRelease: Awaited<ReturnType<typeof buildDashboardRelease>>;
    if ((await pathState(localReleaseRoot)) === "present") {
        const manifest = await (dependencies.verifyLocalRelease ?? verifyReleaseIdentity)(
            localReleaseRoot,
            current.runtime.identity
        );
        sourceRelease = Object.freeze({ manifest, releaseRoot: localReleaseRoot });
    } else {
        sourceRelease = await (dependencies.buildRelease ?? buildDashboardRelease)(
            checkoutRoot,
            { runtimeIdentity: current.runtime.identity }
        );
    }
    if (
        sourceRelease.manifest.source.commitSha !== target.releaseId ||
        sourceRelease.manifest.runtime.revision !== target.runtimeRevision
    ) {
        throw failure();
    }
    requireProtocol(
        Object.freeze({
            manifest: sourceRelease.manifest,
            releaseRoot: sourceRelease.releaseRoot,
        })
    );
    await (dependencies.capacityAdmission ?? assertProductionArtifactCapacity)(
        lease,
        paths,
        sourceRelease.releaseRoot,
        sourceRelease.manifest,
        current.runtime.executable
    );
    const runtime = await (dependencies.installRuntime ?? installProductionRuntime)(
        lease,
        paths,
        sourceRelease.manifest.runtime,
        { sourceExecutable: current.runtime.executable }
    );
    const release = await (dependencies.publishRelease ?? publishProductionRelease)(
        lease,
        paths,
        sourceRelease.releaseRoot,
        sourceRelease.manifest.runtime
    );
    requireProtocol(release);
    return Object.freeze({ release, runtime });
}

async function advanceTo(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    target: DeliveryProductionOperationPhase,
    nowMs: () => number
): Promise<Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>> {
    let current = record;
    const currentIndex = deliveryProductionOperationPhases.indexOf(current.phase);
    const targetIndex = deliveryProductionOperationPhases.indexOf(target);
    if (targetIndex <= currentIndex) return current;
    for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
        current = await advanceDeliveryProductionOperation(
            lease,
            paths,
            current,
            deliveryProductionOperationPhases[index]!,
            Math.max(nowMs(), current.updatedAtMs)
        );
    }
    return current;
}

function activationOptionsFor(
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    onProgress: NonNullable<ProductionReleaseActivationOptions["onProgress"]>
): ProductionReleaseActivationOptions {
    return Object.freeze({
        onProgress,
        targetDatabaseSnapshotTransitionId:
            record.capsule.cas.target.databaseSnapshotTransitionId ?? undefined,
        transitionId: record.capsule.transitionId,
    });
}

async function terminalFailure(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    nowMs: () => number,
    loadActivation: typeof loadProductionActivationState
): Promise<DeliveryProductionTerminalRecord> {
    let activation: ProductionActivationRecord | undefined;
    try {
        const loadedActivation = await loadActivation(lease, paths);
        activation = loadedActivation.record;
    } catch {
        // A receipt remains unknown when authoritative activation state cannot be read.
    }
    const completedAtMs = Math.max(nowMs(), record.updatedAtMs);
    const result: DeliveryProductionTerminalResult = activationMatchesCurrent(
        activation,
        record
    )
        ? {
              activation: activation ?? null,
              completedAtMs,
              outcome: "failed",
              reason: "activation-failed",
          }
        : {
              activation: activationMatchesTarget(activation, record)
                  ? (activation ?? null)
                  : null,
              completedAtMs,
              outcome: "unknown-outcome",
          };
    return completeDeliveryProductionOperation(lease, paths, record, result);
}

function loadExecutorArtifacts(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string,
    runtimeRevision: string,
    dependencies: ProductionDeliveryExecutorDependencies
): Promise<
    Readonly<{ release: PublishedProductionRelease; runtime: InstalledProductionRuntime }>
> {
    return (
        dependencies.loadArtifacts ??
        ((_paths, exactReleaseId, exactRuntimeRevision) =>
            loadExactArtifacts(_paths, exactReleaseId, exactRuntimeRevision))
    )(paths, releaseId, runtimeRevision);
}

async function restartNormalRuntimeAfterReceipt(
    _paths: PreparedProductionDeliveryPaths,
    receipt: DeliveryProductionTerminalRecord,
    services: ProductionServiceController,
    dependencies: ProductionDeliveryExecutorDependencies
): Promise<void> {
    const activation = receipt.result.activation;
    if (activation === null) throw failure();
    const active = await loadExecutorArtifacts(
        _paths,
        activation.current.releaseId,
        activation.current.runtimeRevision,
        dependencies
    );
    await services.prepare(active.release, active.runtime);
    await services.start(active.release, active.runtime);
    await services.verifyReady(active.release, active.runtime);
}

async function completeAndRestartNormalRuntime(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    result: DeliveryProductionTerminalResult,
    services: ProductionServiceController,
    dependencies: ProductionDeliveryExecutorDependencies
): Promise<DeliveryProductionTerminalRecord> {
    const receipt = await completeDeliveryProductionOperation(
        lease,
        paths,
        record,
        result
    );
    // The durable terminal receipt changes the next boot from smoke-only validation
    // to the normal runtime. Restart only after that fsync boundary, then prove the
    // exact receipt-owned release reached normal readiness.
    await restartNormalRuntimeAfterReceipt(paths, receipt, services, dependencies);
    return receipt;
}

/**
 * Runs or reconciles one exact receipt-backed production cutover under the deployment lease.
 * @param lease Held production deployment lease.
 * @param paths Descriptor-verified production paths.
 * @param options Exact cutover operation and transition.
 * @param dependencies Optional fixed delivery seams.
 * @returns The durable terminal operation receipt.
 */
export async function runProductionDeliveryExecutorUnderLease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    options: Extract<ProductionDeliveryExecutorArguments, { operation: "cutover" }>,
    dependencies: ProductionDeliveryExecutorDependencies = {}
): Promise<DeliveryProductionTerminalRecord> {
    const nowMs = dependencies.nowMs ?? Date.now;
    const loadActivation = dependencies.loadActivation ?? loadProductionActivationState;
    const inspection = await inspectDeliveryProductionOperation(lease, paths);
    if (
        inspection.state === "conflict" ||
        inspection.state === "missing" ||
        inspection.transitionId !== options.transitionId
    ) {
        throw failure();
    }
    if (inspection.state === "terminal") return inspection.record;

    await (
        dependencies.verifyPreviewTailscaleOperator ?? verifyPreviewTailscaleOperator
    )().catch(() => {
        throw failure();
    });

    let record = inspection.record;
    if (record.phase === "intent-recorded") {
        record = await advanceTo(lease, paths, record, "executor-confirmed", nowMs);
    }
    if (record.phase === "intent-recorded") throw failure();

    let services: ProductionServiceController | undefined;
    try {
        services =
            dependencies.createServices?.(lease, paths, options.readinessUrl) ??
            createSystemdProductionServiceController(lease, paths, {
                readinessUrl: options.readinessUrl,
            });
        if (dependencies.loadArtifacts === undefined) {
            await (dependencies.artifactAdmission ?? prepareProductionArtifactAdmission)(
                lease,
                paths,
                { services }
            );
        }
        const loadedActivation = await loadActivation(lease, paths);
        const observed = loadedActivation.record;
        if (activationMatchesTarget(observed, record)) {
            if (record.phase !== "target-smoke-verified") throw failure();
            const activeTarget = await loadExecutorArtifacts(
                paths,
                record.capsule.cas.target.releaseId,
                record.capsule.cas.target.runtimeRevision,
                dependencies
            );
            await services.verifyReady(activeTarget.release, activeTarget.runtime);
            return completeAndRestartNormalRuntime(
                lease,
                paths,
                record,
                {
                    activation: observed!,
                    completedAtMs: Math.max(nowMs(), record.updatedAtMs),
                    outcome: "succeeded",
                },
                services,
                dependencies
            );
        }
        if (!activationMatchesCurrent(observed, record)) throw failure();

        const current = await (dependencies.loadArtifacts ?? loadCurrentArtifacts)(
            paths,
            record.capsule.cas.current.releaseId,
            record.capsule.cas.current.runtimeRevision
        );
        let target: Readonly<{
            release: PublishedProductionRelease;
            runtime: InstalledProductionRuntime;
        }>;
        if (dependencies.loadArtifacts !== undefined) {
            target = await dependencies.loadArtifacts(
                paths,
                record.capsule.cas.target.releaseId,
                record.capsule.cas.target.runtimeRevision
            );
        } else if (record.capsule.enqueue.payload.operation === "rollback-release") {
            target = await loadExactArtifacts(
                paths,
                record.capsule.cas.target.releaseId,
                record.capsule.cas.target.runtimeRevision
            );
        } else {
            target = await prepareProductionDeliveryTargetUnderLease(
                lease,
                paths,
                options.projectRoot,
                record,
                current,
                dependencies
            );
        }
        if (
            current.release.manifest.source.commitSha ===
            target.release.manifest.source.commitSha
        ) {
            throw failure();
        }
        const progress: NonNullable<
            ProductionReleaseActivationOptions["onProgress"]
        > = async (phase) => {
            record = await advanceTo(lease, paths, record, phase, nowMs);
            if (phase === "services-stopped") {
                await (
                    dependencies.verifyQueuedRunBeforeSnapshot ??
                    verifyQueuedRunBeforeSnapshot
                )(paths, record.capsule);
            }
        };
        const activation = await Effect.runPromise(
            (dependencies.activate ?? activatePublishedProductionRelease)(
                lease,
                paths,
                target.release,
                target.runtime,
                { services },
                activationOptionsFor(record, progress)
            )
        );
        if (record.phase !== "target-smoke-verified") throw failure();
        return completeAndRestartNormalRuntime(
            lease,
            paths,
            record,
            {
                activation,
                completedAtMs: Math.max(nowMs(), record.updatedAtMs),
                outcome: "succeeded",
            },
            services,
            dependencies
        );
    } catch {
        const terminal = await inspectDeliveryProductionOperation(lease, paths);
        if (terminal.state === "terminal") throw failure();
        const receipt = await terminalFailure(
            lease,
            paths,
            record,
            nowMs,
            loadActivation
        );
        if (services !== undefined && receipt.result.activation !== null) {
            await restartNormalRuntimeAfterReceipt(
                paths,
                receipt,
                services,
                dependencies
            );
        }
        return receipt;
    }
}

/**
 * Prepares protected paths, holds the single deployment lease, and runs one operation.
 * @param options Exact cutover operation and transition.
 * @param dependencies Optional fixed delivery seams.
 * @returns The durable terminal operation receipt.
 */
export async function runProductionDeliveryExecutor(
    options: Extract<ProductionDeliveryExecutorArguments, { operation: "cutover" }>,
    dependencies: ProductionDeliveryExecutorDependencies = {}
): Promise<DeliveryProductionTerminalRecord> {
    const state = await prepareProtectedProductionStatePath(options.projectRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return withDeploymentLease(paths.stateDirectory, (lease) =>
        runProductionDeliveryExecutorUnderLease(lease, paths, options, dependencies)
    );
}

/**
 * Fsyncs or exactly replays one worker-authorized production intent.
 * @param projectRoot Canonical Dashboard project root.
 * @param untrustedCapsule Worker-authorized operation capsule.
 * @param nowMs Fixed time boundary used by deterministic callers.
 * @returns The exact in-progress operation record.
 */
export async function prepareProductionDeliveryOperation(
    projectRoot: string,
    untrustedCapsule: DeliveryProductionOperationCapsule,
    nowMs: () => number = Date.now
): Promise<Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>> {
    const canonicalRoot = v.parse(absoluteProjectRootSchema, projectRoot);
    const capsule = parseDeliveryProductionOperationCapsule(untrustedCapsule);
    const state = await prepareProtectedProductionStatePath(canonicalRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return withDeploymentLease(paths.stateDirectory, async (lease) => {
        const existing = await inspectDeliveryProductionReceipt(
            lease,
            paths,
            capsule.transitionId
        );
        if (existing.state === "in-progress") {
            if (JSON.stringify(existing.record.capsule) !== JSON.stringify(capsule)) {
                throw failure();
            }
            return existing.record;
        }
        if (existing.state !== "missing") throw failure();
        return createDeliveryProductionOperation(
            lease,
            paths,
            capsule,
            Math.max(nowMs(), capsule.enqueue.queuedAtMs)
        );
    });
}

/**
 * Reads one exact active or historical operation for startup and claim recovery.
 * @param projectRoot Canonical Dashboard project root.
 * @param transitionId Exact operation transition.
 * @returns The bounded operation inspection.
 */
export async function inspectProductionDeliveryOperation(
    projectRoot: string,
    transitionId: string
): Promise<DeliveryProductionOperationInspection> {
    const canonicalRoot = v.parse(absoluteProjectRootSchema, projectRoot);
    const canonicalTransition = v.parse(
        lowercaseUuidV7Schema(executorUsage),
        transitionId
    );
    const state = await prepareProtectedProductionStatePath(canonicalRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return withDeploymentLease(paths.stateDirectory, (lease) =>
        inspectDeliveryProductionReceipt(lease, paths, canonicalTransition)
    );
}

/**
 * Reads the single active operation, or reports that no cutover fences startup.
 * @param projectRoot Canonical Dashboard project root.
 * @returns The bounded active operation inspection.
 */
export async function inspectActiveProductionDeliveryOperation(
    projectRoot: string
): Promise<DeliveryProductionOperationInspection> {
    const canonicalRoot = v.parse(absoluteProjectRootSchema, projectRoot);
    const state = await prepareProtectedProductionStatePath(canonicalRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return withDeploymentLease(paths.stateDirectory, (lease) =>
        inspectDeliveryProductionOperation(lease, paths)
    );
}

/**
 * Clears only an exact receipt-backed active marker after Job recovery is durable.
 * @param projectRoot Canonical Dashboard project root.
 * @param transitionId Exact terminal operation transition.
 * @returns The verified terminal receipt that owned the marker.
 */
export async function clearProductionDeliveryOperationMarker(
    projectRoot: string,
    transitionId: string
): Promise<DeliveryProductionTerminalRecord> {
    const canonicalRoot = v.parse(absoluteProjectRootSchema, projectRoot);
    const canonicalTransition = v.parse(
        lowercaseUuidV7Schema(executorUsage),
        transitionId
    );
    const state = await prepareProtectedProductionStatePath(canonicalRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return withDeploymentLease(paths.stateDirectory, async (lease) => {
        const inspection = await inspectDeliveryProductionReceipt(
            lease,
            paths,
            canonicalTransition
        );
        if (inspection.state !== "terminal") throw failure();
        await clearDeliveryProductionOperation(lease, paths, inspection.record);
        return inspection.record;
    });
}

async function readCapsuleFromStandardInput(): Promise<DeliveryProductionOperationCapsule> {
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > deliveryProductionOperationMaximumBytes) throw failure();
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseDeliveryProductionOperationCapsule(JSON.parse(text) as unknown);
}

if (import.meta.main) {
    try {
        const options = parseProductionDeliveryExecutorArguments(Bun.argv.slice(2));
        if (options.operation === "prepare") {
            const record = await prepareProductionDeliveryOperation(
                options.projectRoot,
                await readCapsuleFromStandardInput()
            );
            process.stdout.write(serializeDeliveryProductionOperationRecord(record));
        } else if (options.operation === "inspect") {
            const inspection = await inspectProductionDeliveryOperation(
                options.projectRoot,
                options.transitionId
            );
            process.stdout.write(`${JSON.stringify(inspection)}\n`);
        } else if (options.operation === "inspect-active") {
            const inspection = await inspectActiveProductionDeliveryOperation(
                options.projectRoot
            );
            process.stdout.write(`${JSON.stringify(inspection)}\n`);
        } else if (options.operation === "clear") {
            const receipt = await clearProductionDeliveryOperationMarker(
                options.projectRoot,
                options.transitionId
            );
            process.stdout.write(serializeDeliveryProductionOperationRecord(receipt));
        } else {
            const receipt = await runProductionDeliveryExecutor(options);
            process.stdout.write(
                `${JSON.stringify({
                    outcome: receipt.result.outcome,
                    status: "TERMINAL",
                    transitionId: receipt.capsule.transitionId,
                })}\n`
            );
        }
    } catch (error) {
        process.stderr.write(
            `${error instanceof TypeError ? error.message : executorFailureMessage}\n`
        );
        process.exitCode = 1;
    }
}
