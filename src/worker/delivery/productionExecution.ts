import * as v from "valibot";

import type { DeliveryOperationAuthoritySnapshot } from "../../contracts/delivery.ts";
import type {
    DeliveryDashboardMainGitSyncPort,
    DeliveryGitHubPullRequestMutationPort,
    DeliveryGitHubPullRequestReadPort,
} from "../../contracts/deliveryGithub.ts";
import {
    type DeliveryJobOperationResult,
    type DeliveryOperationWarningCode,
    type DeliveryProductionJobPayload,
    deliveryProductionActionKey,
} from "../../contracts/deliveryWorker.ts";
import type { JobExecutionRunIdentity } from "../../contracts/jobModel.ts";
import { canonicalDeliveryOperationWarnings } from "../../shared/deliveryOperationWarnings.ts";
import {
    deliveryProductionProtocol,
    parseDeliveryProductionOperationCapsule,
    serializeDeliveryProductionPayload,
    type DeliveryProductionOperationCapsule,
    type DeliveryProductionOperationInspection,
    type DeliveryProductionOperationRecord,
} from "../../shared/deliveryProductionOperation.ts";
import { publishedReleaseAuthoritiesMatch } from "../../shared/publishedReleaseAuthority.ts";
import { fullCommitShaSchema } from "../../shared/validation.ts";
import type { DeliveryProductionAuthorityReader } from "./productionAuthorityReader.ts";
import type { ProductionDeliveryControlPort } from "./productionDeliveryControl.ts";
import {
    ensureProductionDeliveryExecutor,
    launchProductionDeliveryExecutor,
    productionDeliveryArtifactSource,
    type ProductionDeliveryLaunchOptions,
} from "./productionDeliveryLauncher.ts";
import type { DeliveryProductionExecutionPort } from "./runtime.ts";

const executionFailureMessage = "Delivery production execution failed";
const receiptPollIntervalMs = 250;
const projectRootSchema = v.pipe(
    v.string(executionFailureMessage),
    v.maxLength(4096, executionFailureMessage),
    v.check(
        (value) =>
            value.startsWith("/") &&
            value !== "/" &&
            !value.includes("\0") &&
            !value.endsWith("/"),
        executionFailureMessage
    )
);
const readinessUrlSchema = v.pipe(
    v.string(executionFailureMessage),
    v.url(executionFailureMessage),
    v.check((value) => {
        const url = new URL(value);
        return (
            url.protocol === "http:" &&
            url.hostname === "127.0.0.1" &&
            url.pathname === "/api/health/ready" &&
            url.username === "" &&
            url.password === "" &&
            url.search === "" &&
            url.hash === ""
        );
    }, executionFailureMessage)
);

export class DeliveryProductionExecutionError extends Error {
    override readonly name = "DeliveryProductionExecutionError";
}

export interface DeliveryProductionExecutionOptions {
    readonly authority: DeliveryProductionAuthorityReader;
    readonly control: ProductionDeliveryControlPort;
    /** Exact immutable executor that is currently running this worker release. */
    readonly executorReleaseId: string;
    /** Exact Bun runtime paired with the currently running executor release. */
    readonly executorRuntimeRevision: string;
    readonly github: DeliveryGitHubPullRequestReadPort &
        DeliveryGitHubPullRequestMutationPort;
    readonly ensure?: (options: ProductionDeliveryLaunchOptions) => Promise<void>;
    readonly launch?: (options: ProductionDeliveryLaunchOptions) => Promise<void>;
    readonly mainGit: DeliveryDashboardMainGitSyncPort;
    readonly projectRoot: string;
    readonly readinessUrl: string;
    readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function failure(): DeliveryProductionExecutionError {
    return new DeliveryProductionExecutionError(executionFailureMessage);
}

function sha256(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const complete = () => {
            signal?.removeEventListener("abort", aborted);
            resolve();
        };
        const timeout = setTimeout(complete, milliseconds);
        const aborted = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", aborted);
            reject(
                signal?.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Aborted", "AbortError")
            );
        };
        signal?.addEventListener("abort", aborted, { once: true });
    });
    signal?.throwIfAborted();
}

