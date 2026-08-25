import {
    deliveryProductionOperationPhases,
    type DeliveryProductionOperationCapsule,
    type DeliveryProductionOperationInspection,
    type DeliveryProductionOperationRecord,
} from "../../shared/deliveryProductionOperation.ts";
import {
    ensureProductionDeliveryExecutor,
    productionDeliveryArtifactSource,
    type ProductionDeliveryLaunchOptions,
    type ProductionDeliveryExecutorEnsureResult,
} from "./productionDeliveryLauncher.ts";

const recoveryFailureMessage = "Delivery production recovery failed";

export class DeliveryProductionRecoveryError extends Error {
    override readonly name = "DeliveryProductionRecoveryError";
}

export interface DeliveryProductionCutoverResumeOptions {
    readonly ensure?: (
        options: ProductionDeliveryLaunchOptions,
        signal?: AbortSignal
    ) => Promise<ProductionDeliveryExecutorEnsureResult>;
    readonly projectRoot: string;
    readonly readActive: (
        signal?: AbortSignal
    ) => Promise<DeliveryProductionOperationRecord | null>;
    readonly readinessUrl: string;
}

function failure(): DeliveryProductionRecoveryError {
    return new DeliveryProductionRecoveryError(recoveryFailureMessage);
}

function sameCapsule(
    left: DeliveryProductionOperationCapsule,
    right: DeliveryProductionOperationCapsule
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Reconciles a nonterminal cutover fence without ever clearing it or enabling claims.
 * The deterministic unit is inspected and, only when absent, relaunched from the exact
 * immutable executor tuple persisted in the capsule. The durable record is then re-read.
 * @param options Exact control, project, readiness, and immutable executor boundary.
 * @param signal Optional caller cancellation.
 * @returns Current exact in-flight or terminal inspection.
 */
export async function reconcileDeliveryProductionCutoverBeforeValidation(
    options: DeliveryProductionCutoverResumeOptions,
    signal?: AbortSignal
): Promise<DeliveryProductionOperationInspection> {
    signal?.throwIfAborted();
    const beforeRecord = await options.readActive(signal);
    if (beforeRecord === null) return Object.freeze({ state: "missing" });
    const before: DeliveryProductionOperationInspection =
        beforeRecord.phase === "terminal"
            ? Object.freeze({
                  record: beforeRecord,
                  state: "terminal",
                  transitionId: beforeRecord.capsule.transitionId,
              })
            : Object.freeze({
                  record: beforeRecord,
                  state: "in-progress",
                  transitionId: beforeRecord.capsule.transitionId,
              });
    if (before.state === "terminal") return before;
    const { capsule } = before.record;
    await (options.ensure ?? ensureProductionDeliveryExecutor)(
        {
            artifactSource: productionDeliveryArtifactSource(
                capsule.enqueue.payload.operation
            ),
            executorReleaseId: capsule.executor.releaseId,
            projectRoot: options.projectRoot,
            readinessUrl: options.readinessUrl,
            runtimeRevision: capsule.executor.runtimeRevision,
            transitionId: capsule.transitionId,
        },
        signal
    );
    signal?.throwIfAborted();
    const afterRecord = await options.readActive(signal);
    if (afterRecord === null) throw failure();
    const after: DeliveryProductionOperationInspection =
        afterRecord.phase === "terminal"
            ? Object.freeze({
                  record: afterRecord,
                  state: "terminal",
                  transitionId: afterRecord.capsule.transitionId,
              })
            : Object.freeze({
                  record: afterRecord,
                  state: "in-progress",
                  transitionId: afterRecord.capsule.transitionId,
              });
    if (
        (after.state !== "in-progress" && after.state !== "terminal") ||
        after.transitionId !== capsule.transitionId ||
        !sameCapsule(after.record.capsule, capsule)
    ) {
        throw failure();
    }
    if (
        after.state === "in-progress" &&
        deliveryProductionOperationPhases.indexOf(after.record.phase) <
            deliveryProductionOperationPhases.indexOf(before.record.phase)
    ) {
        throw failure();
    }
    return after;
}
