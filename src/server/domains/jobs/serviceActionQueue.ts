import * as v from "valibot";

import {
    type RequestServiceActionResult,
    type ServiceActionId,
    serviceActionIds,
} from "../../../contracts/serviceActions.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    hostDashboardRestartJobActionKey,
    hostSystemCleanupJobActionKey,
    hostSystemRestartJobActionKey,
    hostSystemUpdateJobActionKey,
    hostWorkerRestartJobActionKey,
    openClawGatewayRestartJobActionKey,
    openClawInstallationUpdateJobActionKey,
    openClawSessionsCleanupJobActionKey,
    type JobUnscheduledActionDefinition,
    validateJobUnscheduledActionDefinition,
} from "./actionRegistry.ts";
import { preflightManualEnqueue } from "./manualEnqueue.ts";
import type { JobRunRecord } from "./records.ts";
import type { JobRepository } from "./repository.ts";
import { createJobMutationSideEffects } from "./sideEffects.ts";

const emptyPayload = Object.freeze({});
const emptyPayloadJson = JSON.stringify(emptyPayload);
const emptyPayloadSchema = v.strictObject({});

/** Exact worker action selected by each browser-visible Service Action. */
export const serviceActionJobActionKeys = Object.freeze({
    "dashboard-restart": hostDashboardRestartJobActionKey,
    "openclaw-cleanup": openClawSessionsCleanupJobActionKey,
    "openclaw-restart": openClawGatewayRestartJobActionKey,
    "openclaw-update": openClawInstallationUpdateJobActionKey,
    "system-cleanup": hostSystemCleanupJobActionKey,
    "system-restart": hostSystemRestartJobActionKey,
    "system-update": hostSystemUpdateJobActionKey,
    "worker-restart": hostWorkerRestartJobActionKey,
} as const satisfies Readonly<Record<ServiceActionId, string>>);

export type ServiceActionQueueErrorReason =
    | "conflict"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized durable enqueue failure; job diagnostics remain inside Jobs. */
export class ServiceActionQueueError extends Error {
    public readonly reason: ServiceActionQueueErrorReason;

    public constructor(reason: ServiceActionQueueErrorReason) {
        super("Service Action queue failed");
        this.name = "ServiceActionQueueError";
        this.reason = reason;
    }
}

export interface ServiceActionQueueActor {
    readonly authenticatorId: string;
    readonly id: string;
    readonly kind: "user";
}

export interface ServiceActionQueueRequest {
    readonly actionId: ServiceActionId;
    readonly actor: ServiceActionQueueActor;
    /** Preflights asynchronous availability and returns the final synchronous auth fence. */
    readonly authorizeDispatch: () => Promise<() => void>;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
}

export interface ServiceActionQueue {
    readonly enqueue: (
        request: ServiceActionQueueRequest
    ) => Promise<RequestServiceActionResult>;
}

export interface ServiceActionQueueDependencies {
    readonly definitions: Readonly<
        Record<ServiceActionId, JobUnscheduledActionDefinition>
    >;
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly requiredWorkerReleaseId?: string;
    readonly repository: Pick<JobRepository, "enqueueManualRun" | "findRunByIdempotency">;
    readonly wakeEventPump?: () => Promise<void> | void;
}

interface PreparedServiceAction {
    readonly definition: JobUnscheduledActionDefinition;
    readonly enqueueSha256: string;
}

function enqueueDigest(actionKey: string, authenticatorId: string): string {
    return sha256Hex(
        JSON.stringify({
            actionKey,
            authenticatorId,
            payload: emptyPayload,
            version: 1,
        })
    );
}