function receiptBelongsToRun(
    record: DeliveryProductionOperationRecord,
    payload: DeliveryProductionJobPayload,
    identity: JobExecutionRunIdentity
): boolean {
    const enqueue = record.capsule.enqueue;
    return (
        record.capsule.protocol === deliveryProductionProtocol &&
        record.capsule.runId === identity.runId &&
        record.capsule.transitionId === identity.runId &&
        enqueue.actionKey === identity.actionKey &&
        enqueue.actor.id === identity.requestedById &&
        enqueue.actor.kind === identity.requestedByKind &&
        enqueue.actor.authenticatorId === identity.enqueueAuthenticatorId &&
        enqueue.audit.eventId === identity.enqueueAuditEventId &&
        enqueue.audit.requestId === identity.enqueueRequestId &&
        enqueue.enqueueSha256 === identity.enqueueSha256 &&
        enqueue.idempotencyKey === identity.idempotencyKey &&
        enqueue.payloadSha256 === identity.payloadSha256 &&
        enqueue.queuedAtMs === identity.queuedAtMs &&
        sameJson(enqueue.payload, payload)
    );
}

function terminalResult(
    inspection: Extract<DeliveryProductionOperationInspection, { state: "terminal" }>,
    payload: DeliveryProductionJobPayload,
    identity: JobExecutionRunIdentity
): DeliveryJobOperationResult {
    if (!receiptBelongsToRun(inspection.record, payload, identity)) throw failure();
    const result = inspection.record.result;
    const preCutoverWarnings = inspection.record.capsule.preCutoverWarnings ?? [];
    const partial = (
        warnings: readonly DeliveryOperationWarningCode[],
        releaseId?: string
    ): DeliveryJobOperationResult =>
        Object.freeze({
            operation: payload.operation,
            outcome: "completed-with-warnings",
            ...(releaseId === undefined ? {} : { releaseId }),
            warnings: canonicalDeliveryOperationWarnings(warnings),
        });
    if (result.outcome === "unknown-outcome") {
        return Object.freeze({
            operation: payload.operation,
            outcome: "unknown-outcome",
        });
    }
    if (result.outcome !== "succeeded") {
        throw failure();
    }
    if (
        result.activation.transitionId !== identity.runId ||
        result.activation.current.releaseId !==
            inspection.record.capsule.cas.target.releaseId ||
        result.activation.current.runtimeRevision !==
            inspection.record.capsule.cas.target.runtimeRevision
    ) {
        throw failure();
    }
    return preCutoverWarnings.length === 0
        ? Object.freeze({
              operation: payload.operation,
              outcome: "completed",
              releaseId: result.activation.current.releaseId,
          })
        : partial(preCutoverWarnings, result.activation.current.releaseId);
}

async function consumeTerminalResult(
    options: DeliveryProductionExecutionOptions,
    inspection: Extract<DeliveryProductionOperationInspection, { state: "terminal" }>,
    payload: DeliveryProductionJobPayload,
    identity: JobExecutionRunIdentity,
    signal?: AbortSignal
): Promise<DeliveryJobOperationResult> {
    if (!receiptBelongsToRun(inspection.record, payload, identity)) throw failure();
    const cleared = await options.control.clear(identity.runId, signal);
    if (!sameJson(cleared, inspection.record)) throw failure();
    return terminalResult(inspection, payload, identity);
}

function validateRunIdentity(
    payload: DeliveryProductionJobPayload,
    identity: JobExecutionRunIdentity
): void {
    if (
        identity.actionKey !== deliveryProductionActionKey ||
        (identity.requestedByKind !== "automation" &&
            identity.requestedByKind !== "user") ||
        identity.enqueueAuditEventId === null ||
        identity.enqueueAuthenticatorId === null ||
        identity.enqueueRequestId === null ||
        sha256(serializeDeliveryProductionPayload(payload)) !== identity.payloadSha256
    ) {
        throw failure();
    }
}

