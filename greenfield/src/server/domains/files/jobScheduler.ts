import { getTime } from "date-fns";

import type {
    WorkspaceFileUploadAccepted,
    WorkspaceFileWriteStatus,
} from "../../../contracts/files.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    workspaceFileReplaceJobActionDefinition,
    workspaceFileReplaceJobActionKey,
    workspaceFileWriteJobActionDefinition,
    workspaceFileWriteJobActionKey,
} from "../jobs/actionRegistry.ts";
import { preflightManualEnqueue } from "../jobs/manualEnqueue.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type { JobRepository } from "../jobs/repository.ts";
import { createJobMutationSideEffects } from "../jobs/sideEffects.ts";
import { WorkspaceFileError, workspaceFileError } from "./errors.ts";
import {
    parseWorkspaceFileJobPayload,
    type WorkspaceFileJobPayload,
} from "./jobPayload.ts";
import type {
    WorkspaceFileWriteAuditContext,
    WorkspaceFileWriteCommand,
    WorkspaceFileWriteScheduler,
} from "./ports.ts";

export interface WorkspaceFileJobSchedulerDependencies {
    readonly generateId?: () => string;
    readonly nowMs?: () => number;
    readonly repository: Pick<
        JobRepository,
        "enqueueManualRun" | "findRunByIdempotency" | "listActiveActionPayloads"
    >;
    readonly wakeEventPump?: () => Promise<void> | void;
}

function actorBinding(actor: WorkspaceFileWriteAuditContext["actor"]): string {
    return sha256Hex(
        JSON.stringify({
            authenticatorId: actor.authenticatorId,
            id: actor.id,
            version: 1,
        })
    );
}

function payloadFor(
    command: WorkspaceFileWriteCommand,
    audit: WorkspaceFileWriteAuditContext
): WorkspaceFileJobPayload {
    return parseWorkspaceFileJobPayload({
        actorBindingSha256: actorBinding(audit.actor),
        command,
    });
}

function actionDefinitionFor(command: WorkspaceFileWriteCommand) {
    return command.operation === "replace"
        ? workspaceFileReplaceJobActionDefinition
        : workspaceFileWriteJobActionDefinition;
}

function enqueueDigest(actionKey: string, payload: WorkspaceFileJobPayload): string {
    return sha256Hex(
        JSON.stringify({
            actionKey,
            payload,
            version: 1,
        })
    );
}

