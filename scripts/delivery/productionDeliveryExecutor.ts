import { Database } from "bun:sqlite";
import { lstat, readFile, realpath } from "node:fs/promises";
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
import {
    preparePublishedProductionRelease,
    productionBootstrapDependencies,
} from "../productionBootstrap.ts";
import { buildDashboardRelease } from "./buildRelease.ts";
import { withDeploymentLease, type DashboardDeploymentLease } from "./deploymentLease.ts";
import { loadProductionActivationState } from "./productionActivationState.ts";
import { assertProductionArtifactCapacity } from "./productionArtifactCapacity.ts";
import {
    clearProductionDeliveryExecutorOwner,
    commitProductionDeliveryExecutorOwner,
    loadProductionDeliveryExecutorOwnerState,
} from "./productionDeliveryExecutorOwnerState.ts";
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
import { admitProductionReleasePreparation } from "./productionReleasePreparationCapacity.ts";
import {
    discardOwnedProductionReleaseCandidate,
    loadPublishedProductionRelease,
    loadDescribedPublishedProductionReleaseById,
    publishDescribedProductionRelease,
    publishProductionRelease,
    type DescribedPublishedProductionRelease,
    type PublishedProductionRelease,
} from "./productionReleasePublication.ts";
import {
    installProductionRuntime,
    loadInstalledProductionRuntime,
    type InstalledProductionRuntime,
} from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import { productionHostProvisioningRoot } from "./provisioning/host-operations/policy.ts";
import { verifyPreviewTailscaleOperator } from "./provisioning/preview-tailscale/operator.ts";
import {
    verifyReleaseArtifactIdentity,
    verifyReleaseIdentity,
} from "./releaseIdentity.ts";
import { createSystemdProductionServiceController } from "./systemdProductionServices.ts";

const executorFailureMessage = "Production Delivery executor failed";
const executorUsage =
    "Usage: bun productionDelivery.js --operation=prepare|inspect|inspect-active|clear|cutover --project-root=/absolute/project [--artifact-source=published-release|retained] [--readiness-url=http://127.0.0.1:PORT/api/health/ready] [--transition=uuid-v7]";
