import * as v from "valibot";

import {
    logMaintenanceActiveRunSchema,
    logMaintenanceJobResultSchema,
    logMaintenanceLastRunSchema,
    logMaintenancePolicyIds,
    requestLogMaintenanceInputSchema,
    type LogMaintenanceLastRun,
    type LogMaintenancePolicyId,
    type LogMaintenanceRunStatus,
    type RequestLogMaintenanceInput,
} from "../../../contracts/logs.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { findJobActionDefinition, logMaintenanceJobActionKey } from "./actionRegistry.ts";
import { preflightManualEnqueue } from "./manualEnqueue.ts";
import { toJobRunResult, toJobRunSummary } from "./records.ts";
import type { ActionPayloadRunSnapshot, JobRepository } from "./repository.ts";
import { createJobMutationSideEffects } from "./sideEffects.ts";

const queueActor = Object.freeze({
    authenticatorId: null,
    id: "system.logs-service",
    kind: "system" as const,
});

export interface LogMaintenanceJobQueueDependencies {
    /** Worker/provisioning availability projected through an explicit trusted boundary. */
    readonly availablePolicies?: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenancePolicyId[]>;
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly repository: Pick<
        JobRepository,
        "enqueueManualRun" | "findRunByIdempotency" | "readActionPayloadRunSnapshots"
    >;
    readonly wakeEventPump?: () => Promise<void> | void;
}