async function synchronizeMain(
    options: DeliveryProductionExecutionOptions,
    expectedMainHead: string,
    signal?: AbortSignal
): Promise<string> {
    const remote = v.parse(
        fullCommitShaSchema(executionFailureMessage),
        await options.github.readMainRef(signal)
    );
    if (remote !== expectedMainHead) throw failure();
    const local = await options.mainGit.inspect(signal);
    if (!local.safe) throw failure();
    if (local.headSha !== remote) {
        const synchronized = await options.mainGit.syncMainToExactRef(
            remote,
            local.headSha,
            signal
        );
        if (synchronized.outcome !== "completed" || synchronized.headSha !== remote) {
            throw failure();
        }
    }
    return remote;
}

async function awaitReceipt(
    options: DeliveryProductionExecutionOptions,
    payload: DeliveryProductionJobPayload,
    identity: JobExecutionRunIdentity,
    signal?: AbortSignal
): Promise<DeliveryJobOperationResult> {
    while (true) {
        signal?.throwIfAborted();
        const inspection = await options.control.inspect(identity.runId, signal);
        if (inspection.state === "terminal") {
            return consumeTerminalResult(options, inspection, payload, identity, signal);
        }
        if (
            inspection.state !== "in-progress" ||
            !receiptBelongsToRun(inspection.record, payload, identity)
        ) {
            throw failure();
        }
        await (options.wait ?? wait)(receiptPollIntervalMs, signal);
    }
}

/**
 * Creates the exact-once merge/deploy/paired-rollback production execution port.
 * @returns One immutable, receipt-backed production execution authority.
 */