function prepareDefinitions(
    definitions: ServiceActionQueueDependencies["definitions"]
): Readonly<Record<ServiceActionId, JobUnscheduledActionDefinition>> {
    return Object.freeze(
        Object.fromEntries(
            serviceActionIds.map((actionId) => {
                const definition = validateJobUnscheduledActionDefinition(
                    definitions[actionId]
                );
                if (
                    definition.actionKey !== serviceActionJobActionKeys[actionId] ||
                    definition.manualExposure !== "none" ||
                    definition.attemptLimit !== 1 ||
                    definition.cancellationPolicy !== "never" ||
                    definition.retrySafe
                ) {
                    throw new TypeError("Service Action definition is invalid");
                }
                return [actionId, definition];
            })
        ) as Record<ServiceActionId, JobUnscheduledActionDefinition>
    );
}

function matchingRun(
    run: JobRunRecord | undefined,
    request: ServiceActionQueueRequest,
    prepared: PreparedServiceAction
): JobRunRecord | undefined {
    if (
        run === undefined ||
        run.actionKey !== prepared.definition.actionKey ||
        run.enqueueSha256 !== prepared.enqueueSha256 ||
        run.idempotencyKey !== request.idempotencyKey ||
        run.requestedById !== request.actor.id ||
        run.requestedByKind !== request.actor.kind
    ) {
        return undefined;
    }
    try {
        const payload = v.safeParse(emptyPayloadSchema, parseJsonText(run.payloadJson));
        return payload.success ? run : undefined;
    } catch {
        return undefined;
    }
}

function result(
    actionId: ServiceActionId,
    run: JobRunRecord
): RequestServiceActionResult {
    return Object.freeze({ actionId, jobRunId: run.id, queued: true });
}

/**
 * Creates the actor- and authenticator-bound durable queue for six exact Service Actions.
 * The queue returns after durable admission and never waits for worker settlement.
 * @returns The purpose-built fixed-action enqueue boundary.
 */