const admitProductionDeliveryArtifacts: typeof assertProductionArtifactCapacity = (
    lease,
    paths,
    sourceReleaseRoot,
    sourceManifest,
    sourceExecutable
) =>
    assertProductionArtifactCapacity(
        lease,
        paths,
        sourceReleaseRoot,
        sourceManifest,
        sourceExecutable,
        {
            additionalReleaseCopyDirectory: productionHostProvisioningRoot,
        }
    );
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
        operation: v.literal("inspect-owner"),
        projectRoot: absoluteProjectRootSchema,
    }),
    v.strictObject({
        operation: v.literal("clear"),
        projectRoot: absoluteProjectRootSchema,
        transitionId: lowercaseUuidV7Schema(executorUsage),
    }),
    v.strictObject({
        artifactSource: v.picklist(["published-release", "retained"], executorUsage),
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
    readonly discardCandidate?: typeof discardOwnedProductionReleaseCandidate;
    readonly loadActivation?: typeof loadProductionActivationState;
    readonly loadCurrentArtifacts?: (
        paths: PreparedProductionDeliveryPaths,
        releaseId: string,
        runtimeRevision: string
    ) => Promise<
        Readonly<{
            release: DescribedPublishedProductionRelease;
            runtime: InstalledProductionRuntime;
        }>
    >;
    readonly loadTargetArtifacts?: (
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
    readonly publishDescribedRelease?: typeof publishDescribedProductionRelease;
    readonly preparePublishedRelease?: typeof preparePublishedProductionRelease;
    readonly preparationCapacityAdmission?: (checkoutRoot: string) => Promise<void>;
    readonly resolveSourceIdentity?: typeof resolveBuildSourceIdentity;
    readonly verifyRunBeforeSnapshot?: (
        paths: PreparedProductionDeliveryPaths,
        capsule: DeliveryProductionOperationCapsule
    ) => Promise<void>;
    readonly verifyPreviewTailscaleOperator?: () => Promise<void>;
    readonly verifyLocalRelease?: typeof verifyReleaseIdentity;
    readonly verifyExecutorOwnerTarget?: (
        projectRoot: string,
        releaseId: string,
        runtimeRevision: string
    ) => Promise<void>;
}

class TargetExecutorHandoff extends Error {
    override readonly name = "TargetExecutorHandoff";
}

function failure(): Error {
    return new Error(executorFailureMessage);
}

interface ProductionRunRow {
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

/**
 * Compares exact release-manifest bytes with the published release authority.
 * @param manifestBytes Exact immutable manifest bytes.
 * @param expectedSha256 Published manifest digest.
 * @returns Whether the cached bytes belong to the authorized release assets.
 */
export function releaseManifestMatchesAuthority(
    manifestBytes: Uint8Array,
    expectedSha256: string
): boolean {
    return (
        new Bun.CryptoHasher("sha256").update(manifestBytes).digest("hex") ===
        expectedSha256
    );
}

async function verifyRetainedDeployAuthority(
    publishedRoot: string,
    authority: Readonly<{
        releaseDescriptorSha256: string;
        releaseManifestSha256: string;
    }>
): Promise<void> {
    let descriptorBytes: Uint8Array;
    let manifestBytes: Uint8Array;
    try {
        [descriptorBytes, manifestBytes] = await Promise.all([
            readFile(path.join(publishedRoot, "release-descriptor.json")),
            readFile(path.join(publishedRoot, "release-manifest.json")),
        ]);
    } catch {
        throw failure();
    }
    if (
        !releaseManifestMatchesAuthority(
            descriptorBytes,
            authority.releaseDescriptorSha256
        ) ||
        !releaseManifestMatchesAuthority(manifestBytes, authority.releaseManifestSha256)
    ) {
        throw failure();
    }
}

function hasValidProductionRunState(run: ProductionRunRow): boolean {
    if (run.state === "queued") {
        return (
            run.leaseOwnerId === null &&
            run.leaseToken === null &&
            run.leaseExpiresAt === null
        );
    }
    return (
        run.state === "running" &&
        run.leaseOwnerId !== null &&
        run.leaseToken !== null &&
        run.leaseExpiresAt !== null
    );
}

export async function verifyProductionRunBeforeSnapshot(
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
            .query<ProductionRunRow, [string]>(
                `
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
            `
            )
            .all(capsule.runId);
        const audit = database
            .query<EnqueueAuditRow, [string]>(
                `
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
            `
            )
            .all(capsule.enqueue.audit.eventId);
        const expectedPayload = JSON.stringify(capsule.enqueue.payload);
        if (
            run.length !== 1 ||
            audit.length !== 1 ||
            run[0]?.actionKey !== capsule.enqueue.actionKey ||
            !hasValidProductionRunState(run[0]) ||
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
                ![
                    "artifact-source",
                    "operation",
                    "project-root",
                    "readiness-url",
                    "transition",
                ].includes(name)
        )
    ) {
        throw new TypeError(executorUsage);
    }
    return Object.freeze(
        v.parse(argumentsSchema, {
            ...(named["artifact-source"] === undefined
                ? {}
                : { artifactSource: named["artifact-source"] }),
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

/**
 * Checks one release against the current Delivery execution contract.
 * @param release Verified published release.
 * @returns Whether the release declares the current protocol and process role.
 */
export function releaseSupportsCurrentDeliveryProtocol(
    release: PublishedProductionRelease
): boolean {
    return (
        release.manifest.deliveryProtocols.includes(deliveryProductionProtocol) &&
        release.manifest.processRoles.includes("production-delivery")
    );
}

function requireProtocol(release: PublishedProductionRelease): void {
    if (!releaseSupportsCurrentDeliveryProtocol(release)) throw failure();
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
    Readonly<{
        release: DescribedPublishedProductionRelease;
        runtime: InstalledProductionRuntime;
    }>
> {
    const release = await loadDescribedPublishedProductionReleaseById(paths, releaseId);
    if (release.descriptor.runtime.revision !== runtimeRevision) throw failure();
    const runtime = await loadInstalledProductionRuntime(paths, {
        revision: release.descriptor.runtime.revision,
        version: release.descriptor.runtime.version,
    });
    return Object.freeze({ release, runtime });
}

type ExecutorCurrentArtifacts = Readonly<{
    release: DescribedPublishedProductionRelease;
    runtime: InstalledProductionRuntime;
}>;

function currentReleaseId(current: ExecutorCurrentArtifacts): string {
    return current.release.descriptor.releaseId;
}

async function resolveDescriptorVerifiedExecutor(
    paths: PreparedProductionDeliveryPaths,
    releaseId: string,
    runtimeRevision: string
) {
    const release = await loadDescribedPublishedProductionReleaseById(paths, releaseId);
    if (release.descriptor.runtime.revision !== runtimeRevision) throw failure();
    const runtime = await loadInstalledProductionRuntime(paths, {
        revision: release.descriptor.runtime.revision,
        version: release.descriptor.runtime.version,
    });
    return Object.freeze({
        executor: path.join(
            release.releaseRoot,
            release.descriptor.deliveryExecutor.path
        ),
        releaseRoot: release.releaseRoot,
        runtimeExecutable: runtime.executable,
    });
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
 * @param artifactSource Whether a missing target may be admitted from its published release.
 * @param dependencies Optional fixed delivery seams.
 * @returns The verified published target release and runtime.
 */
export async function prepareProductionDeliveryTargetUnderLease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    projectRoot: string,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    current: ExecutorCurrentArtifacts,
    artifactSource: "published-release" | "retained",
    dependencies: ProductionDeliveryExecutorDependencies
): Promise<
    Readonly<{ release: PublishedProductionRelease; runtime: InstalledProductionRuntime }>
> {
    const target = record.capsule.cas.target;
    const publishedRoot = path.join(paths.releasesDirectory, target.releaseId);
    if ((await pathState(publishedRoot)) === "present") {
        if (record.capsule.enqueue.payload.operation === "deploy") {
            await verifyRetainedDeployAuthority(
                publishedRoot,
                record.capsule.enqueue.payload.release
            );
        }
        return loadExactArtifacts(paths, target.releaseId, target.runtimeRevision);
    }
    if (artifactSource === "retained") throw failure();
    const checkoutRoot = path.join(projectRoot, "production/checkout");
    const source = await (
        dependencies.resolveSourceIdentity ?? resolveBuildSourceIdentity
    )(checkoutRoot);
    if (source.state !== "clean" || source.commitSha !== target.releaseId) {
        throw failure();
    }

    const usesTestBuildSeams =
        dependencies.preparePublishedRelease === undefined &&
        (dependencies.buildRelease !== undefined ||
            dependencies.verifyLocalRelease !== undefined);
    let admittedPublishedRelease:
        | Awaited<ReturnType<typeof preparePublishedProductionRelease>>
        | undefined;
    if (!usesTestBuildSeams) {
        await (
            dependencies.preparationCapacityAdmission ?? admitProductionReleasePreparation
        )(checkoutRoot, productionHostProvisioningRoot);
        admittedPublishedRelease = await (
            dependencies.preparePublishedRelease ?? preparePublishedProductionRelease
        )(
            target.releaseId,
            checkoutRoot,
            productionBootstrapDependencies,
            undefined,
            undefined,
            record.capsule.enqueue.payload.operation === "deploy"
                ? record.capsule.enqueue.payload.release
                : undefined,
            { stageRootAuthority: false }
        );
    }

    const localReleaseRoot = path.join(checkoutRoot, "dist/releases", target.releaseId);
    try {
        let sourceRelease: Awaited<ReturnType<typeof buildDashboardRelease>>;
        if (admittedPublishedRelease !== undefined) {
            const manifest =
                dependencies.verifyLocalRelease === undefined
                    ? await verifyReleaseArtifactIdentity(
                          admittedPublishedRelease.releaseRoot
                      )
                    : await dependencies.verifyLocalRelease(
                          admittedPublishedRelease.releaseRoot,
                          admittedPublishedRelease.authority.runtime
                      );
            sourceRelease = Object.freeze({
                manifest,
                releaseRoot: admittedPublishedRelease.releaseRoot,
            });
        } else if ((await pathState(localReleaseRoot)) === "present") {
            const manifest = await (
                dependencies.verifyLocalRelease ?? verifyReleaseIdentity
            )(localReleaseRoot, current.runtime.identity);
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
        const candidateRuntimeExecutable = path.join(
            sourceRelease.releaseRoot,
            "runtime/bun"
        );
        await (dependencies.capacityAdmission ?? admitProductionDeliveryArtifacts)(
            lease,
            paths,
            sourceRelease.releaseRoot,
            sourceRelease.manifest,
            candidateRuntimeExecutable
        );
        const runtime = await (dependencies.installRuntime ?? installProductionRuntime)(
            lease,
            paths,
            sourceRelease.manifest.runtime,
            { sourceExecutable: candidateRuntimeExecutable }
        );
        const release = await (dependencies.publishRelease ?? publishProductionRelease)(
            lease,
            paths,
            sourceRelease.releaseRoot,
            sourceRelease.manifest.runtime
        );
        requireProtocol(release);
        return Object.freeze({ release, runtime });
    } finally {
        if (admittedPublishedRelease !== undefined) {
            await (
                dependencies.discardCandidate ?? discardOwnedProductionReleaseCandidate
            )(path.dirname(localReleaseRoot), localReleaseRoot, target.releaseId);
        }
    }
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
        dependencies.loadTargetArtifacts ??
        ((_paths, exactReleaseId, exactRuntimeRevision) =>
            loadExactArtifacts(_paths, exactReleaseId, exactRuntimeRevision))
    )(paths, releaseId, runtimeRevision);
}

async function restartNormalRuntime(
    paths: PreparedProductionDeliveryPaths,
    activation: ProductionActivationRecord,
    services: ProductionServiceController,
    dependencies: ProductionDeliveryExecutorDependencies
): Promise<void> {
    const active = await (dependencies.loadCurrentArtifacts ?? loadCurrentArtifacts)(
        paths,
        activation.current.releaseId,
        activation.current.runtimeRevision
    );
    await services.settle?.(active.release, active.runtime);
    await services.prepare(active.release, active.runtime);
    await services.start(active.release, active.runtime);
    await services.verifyReady(active.release, active.runtime);
}

async function completeAfterNormalRuntimeReady(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    record: Exclude<DeliveryProductionOperationRecord, { phase: "terminal" }>,
    activation: ProductionActivationRecord,
    nowMs: () => number,
    services: ProductionServiceController,
    dependencies: ProductionDeliveryExecutorDependencies
): Promise<DeliveryProductionTerminalRecord> {
    await restartNormalRuntime(paths, activation, services, dependencies);
    return completeDeliveryProductionOperation(lease, paths, record, {
        activation,
        completedAtMs: Math.max(nowMs(), record.updatedAtMs),
        outcome: "succeeded",
    });
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

    let ownerState = await loadProductionDeliveryExecutorOwnerState(lease, paths);
    if (ownerState.owner === undefined) {
        ownerState = await commitProductionDeliveryExecutorOwner(
            lease,
            paths,
            ownerState,
            {
                formatVersion: 1,
                releaseId: inspection.record.capsule.executor.releaseId,
                runtimeRevision: inspection.record.capsule.executor.runtimeRevision,
                transitionId: inspection.transitionId,
            }
        );
    }
    if (ownerState.owner?.transitionId !== inspection.transitionId) throw failure();

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
        const targetIdentity = record.capsule.cas.target;
        const currentOwner = ownerState.owner;
        if (
            dependencies.loadTargetArtifacts === undefined &&
            record.capsule.enqueue.payload.operation === "deploy" &&
            (currentOwner?.releaseId !== targetIdentity.releaseId ||
                currentOwner.runtimeRevision !== targetIdentity.runtimeRevision)
        ) {
            const publishedRoot = path.join(
                paths.releasesDirectory,
                targetIdentity.releaseId
            );
            let described;
            if ((await pathState(publishedRoot)) === "present") {
                await verifyRetainedDeployAuthority(
                    publishedRoot,
                    record.capsule.enqueue.payload.release
                );
                described = await loadDescribedPublishedProductionReleaseById(
                    paths,
                    targetIdentity.releaseId
                );
            } else {
                if (
                    options.artifactSource !== "published-release" ||
                    record.capsule.enqueue.payload.operation !== "deploy"
                ) {
                    throw failure();
                }
                const checkoutRoot = path.join(
                    options.projectRoot,
                    "production/checkout"
                );
                await (
                    dependencies.preparationCapacityAdmission ??
                    ((root) =>
                        admitProductionReleasePreparation(
                            root,
                            productionHostProvisioningRoot
                        ))
                )(checkoutRoot);
                const admitted = await (
                    dependencies.preparePublishedRelease ??
                    preparePublishedProductionRelease
                )(
                    targetIdentity.releaseId,
                    checkoutRoot,
                    productionBootstrapDependencies,
                    undefined,
                    undefined,
                    record.capsule.enqueue.payload.release,
                    { stageRootAuthority: false }
                );
                try {
                    described = await (
                        dependencies.publishDescribedRelease ??
                        publishDescribedProductionRelease
                    )(lease, paths, admitted.releaseRoot);
                } finally {
                    await (
                        dependencies.discardCandidate ??
                        discardOwnedProductionReleaseCandidate
                    )(
                        path.dirname(admitted.releaseRoot),
                        admitted.releaseRoot,
                        targetIdentity.releaseId
                    );
                }
            }
            if (
                described.descriptor.releaseId !== targetIdentity.releaseId ||
                described.descriptor.runtime.revision !== targetIdentity.runtimeRevision
            ) {
                throw failure();
            }
            await (dependencies.installRuntime ?? installProductionRuntime)(
                lease,
                paths,
                {
                    revision: described.descriptor.runtime.revision,
                    version: described.descriptor.runtime.version,
                },
                { sourceExecutable: path.join(described.releaseRoot, "runtime/bun") }
            );
            record = await advanceTo(
                lease,
                paths,
                record,
                "target-executor-admitted",
                nowMs
            );
            ownerState = await commitProductionDeliveryExecutorOwner(
                lease,
                paths,
                ownerState,
                {
                    formatVersion: 1,
                    releaseId: targetIdentity.releaseId,
                    runtimeRevision: targetIdentity.runtimeRevision,
                    transitionId: record.capsule.transitionId,
                }
            );
            await advanceTo(
                lease,
                paths,
                record,
                "target-executor-owner-transferred",
                nowMs
            );
            throw new TargetExecutorHandoff();
        }

        services =
            dependencies.createServices?.(lease, paths, options.readinessUrl) ??
            createSystemdProductionServiceController(lease, paths, {
                readinessUrl: options.readinessUrl,
                releaseAuthority:
                    record.capsule.enqueue.payload.operation === "deploy"
                        ? record.capsule.enqueue.payload.release
                        : undefined,
            });
        if (dependencies.loadTargetArtifacts === undefined) {
            await (dependencies.artifactAdmission ?? prepareProductionArtifactAdmission)(
                lease,
                paths,
                { services }
            );
        }
        const loadedActivation = await loadActivation(lease, paths);
        const observed = loadedActivation.record;
        if (activationMatchesTarget(observed, record)) {
            if (
                record.phase !== "target-smoke-verified" &&
                record.phase !== "normal-runtime-starting"
            ) {
                throw failure();
            }
            const activeTarget = await loadExecutorArtifacts(
                paths,
                record.capsule.cas.target.releaseId,
                record.capsule.cas.target.runtimeRevision,
                dependencies
            );
            await services.verifyReady(activeTarget.release, activeTarget.runtime);
            record = await advanceTo(
                lease,
                paths,
                record,
                "normal-runtime-starting",
                nowMs
            );
            return await completeAfterNormalRuntimeReady(
                lease,
                paths,
                record,
                observed!,
                nowMs,
                services,
                dependencies
            );
        }
        if (!activationMatchesCurrent(observed, record)) throw failure();

        const current = await (dependencies.loadCurrentArtifacts ?? loadCurrentArtifacts)(
            paths,
            record.capsule.cas.current.releaseId,
            record.capsule.cas.current.runtimeRevision
        );
        let target: Readonly<{
            release: PublishedProductionRelease;
            runtime: InstalledProductionRuntime;
        }>;
        if (dependencies.loadTargetArtifacts !== undefined) {
            target = await dependencies.loadTargetArtifacts(
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
                options.artifactSource,
                dependencies
            );
        }
        if (currentReleaseId(current) === target.release.manifest.source.commitSha) {
            throw failure();
        }
        const progress: NonNullable<
            ProductionReleaseActivationOptions["onProgress"]
        > = async (phase) => {
            record = await advanceTo(lease, paths, record, phase, nowMs);
            if (phase === "services-stopped") {
                await (
                    dependencies.verifyRunBeforeSnapshot ??
                    verifyProductionRunBeforeSnapshot
                )(paths, record.capsule);
            }
            if (phase === "target-smoke-verified") {
                const verifyOwnerTarget =
                    dependencies.verifyExecutorOwnerTarget ??
                    (dependencies.loadTargetArtifacts === undefined
                        ? async (
                              projectRoot: string,
                              releaseId: string,
                              runtimeRevision: string
                          ) => {
                              if (projectRoot !== options.projectRoot) throw failure();
                              await resolveDescriptorVerifiedExecutor(
                                  paths,
                                  releaseId,
                                  runtimeRevision
                              );
                          }
                        : undefined);
                if (verifyOwnerTarget) {
                    await verifyOwnerTarget(
                        options.projectRoot,
                        record.capsule.cas.target.releaseId,
                        record.capsule.cas.target.runtimeRevision
                    );
                }
                ownerState = await commitProductionDeliveryExecutorOwner(
                    lease,
                    paths,
                    ownerState,
                    {
                        formatVersion: 1,
                        releaseId: record.capsule.cas.target.releaseId,
                        runtimeRevision: record.capsule.cas.target.runtimeRevision,
                        transitionId: record.capsule.transitionId,
                    }
                );
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
        record = await advanceTo(lease, paths, record, "normal-runtime-starting", nowMs);
        return await completeAfterNormalRuntimeReady(
            lease,
            paths,
            record,
            activation,
            nowMs,
            services,
            dependencies
        );
    } catch (error) {
        if (error instanceof TargetExecutorHandoff) throw error;
        const terminal = await inspectDeliveryProductionOperation(lease, paths);
        if (terminal.state === "terminal") throw failure();
        const recovery = await loadActivation(lease, paths).catch(() => null);
        const recoveryOwner = activationMatchesTarget(recovery?.record, record)
            ? record.capsule.cas.target
            : record.capsule.cas.current;
        if (
            ownerState.owner?.releaseId !== recoveryOwner.releaseId ||
            ownerState.owner.runtimeRevision !== recoveryOwner.runtimeRevision
        ) {
            ownerState = await commitProductionDeliveryExecutorOwner(
                lease,
                paths,
                ownerState,
                {
                    formatVersion: 1,
                    releaseId: recoveryOwner.releaseId,
                    runtimeRevision: recoveryOwner.runtimeRevision,
                    transitionId: record.capsule.transitionId,
                }
            );
        }
        if (
            services !== undefined &&
            recovery?.record !== undefined &&
            (activationMatchesCurrent(recovery.record, record) ||
                activationMatchesTarget(recovery.record, record))
        ) {
            await restartNormalRuntime(paths, recovery.record, services, dependencies);
            if (activationMatchesTarget(recovery.record, record)) {
                return completeDeliveryProductionOperation(lease, paths, record, {
                    activation: recovery.record,
                    completedAtMs: Math.max(nowMs(), record.updatedAtMs),
                    outcome: "succeeded",
                });
            }
        }
        const receipt = await terminalFailure(
            lease,
            paths,
            record,
            nowMs,
            loadActivation
        );
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
    try {
        return await withDeploymentLease(paths.stateDirectory, (lease) =>
            runProductionDeliveryExecutorUnderLease(lease, paths, options, dependencies)
        );
    } catch (error) {
        if (!(error instanceof TargetExecutorHandoff)) throw error;
        const active = await inspectActiveProductionDeliveryOperation(
            options.projectRoot
        );
        if (active.state !== "in-progress") throw failure();
        const owner = await inspectProductionDeliveryExecutorOwner(options.projectRoot);
        if (owner === null || owner.transitionId !== options.transitionId) {
            throw failure();
        }
        const target = await resolveDescriptorVerifiedExecutor(
            paths,
            active.record.capsule.cas.target.releaseId,
            owner.runtimeRevision
        );
        const child = Bun.spawn(
            [
                target.runtimeExecutable,
                target.executor,
                `--artifact-source=${options.artifactSource}`,
                "--operation=cutover",
                `--project-root=${options.projectRoot}`,
                `--readiness-url=${options.readinessUrl}`,
                `--transition=${options.transitionId}`,
            ],
            {
                cwd: target.releaseRoot,
                env: { ...process.env },
                stderr: "inherit",
                stdout: "pipe",
            }
        );
        const exitCode = await child.exited;
        if (exitCode !== 0) throw failure();
        const inspection = await inspectProductionDeliveryOperation(
            options.projectRoot,
            options.transitionId
        );
        if (inspection.state !== "terminal") throw failure();
        return inspection.record;
    }
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
            const ownerState = await loadProductionDeliveryExecutorOwnerState(
                lease,
                paths
            );
            const expectedOwner = {
                formatVersion: 1 as const,
                releaseId: capsule.executor.releaseId,
                runtimeRevision: capsule.executor.runtimeRevision,
                transitionId: capsule.transitionId,
            };
            if (ownerState.owner === undefined) {
                await commitProductionDeliveryExecutorOwner(
                    lease,
                    paths,
                    ownerState,
                    expectedOwner
                );
            } else if (
                JSON.stringify(ownerState.owner) !== JSON.stringify(expectedOwner)
            ) {
                throw failure();
            }
            return existing.record;
        }
        if (existing.state !== "missing") throw failure();
        const ownerState = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        if (ownerState.owner !== undefined) throw failure();
        const record = await createDeliveryProductionOperation(
            lease,
            paths,
            capsule,
            Math.max(nowMs(), capsule.enqueue.queuedAtMs)
        );
        await commitProductionDeliveryExecutorOwner(lease, paths, ownerState, {
            formatVersion: 1,
            releaseId: capsule.executor.releaseId,
            runtimeRevision: capsule.executor.runtimeRevision,
            transitionId: capsule.transitionId,
        });
        return record;
    });
}

/**
 * Reads the stable recovery-owner transport record without parsing a foreign manifest.
 * @param projectRoot Canonical Dashboard project root.
 * @returns Current durable executor owner, or null when no transition owns one.
 */
export async function inspectProductionDeliveryExecutorOwner(projectRoot: string) {
    const canonicalRoot = v.parse(absoluteProjectRootSchema, projectRoot);
    const state = await prepareProtectedProductionStatePath(canonicalRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return withDeploymentLease(paths.stateDirectory, async (lease) => {
        const owner = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        return owner.owner ?? null;
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
        const owner = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        if (owner.owner !== undefined) {
            if (owner.owner.transitionId !== canonicalTransition) throw failure();
            await clearProductionDeliveryExecutorOwner(lease, paths, owner);
        }
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
        } else if (options.operation === "inspect-owner") {
            const owner = await inspectProductionDeliveryExecutorOwner(
                options.projectRoot
            );
            process.stdout.write(`${JSON.stringify(owner)}\n`);
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