function matchingRun(
    run: JobRunRecord | undefined,
    ticketId: string,
    expectedActorBinding: string
): JobRunRecord | undefined {
    if (run === undefined) return undefined;
    try {
        const payload = parseWorkspaceFileJobPayload(parseJsonText(run.payloadJson));
        return run.actionKey === actionDefinitionFor(payload.command).actionKey &&
            payload.command.ticketId === ticketId &&
            payload.actorBindingSha256 === expectedActorBinding
            ? run
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Creates the actor/session-bound web-to-worker queue for structural file writes.
 * Audit, run, queued event, and realtime invalidation commit in one repository write.
 * @param dependencies Durable repository, clock, id, and wake boundaries.
 * @returns Web-safe scheduler with no direct filesystem mutation authority.
 */
export function createWorkspaceFileJobScheduler(
    dependencies: WorkspaceFileJobSchedulerDependencies
): WorkspaceFileWriteScheduler {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const nowMs = dependencies.nowMs ?? Date.now;

    return Object.freeze({
        async enqueue(
            command: WorkspaceFileWriteCommand,
            audit: WorkspaceFileWriteAuditContext,
            signal?: AbortSignal
        ): Promise<WorkspaceFileUploadAccepted> {
            try {
                signal?.throwIfAborted();
                const payload = payloadFor(command, audit);
                const definition = actionDefinitionFor(command);
                const enqueueSha256 = enqueueDigest(definition.actionKey, payload);
                const replay = preflightManualEnqueue(dependencies.repository, {
                    enqueueSha256,
                    idempotencyKey: command.ticketId,
                    requestedById: audit.actor.id,
                    requestedByKind: audit.actor.kind,
                });
                if (replay.kind === "idempotency-mismatch") {
                    throw new WorkspaceFileError("conflict");
                }
                if (replay.kind === "replayed") {
                    const matched = matchingRun(
                        replay.run,
                        command.ticketId,
                        payload.actorBindingSha256
                    );
                    if (matched === undefined) throw new WorkspaceFileError("conflict");
                    return {
                        acceptedAtMs: getTime(matched.queuedAt),
                        jobRunId: matched.id,
                        ticketId: command.ticketId,
                    };
                }

                signal?.throwIfAborted();
                const at = new Date(nowMs());
                const runId = generateId();
                const sideEffects = createJobMutationSideEffects({
                    action: "files.write.enqueue",
                    actor: audit.actor,
                    auditId: generateId(),
                    metadata: { operation: command.operation },
                    occurredAt: at,
                    outcome: "accepted",
                    realtime: { id: runId, kind: "run", operation: "created" },
                    requestId: audit.requestId,
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
                        idempotencyKey: command.ticketId,
                        lastAttemptStartedAt: null,
                        leaseExpiresAt: null,
                        leaseOwnerId: null,
                        leaseToken: null,
                        payloadJson: JSON.stringify(payload),
                        priority: definition.priority,
                        queuedAt: at,
                        requestedById: audit.actor.id,
                        requestedByKind: audit.actor.kind,
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
                        triggerType: "manual",
                        updatedAt: at,
                    },
                });
                if (result.kind === "idempotency-mismatch") {
                    throw new WorkspaceFileError("conflict");
                }
                if (result.kind === "action-unavailable" || result.kind === "active") {
                    throw new WorkspaceFileError("unavailable");
                }
                const matched = matchingRun(
                    result.run,
                    command.ticketId,
                    payload.actorBindingSha256
                );
                if (matched === undefined) throw new WorkspaceFileError("unavailable");
                if (result.kind === "inserted") {
                    try {
                        await dependencies.wakeEventPump?.();
                    } catch {
                        // Durable queue state remains authoritative for the next pump pass.
                    }
                }
                return {
                    acceptedAtMs: getTime(matched.queuedAt),
                    jobRunId: matched.id,
                    ticketId: command.ticketId,
                };
            } catch (error) {
                if (error instanceof WorkspaceFileError) throw error;
                throw new WorkspaceFileError("unavailable", error);
            }
        },
        listActiveSpoolIds(signal?: AbortSignal) {
            try {
                signal?.throwIfAborted();
                const pages = [
                    workspaceFileWriteJobActionKey,
                    workspaceFileReplaceJobActionKey,
                ].map((actionKey) =>
                    dependencies.repository.listActiveActionPayloads({
                        actionKey,
                        limit: 256,
                    })
                );
                signal?.throwIfAborted();
                const payloads = pages.flatMap((page) => page.payloads);
                const truncated =
                    pages.some((page) => page.truncated) || payloads.length > 256;
                if (truncated) return Promise.resolve({ spoolIds: [], truncated: true });
                const spoolIds = payloads.map(
                    (payloadJson) =>
                        parseWorkspaceFileJobPayload(parseJsonText(payloadJson)).command
                            .spoolId
                );
                return Promise.resolve({
                    spoolIds: [...new Set(spoolIds)],
                    truncated: false,
                });
            } catch (error) {
                return Promise.reject(workspaceFileError(error));
            }
        },
        getStatus(
            ticketId: string,
            actor: WorkspaceFileWriteAuditContext["actor"],
            signal?: AbortSignal
        ): Promise<WorkspaceFileWriteStatus | undefined> {
            try {
                signal?.throwIfAborted();
                const binding = actorBinding(actor);
                const run = matchingRun(
                    dependencies.repository.findRunByIdempotency(
                        actor.kind,
                        actor.id,
                        ticketId
                    ),
                    ticketId,
                    binding
                );
                return Promise.resolve(
                    run === undefined
                        ? undefined
                        : {
                              jobRunId: run.id,
                              status: "accepted",
                              ticketId,
                          }
                );
            } catch (error) {
                if (error instanceof WorkspaceFileError) throw error;
                throw new WorkspaceFileError("unavailable", error);
            }
        },
    });
}