export function createDeliveryProductionExecutionPort(
    untrustedOptions: DeliveryProductionExecutionOptions
): DeliveryProductionExecutionPort {
    const options = Object.freeze({
        ...untrustedOptions,
        executorReleaseId: v.parse(
            fullCommitShaSchema(executionFailureMessage),
            untrustedOptions.executorReleaseId
        ),
        executorRuntimeRevision: v.parse(
            fullCommitShaSchema(executionFailureMessage),
            untrustedOptions.executorRuntimeRevision
        ),
        projectRoot: v.parse(projectRootSchema, untrustedOptions.projectRoot),
        readinessUrl: v.parse(readinessUrlSchema, untrustedOptions.readinessUrl),
    });
    return Object.freeze({
        async execute(
            payload: DeliveryProductionJobPayload,
            current: DeliveryOperationAuthoritySnapshot,
            identity: JobExecutionRunIdentity,
            signal?: AbortSignal
        ): Promise<DeliveryJobOperationResult> {
            validateRunIdentity(payload, identity);
            const existing = await options.control.inspect(identity.runId, signal);
            if (existing.state === "terminal") {
                return consumeTerminalResult(
                    options,
                    existing,
                    payload,
                    identity,
                    signal
                );
            }
            if (existing.state === "conflict") throw failure();
            if (existing.state === "in-progress") {
                if (!receiptBelongsToRun(existing.record, payload, identity)) {
                    throw failure();
                }
                if (existing.record.phase === "intent-recorded") {
                    await (
                        options.ensure ??
                        (async (launchOptions) => {
                            await ensureProductionDeliveryExecutor(launchOptions);
                        })
                    )({
                        artifactSource: productionDeliveryArtifactSource(
                            existing.record.capsule.enqueue.payload.operation
                        ),
                        executorReleaseId: existing.record.capsule.executor.releaseId,
                        projectRoot: options.projectRoot,
                        readinessUrl: options.readinessUrl,
                        runtimeRevision: existing.record.capsule.executor.runtimeRevision,
                        transitionId: identity.runId,
                    });
                }
                return awaitReceipt(options, payload, identity, signal);
            }

            if (
                payload.operation === "deploy" &&
                (current.releases.candidate === undefined ||
                    current.releases.current === undefined ||
                    !publishedReleaseAuthoritiesMatch(
                        current.releases.candidate,
                        payload.release
                    ))
            ) {
                throw failure();
            }

            const preCutoverWarnings: DeliveryOperationWarningCode[] = [];
            const targetReleaseId =
                payload.operation === "deploy"
                    ? await synchronizeMain(options, payload.expectedMainHeadSha, signal)
                    : payload.target.releaseId;

            const authority = await options.authority.readExact(signal);
            const activation = authority.activation;
            const currentRelease = authority.snapshot.releases.current;
            if (
                activation === undefined ||
                currentRelease === undefined ||
                authority.snapshot.releases.activationRevision !==
                    current.releases.activationRevision ||
                authority.snapshot.releases.activationRevision !==
                    payload.activationRevision ||
                activation.current.releaseId !== currentRelease.releaseId ||
                activation.current.runtimeRevision !== currentRelease.runtimeRevision ||
                targetReleaseId === activation.current.releaseId
            ) {
                throw failure();
            }
            if (
                payload.operation === "rollback-release" &&
                (activation.previous === null ||
                    !sameJson(activation.previous, payload.target) ||
                    !authority.snapshot.releases.rollback.available ||
                    !sameJson(
                        authority.snapshot.releases.rollback.target,
                        payload.target
                    ))
            ) {
                throw failure();
            }

            let target: Readonly<{
                databaseSnapshotTransitionId: string | null;
                releaseId: string;
                runtimeRevision: string;
            }>;
            if (payload.operation === "rollback-release") {
                target = {
                    databaseSnapshotTransitionId:
                        payload.target.databaseSnapshotTransitionId,
                    releaseId: payload.target.releaseId,
                    runtimeRevision: payload.target.runtimeRevision,
                };
            } else if (payload.operation === "deploy") {
                target = {
                    databaseSnapshotTransitionId: null,
                    releaseId: targetReleaseId,
                    runtimeRevision: payload.release.runtime.revision,
                };
            } else {
                throw failure();
            }
            const capsule: DeliveryProductionOperationCapsule =
                parseDeliveryProductionOperationCapsule({
                    cas: {
                        current: {
                            activationTransitionId: activation.transitionId,
                            releaseId: activation.current.releaseId,
                            rollbackSnapshotTransitionId: identity.runId,
                            runtimeRevision: activation.current.runtimeRevision,
                        },
                        target,
                    },
                    enqueue: {
                        actionKey: deliveryProductionActionKey,
                        actor: {
                            authenticatorId: identity.enqueueAuthenticatorId!,
                            id: identity.requestedById,
                            kind: identity.requestedByKind,
                        },
                        audit: {
                            eventId: identity.enqueueAuditEventId!,
                            requestId: identity.enqueueRequestId!,
                        },
                        enqueueSha256: identity.enqueueSha256,
                        idempotencyKey: identity.idempotencyKey,
                        payload,
                        payloadSha256: identity.payloadSha256,
                        queuedAtMs: identity.queuedAtMs,
                    },
                    executor: {
                        releaseId: options.executorReleaseId,
                        runtimeRevision: options.executorRuntimeRevision,
                    },
                    protocol: deliveryProductionProtocol,
                    ...(preCutoverWarnings.length === 0
                        ? {}
                        : {
                              preCutoverWarnings:
                                  canonicalDeliveryOperationWarnings(preCutoverWarnings),
                          }),
                    runId: identity.runId,
                    transitionId: identity.runId,
                });
            await options.control.prepare(capsule, signal);
            await (options.launch ?? launchProductionDeliveryExecutor)({
                artifactSource: productionDeliveryArtifactSource(payload.operation),
                executorReleaseId: options.executorReleaseId,
                projectRoot: options.projectRoot,
                readinessUrl: options.readinessUrl,
                runtimeRevision: options.executorRuntimeRevision,
                transitionId: identity.runId,
            });
            const settled = await awaitReceipt(options, payload, identity, signal);
            return settled;
        },
    });
}