/** Web-safe durable queue surface. It accepts policy identities, never paths. */
export interface LogMaintenanceJobQueue {
    readonly runStatuses: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenanceRunStatus[]>;
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

function actionPayload(input: Pick<RequestLogMaintenanceInput, "dryRun" | "policyId">) {
    return input.dryRun
        ? Object.freeze({ dryRun: true as const, policyId: input.policyId })
        : Object.freeze({ policyId: input.policyId });
}

const realPolicyPayloads = Object.freeze(
    logMaintenancePolicyIds.map((policyId) =>
        Object.freeze({
            payloadJson: JSON.stringify(actionPayload({ dryRun: false, policyId })),
            policyId,
        })
    )
);
const managedDryRunPayloadJson = JSON.stringify(
    actionPayload({ dryRun: true, policyId: "docker-managed" })
);

function enqueueDigest(input: RequestLogMaintenanceInput): string {
    return sha256Hex(
        JSON.stringify({
            actionKey: logMaintenanceJobActionKey,
            payload: actionPayload(input),
            version: 1,
        })
    );
}

function lastRun(
    record: NonNullable<ActionPayloadRunSnapshot["lastRun"]>,
    policyId: LogMaintenancePolicyId
): LogMaintenanceLastRun {
    const rawResult = toJobRunResult(record);
    const parsedResult =
        rawResult === undefined
            ? undefined
            : v.safeParse(logMaintenanceJobResultSchema, rawResult);
    const summary =
        parsedResult?.success === true &&
        parsedResult.output.policyId === policyId &&
        !parsedResult.output.dryRun &&
        parsedResult.output.summary?.dryRun === false
            ? parsedResult.output.summary
            : undefined;
    return v.parse(logMaintenanceLastRunSchema, {
        run: toJobRunSummary(record),
        ...(summary === undefined ? {} : { summary }),
    });
}

function runStatus(
    snapshot: ActionPayloadRunSnapshot,
    policyId: LogMaintenancePolicyId,
    activeRecord = snapshot.activeRun
): LogMaintenanceRunStatus {
    return Object.freeze({
        ...(activeRecord === undefined
            ? {}
            : {
                  activeRun: v.parse(
                      logMaintenanceActiveRunSchema,
                      toJobRunSummary(activeRecord)
                  ),
              }),
        ...(snapshot.lastRun === undefined
            ? {}
            : { lastRun: lastRun(snapshot.lastRun, policyId) }),
        policyId,
    });
}

function preferredActiveRun(
    ...records: readonly (ActionPayloadRunSnapshot["activeRun"] | undefined)[]
): ActionPayloadRunSnapshot["activeRun"] | undefined {
    return records
        .filter((record) => record !== undefined)
        .toSorted(
            (left, right) =>
                Number(right.state === "running") - Number(left.state === "running") ||
                right.queuedAt.getTime() - left.queuedAt.getTime() ||
                right.id.localeCompare(left.id)
        )[0];
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

    async function queueablePolicies(
        signal?: AbortSignal
    ): Promise<readonly LogMaintenancePolicyId[]> {
        try {
            requireActive(signal);
            const projected = await (dependencies.availablePolicies?.(signal) ?? []);
            requireActive(signal);
            const available = new Set<LogMaintenancePolicyId>(projected);
            return Object.freeze(
                logMaintenancePolicyIds.filter((policyId) => available.has(policyId))
            );
        } catch (error) {
            if (error instanceof LogMaintenanceJobQueueError) throw error;
            throw queueFailure();
        }
    }

    return Object.freeze({
        runStatuses(signal?: AbortSignal) {
            try {
                requireActive(signal);
                const snapshots = dependencies.repository.readActionPayloadRunSnapshots({
                    actionKey: logMaintenanceJobActionKey,
                    payloadJsons: [
                        ...realPolicyPayloads.map(({ payloadJson }) => payloadJson),
                        managedDryRunPayloadJson,
                    ],
                });
                const snapshotsByPayload = new Map(
                    snapshots.map((snapshot) => [snapshot.payloadJson, snapshot])
                );
                if (
                    snapshots.length !== realPolicyPayloads.length + 1 ||
                    snapshotsByPayload.size !== realPolicyPayloads.length + 1
                ) {
                    throw queueFailure();
                }
                const managedDryRunSnapshot = snapshotsByPayload.get(
                    managedDryRunPayloadJson
                );
                if (managedDryRunSnapshot === undefined) throw queueFailure();
                const statuses = realPolicyPayloads.map(({ payloadJson, policyId }) => {
                    const snapshot = snapshotsByPayload.get(payloadJson);
                    if (snapshot === undefined) throw queueFailure();
                    // A managed dry run shares the active single-flight slot, while
                    // terminal status intentionally reports only real maintenance.
                    return runStatus(
                        snapshot,
                        policyId,
                        policyId === "docker-managed"
                            ? preferredActiveRun(
                                  snapshot.activeRun,
                                  managedDryRunSnapshot.activeRun
                              )
                            : snapshot.activeRun
                    );
                });
                requireActive(signal);
                return Promise.resolve(Object.freeze(statuses));
            } catch (error) {
                return Promise.reject(
                    error instanceof LogMaintenanceJobQueueError ? error : queueFailure()
                );
            }
        },
        queueablePolicies,
        async enqueue(input: RequestLogMaintenanceInput, signal?: AbortSignal) {
            try {
                requireActive(signal);
                const parsed = v.parse(requestLogMaintenanceInputSchema, input);
                const definition = findJobActionDefinition(logMaintenanceJobActionKey);
                if (definition === undefined) throw queueFailure();
                const payload = actionPayload(parsed);
                const enqueueSha256 = enqueueDigest(parsed);
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
                const availablePolicies = await queueablePolicies(signal);
                if (!availablePolicies.includes(parsed.policyId)) {
                    throw queueFailure();
                }

                requireActive(signal);
                const at = new Date(nowMs());
                const runId = generateId();
                const sideEffects = createJobMutationSideEffects({
                    action: "logs.maintenance.enqueue",
                    actor: queueActor,
                    auditId: generateId(),
                    metadata: {
                        ...(parsed.dryRun ? { dryRun: true } : {}),
                        policyId: parsed.policyId,
                    },
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
                    rejectWhenActionActive: true,
                    run: {
                        actionKey: definition.actionKey,
                        attemptLimit: definition.attemptLimit,
                        availableAt: at,
                        cancellationPolicy: definition.cancellationPolicy,
                        cancelRequestedAt: null,
                        cancelRequestedById: null,
                        cancelRequestedByKind: null,
                        displayName: parsed.dryRun
                            ? "Managed log maintenance dry-run"
                            : definition.displayName,
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
                        payloadJson: JSON.stringify(payload),
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