export function createServiceActionQueue(
    dependencies: ServiceActionQueueDependencies
): ServiceActionQueue {
    const definitions = prepareDefinitions(dependencies.definitions);
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;
    const requiredWorkerReleaseId =
        dependencies.requiredWorkerReleaseId === undefined
            ? undefined
            : v.parse(
                  fullCommitShaSchema(
                      "Required Service Action worker release is invalid"
                  ),
                  dependencies.requiredWorkerReleaseId
              );

    async function wakeQueuedRun(run: JobRunRecord): Promise<void> {
        if (run.state !== "queued") return;
        try {
            await dependencies.wakeEventPump?.();
        } catch {
            // The durable run remains authoritative for worker polling.
        }
    }

    return Object.freeze({
        async enqueue(
            request: ServiceActionQueueRequest
        ): Promise<RequestServiceActionResult> {
            request.signal?.throwIfAborted();
            const definition = definitions[request.actionId];
            const prepared = Object.freeze({
                definition,
                enqueueSha256: enqueueDigest(
                    definition.actionKey,
                    request.actor.authenticatorId
                ),
            });
            let replay: ReturnType<typeof preflightManualEnqueue>;
            try {
                replay = preflightManualEnqueue(dependencies.repository, {
                    enqueueSha256: prepared.enqueueSha256,
                    idempotencyKey: request.idempotencyKey,
                    requestedById: request.actor.id,
                    requestedByKind: request.actor.kind,
                });
            } catch {
                throw new ServiceActionQueueError("unavailable");
            }
            if (replay.kind === "idempotency-mismatch") {
                throw new ServiceActionQueueError("conflict");
            }
            if (replay.kind === "replayed") {
                const run = matchingRun(replay.run, request, prepared);
                if (run === undefined) throw new ServiceActionQueueError("conflict");
                return result(request.actionId, run);
            }
            if (requiredWorkerReleaseId === undefined) {
                throw new ServiceActionQueueError("unavailable");
            }

            const atMs = nowMs();
            if (!Number.isSafeInteger(atMs) || atMs < 0) {
                throw new ServiceActionQueueError("unavailable");
            }
            const at = new Date(atMs);
            const runId = generateId();
            const sideEffects = createJobMutationSideEffects({
                action: "service-actions.request.enqueue",
                actor: request.actor,
                auditId: generateId(),
                metadata: { actionId: request.actionId },
                occurredAt: at,
                outcome: "accepted",
                realtime: { id: runId, kind: "run", operation: "created" },
                requestId: request.requestId,
                targetId: runId,
                targetType: "job-run",
            });
            const enqueueInput = Object.freeze({
                ...sideEffects,
                queuedEvent: {
                    attempt: 0,
                    jobRunId: runId,
                    kind: "queued" as const,
                    message: null,
                    occurredAt: at,
                    progressJson: null,
                    sequence: 1,
                    workerInstanceId: null,
                },
                rejectWhenActionActive: true,
                run: {
                    actionKey: definition.actionKey,
                    attemptLimit: definition.attemptLimit,
                    availableAt: at,
                    cancellationPolicy: definition.cancellationPolicy,
                    cancelRequestedAt: null,
                    cancelRequestedById: null,
                    cancelRequestedByKind: null,
                    displayName: definition.displayName,
                    enqueueSha256: prepared.enqueueSha256,
                    finishedAt: null,
                    firstStartedAt: null,
                    heartbeatAt: null,
                    id: runId,
                    idempotencyKey: request.idempotencyKey,
                    lastAttemptStartedAt: null,
                    leaseExpiresAt: null,
                    leaseOwnerId: null,
                    leaseToken: null,
                    payloadJson: emptyPayloadJson,
                    priority: definition.priority,
                    queuedAt: at,
                    requestedById: request.actor.id,
                    requestedByKind: request.actor.kind,
                    requiredWorkerReleaseId,
                    resourceClass: definition.resourceClass,
                    resourceKeysJson: JSON.stringify(definition.resourceKeys),
                    resultJson: null,
                    retrySafe: definition.retrySafe,
                    scheduledForAt: null,
                    scheduledJobId: null,
                    scheduledJobVersion: null,
                    state: "queued" as const,
                    terminalCode: null,
                    terminalMessage: null,
                    timeoutMs: definition.timeoutMs,
                    triggerType: "manual" as const,
                    updatedAt: at,
                },
            });

            request.signal?.throwIfAborted();
            const authorizeEnqueue = await request.authorizeDispatch();
            request.signal?.throwIfAborted();

            let enqueued: Awaited<ReturnType<JobRepository["enqueueManualRun"]>>;
            let authorizationFailed = false;
            let authorizationFailure: unknown;
            try {
                enqueued = await dependencies.repository.enqueueManualRun(
                    enqueueInput,
                    () => {
                        request.signal?.throwIfAborted();
                        try {
                            authorizeEnqueue();
                            request.signal?.throwIfAborted();
                        } catch (error) {
                            authorizationFailed = true;
                            authorizationFailure = error;
                            throw error;
                        }
                    }
                );
            } catch {
                if (authorizationFailed) throw authorizationFailure;
                let recovered: JobRunRecord | undefined;
                try {
                    recovered = dependencies.repository.findRunByIdempotency(
                        request.actor.kind,
                        request.actor.id,
                        request.idempotencyKey
                    );
                } catch {
                    throw new ServiceActionQueueError("unknown-outcome");
                }
                if (recovered === undefined) {
                    throw new ServiceActionQueueError("unknown-outcome");
                }
                const run = matchingRun(recovered, request, prepared);
                if (run === undefined) throw new ServiceActionQueueError("conflict");
                await wakeQueuedRun(run);
                return result(request.actionId, run);
            }

            if (enqueued.kind === "idempotency-mismatch" || enqueued.kind === "active") {
                throw new ServiceActionQueueError("conflict");
            }
            if (enqueued.kind === "action-unavailable") {
                throw new ServiceActionQueueError("unavailable");
            }
            const run = matchingRun(enqueued.run, request, prepared);
            if (run === undefined) throw new ServiceActionQueueError("unknown-outcome");
            if (enqueued.kind === "inserted") await wakeQueuedRun(run);
            return result(request.actionId, run);
        },
    });
}
