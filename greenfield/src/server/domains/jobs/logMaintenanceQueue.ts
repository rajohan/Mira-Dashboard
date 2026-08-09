import * as v from "valibot";

import {
    logMaintenancePolicyIds,
    requestLogMaintenanceInputSchema,
    type LogMaintenancePolicyId,
    type RequestLogMaintenanceInput,
} from "../../../contracts/logs.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { findJobActionDefinition, logMaintenanceJobActionKey } from "./actionRegistry.ts";
import { preflightManualEnqueue } from "./manualEnqueue.ts";
import type { JobRepository } from "./repository.ts";
import { createJobMutationSideEffects } from "./sideEffects.ts";

const queueActor = Object.freeze({
    authenticatorId: null,
    id: "system.logs-service",
    kind: "system" as const,
});

export interface LogMaintenanceJobQueueDependencies {
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly repository: Pick<JobRepository, "enqueueManualRun" | "findRunByIdempotency">;
    readonly wakeEventPump?: () => Promise<void> | void;
}

/** Web-safe durable queue surface. It accepts policy identities, never paths. */
export interface LogMaintenanceJobQueue {
    readonly queueablePolicies: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenancePolicyId[]>;
    readonly enqueue: (
        input: RequestLogMaintenanceInput,
        signal?: AbortSignal
    ) => Promise<{ readonly jobRunId: string }>;
}

/** Sanitized queue failure without database, policy-path, or worker diagnostics. */
export class LogMaintenanceJobQueueError extends Error {
    override readonly name = "LogMaintenanceJobQueueError";
}

function queueFailure(): LogMaintenanceJobQueueError {
    return new LogMaintenanceJobQueueError("Log maintenance queue is unavailable");
}

function requireActive(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw queueFailure();
}

function enqueueDigest(policyId: LogMaintenancePolicyId): string {
    return sha256Hex(
        JSON.stringify({
            actionKey: logMaintenanceJobActionKey,
            payload: { policyId },
            version: 1,
        })
    );
}

/**
 * Creates a durable log-maintenance enqueue adapter bound to one fixed system actor.
 * The recent-MFA route records the initiating user separately before calling this port;
 * the run insertion, jobs audit row, and realtime invalidation commit atomically.
 * @returns A fixed-policy queue port safe to inject into the Logs domain service.
 */
export function createLogMaintenanceJobQueue(
    dependencies: LogMaintenanceJobQueueDependencies
): LogMaintenanceJobQueue {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;

    return Object.freeze({
        queueablePolicies(signal?: AbortSignal) {
            return Promise.resolve().then(() => {
                requireActive(signal);
                return logMaintenancePolicyIds;
            });
        },
        async enqueue(input: RequestLogMaintenanceInput, signal?: AbortSignal) {
            try {
                requireActive(signal);
                const parsed = v.parse(requestLogMaintenanceInputSchema, input);
                const definition = findJobActionDefinition(logMaintenanceJobActionKey);
                if (definition === undefined) throw queueFailure();
                const enqueueSha256 = enqueueDigest(parsed.policyId);
                const replay = preflightManualEnqueue(dependencies.repository, {
                    enqueueSha256,
                    idempotencyKey: parsed.idempotencyKey,
                    requestedById: queueActor.id,
                    requestedByKind: queueActor.kind,
                });
                if (replay.kind === "idempotency-mismatch") throw queueFailure();
                if (replay.kind === "replayed") {
                    return Object.freeze({ jobRunId: replay.run.id });
                }

                requireActive(signal);
                const at = new Date(nowMs());
                const runId = generateId();
                const sideEffects = createJobMutationSideEffects({
                    action: "logs.maintenance.enqueue",
                    actor: queueActor,
                    auditId: generateId(),
                    metadata: { policyId: parsed.policyId },
                    occurredAt: at,
                    outcome: "accepted",
                    realtime: { id: runId, kind: "run", operation: "created" },
                    targetId: runId,
                    targetType: "job-run",
                });
                const result = await dependencies.repository.enqueueManualRun({
                    ...sideEffects,
                    queuedEvent: {
                        attempt: 0,
                        jobRunId: runId,
                        kind: "queued",
                        message: null,
                        occurredAt: at,
                        progressJson: null,
                        sequence: 1,
                        workerInstanceId: null,
                    },
                    run: {
                        actionKey: definition.actionKey,
                        attemptLimit: definition.attemptLimit,
                        availableAt: at,
                        cancellationPolicy: definition.cancellationPolicy,
                        cancelRequestedAt: null,
                        cancelRequestedById: null,
                        cancelRequestedByKind: null,
                        displayName: definition.displayName,
                        enqueueSha256,
                        finishedAt: null,
                        firstStartedAt: null,
                        heartbeatAt: null,
                        id: runId,
                        idempotencyKey: parsed.idempotencyKey,
                        lastAttemptStartedAt: null,
                        leaseExpiresAt: null,
                        leaseOwnerId: null,
                        leaseToken: null,
                        payloadJson: JSON.stringify({ policyId: parsed.policyId }),
                        priority: definition.priority,
                        queuedAt: at,
                        requestedById: queueActor.id,
                        requestedByKind: queueActor.kind,
                        resourceClass: definition.resourceClass,
                        resourceKeysJson: JSON.stringify(definition.resourceKeys),
                        resultJson: null,
                        retrySafe: definition.retrySafe,
                        scheduledForAt: null,
                        scheduledJobId: null,
                        scheduledJobVersion: null,
                        state: "queued",
                        terminalCode: null,
                        terminalMessage: null,
                        timeoutMs: definition.timeoutMs,
                        triggerType: "system",
                        updatedAt: at,
                    },
                });
                if (result.kind === "idempotency-mismatch") throw queueFailure();
                if (result.kind === "action-unavailable" || result.kind === "active") {
                    throw queueFailure();
                }
                if (result.kind === "inserted") {
                    try {
                        await dependencies.wakeEventPump?.();
                    } catch {
                        // Durable queue state remains authoritative for the next pump pass.
                    }
                }
                return Object.freeze({ jobRunId: result.run.id });
            } catch (error) {
                if (error instanceof LogMaintenanceJobQueueError) throw error;
                throw queueFailure();
            }
        },
    });
}
