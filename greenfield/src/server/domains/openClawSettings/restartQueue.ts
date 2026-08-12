import * as v from "valibot";

import {
    type RestartOpenClawGatewayResult,
    restartOpenClawGatewayResultSchema,
} from "../../../contracts/openClawSettings.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    openClawGatewayRestartJobActionDefinition,
    openClawGatewayRestartJobActionKey,
    openClawGatewayRestartJobResultSchema,
} from "../jobs/actionRegistry.ts";
import { preflightManualEnqueue } from "../jobs/manualEnqueue.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type { JobRepository } from "../jobs/repository.ts";
import { createJobMutationSideEffects } from "../jobs/sideEffects.ts";
import type { OpenClawSettingsAuditContext } from "./operationAudit.ts";

const emptyPayloadSchema = v.strictObject({});
const restartPayload = Object.freeze({});
const restartEnqueueSha256 = sha256Hex(
    JSON.stringify({
        actionKey: openClawGatewayRestartJobActionKey,
        payload: restartPayload,
        version: 1,
    })
);
const defaultConfirmationTimeoutMs = 90_000;
const defaultPollIntervalMs = 50;

export type OpenClawGatewayRestartQueueErrorReason =
    | "conflict"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized durable restart failure; persisted job diagnostics remain inside Jobs. */
export class OpenClawGatewayRestartQueueError extends Error {
    public readonly reason: OpenClawGatewayRestartQueueErrorReason;

    public constructor(reason: OpenClawGatewayRestartQueueErrorReason) {
        super("OpenClaw Gateway restart queue failed");
        this.name = "OpenClawGatewayRestartQueueError";
        this.reason = reason;
    }
}

export interface OpenClawGatewayRestartRequest extends Omit<
    OpenClawSettingsAuditContext,
    "actor"
> {
    readonly actor: {
        readonly authenticatorId: string;
        readonly id: string;
        readonly kind: "user";
    };
    readonly authorizeDispatch: () => Promise<void>;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
}

export interface OpenClawGatewayRestartQueue {
    readonly restart: (
        request: OpenClawGatewayRestartRequest
    ) => Promise<RestartOpenClawGatewayResult>;
}

export interface OpenClawGatewayRestartQueueDependencies {
    readonly confirmationTimeoutMs?: number;
    readonly delay?: (milliseconds: number) => Promise<void>;
    readonly generateId?: () => string;
    readonly monotonicNowMs?: () => number;
    readonly nowMs?: () => number;
    readonly pollIntervalMs?: number;
    readonly repository: Pick<
        JobRepository,
        "enqueueManualRun" | "findRun" | "findRunByIdempotency"
    >;
    readonly wakeEventPump?: () => Promise<void> | void;
}

function requiredPositiveMilliseconds(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`OpenClaw Gateway restart ${label} is invalid`);
    }
    return value;
}

function matchingRun(run: JobRunRecord | undefined): JobRunRecord | undefined {
    if (
        run === undefined ||
        run.actionKey !== openClawGatewayRestartJobActionKey ||
        run.enqueueSha256 !== restartEnqueueSha256
    ) {
        return undefined;
    }
    const payload = v.safeParse(emptyPayloadSchema, parseJsonText(run.payloadJson));
    return payload.success ? run : undefined;
}

function terminalResult(run: JobRunRecord): RestartOpenClawGatewayResult | undefined {
    if (run.state === "queued" || run.state === "running") return undefined;
    if (run.state !== "succeeded" || run.resultJson === null) {
        throw new OpenClawGatewayRestartQueueError("unknown-outcome");
    }
    const result = v.safeParse(
        openClawGatewayRestartJobResultSchema,
        parseJsonText(run.resultJson)
    );
    if (!result.success) {
        throw new OpenClawGatewayRestartQueueError("unknown-outcome");
    }
    return v.parse(restartOpenClawGatewayResultSchema, {
        ...result.output,
        jobRunId: run.id,
    });
}

/**
 * Creates the purpose-built durable restart queue.
 * Once enqueue commits, request cancellation is deliberately ignored while confirming the run.
 * @returns The actor-bound synchronous restart queue.
 */
export function createOpenClawGatewayRestartQueue(
    dependencies: OpenClawGatewayRestartQueueDependencies
): OpenClawGatewayRestartQueue {
    const confirmationTimeoutMs = requiredPositiveMilliseconds(
        dependencies.confirmationTimeoutMs ?? defaultConfirmationTimeoutMs,
        "confirmation timeout"
    );
    const delay =
        dependencies.delay ??
        ((milliseconds: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
    const nowMs = dependencies.nowMs ?? Date.now;
    const pollIntervalMs = requiredPositiveMilliseconds(
        dependencies.pollIntervalMs ?? defaultPollIntervalMs,
        "poll interval"
    );

    function findReplay(
        request: OpenClawGatewayRestartRequest
    ): ReturnType<typeof preflightManualEnqueue> {
        try {
            return preflightManualEnqueue(dependencies.repository, {
                enqueueSha256: restartEnqueueSha256,
                idempotencyKey: request.idempotencyKey,
                requestedById: request.actor.id,
                requestedByKind: request.actor.kind,
            });
        } catch {
            throw new OpenClawGatewayRestartQueueError("unavailable");
        }
    }

    async function waitForTerminal(runId: string): Promise<RestartOpenClawGatewayResult> {
        const startedAt = monotonicNowMs();
        if (!Number.isFinite(startedAt)) {
            throw new OpenClawGatewayRestartQueueError("unavailable");
        }
        while (true) {
            let run: JobRunRecord | undefined;
            try {
                run = matchingRun(dependencies.repository.findRun(runId));
            } catch {
                throw new OpenClawGatewayRestartQueueError("unknown-outcome");
            }
            if (run === undefined) {
                throw new OpenClawGatewayRestartQueueError("unknown-outcome");
            }
            const result = terminalResult(run);
            if (result !== undefined) return result;
            const elapsed = monotonicNowMs() - startedAt;
            if (!Number.isFinite(elapsed) || elapsed >= confirmationTimeoutMs) {
                throw new OpenClawGatewayRestartQueueError("unknown-outcome");
            }
            await delay(Math.min(pollIntervalMs, confirmationTimeoutMs - elapsed));
        }
    }

    return Object.freeze({
        async restart(
            request: OpenClawGatewayRestartRequest
        ): Promise<RestartOpenClawGatewayResult> {
            request.signal?.throwIfAborted();
            const replay = findReplay(request);
            if (replay.kind === "idempotency-mismatch") {
                throw new OpenClawGatewayRestartQueueError("conflict");
            }
            if (replay.kind === "replayed") {
                const run = matchingRun(replay.run);
                if (run === undefined) {
                    throw new OpenClawGatewayRestartQueueError("conflict");
                }
                return waitForTerminal(run.id);
            }

            request.signal?.throwIfAborted();
            await request.authorizeDispatch();
            request.signal?.throwIfAborted();
            const atMs = nowMs();
            if (!Number.isSafeInteger(atMs) || atMs < 0) {
                throw new OpenClawGatewayRestartQueueError("unavailable");
            }
            const at = new Date(atMs);
            const runId = generateId();
            const sideEffects = createJobMutationSideEffects({
                action: "openclaw.settings.restart.enqueue",
                actor: request.actor,
                auditId: generateId(),
                occurredAt: at,
                outcome: "accepted",
                realtime: { id: runId, kind: "run", operation: "created" },
                requestId: request.requestId,
                targetId: runId,
                targetType: "job-run",
            });
            let enqueued: Awaited<ReturnType<JobRepository["enqueueManualRun"]>>;
            try {
                enqueued = await dependencies.repository.enqueueManualRun({
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
                        actionKey: openClawGatewayRestartJobActionDefinition.actionKey,
                        attemptLimit:
                            openClawGatewayRestartJobActionDefinition.attemptLimit,
                        availableAt: at,
                        cancellationPolicy:
                            openClawGatewayRestartJobActionDefinition.cancellationPolicy,
                        cancelRequestedAt: null,
                        cancelRequestedById: null,
                        cancelRequestedByKind: null,
                        displayName:
                            openClawGatewayRestartJobActionDefinition.displayName,
                        enqueueSha256: restartEnqueueSha256,
                        finishedAt: null,
                        firstStartedAt: null,
                        heartbeatAt: null,
                        id: runId,
                        idempotencyKey: request.idempotencyKey,
                        lastAttemptStartedAt: null,
                        leaseExpiresAt: null,
                        leaseOwnerId: null,
                        leaseToken: null,
                        payloadJson: JSON.stringify(restartPayload),
                        priority: openClawGatewayRestartJobActionDefinition.priority,
                        queuedAt: at,
                        requestedById: request.actor.id,
                        requestedByKind: request.actor.kind,
                        resourceClass:
                            openClawGatewayRestartJobActionDefinition.resourceClass,
                        resourceKeysJson: JSON.stringify(
                            openClawGatewayRestartJobActionDefinition.resourceKeys
                        ),
                        resultJson: null,
                        retrySafe: openClawGatewayRestartJobActionDefinition.retrySafe,
                        scheduledForAt: null,
                        scheduledJobId: null,
                        scheduledJobVersion: null,
                        state: "queued",
                        terminalCode: null,
                        terminalMessage: null,
                        timeoutMs: openClawGatewayRestartJobActionDefinition.timeoutMs,
                        triggerType: "manual",
                        updatedAt: at,
                    },
                });
            } catch {
                throw new OpenClawGatewayRestartQueueError("unavailable");
            }
            if (enqueued.kind === "idempotency-mismatch" || enqueued.kind === "active") {
                throw new OpenClawGatewayRestartQueueError("conflict");
            }
            if (enqueued.kind === "action-unavailable") {
                throw new OpenClawGatewayRestartQueueError("unavailable");
            }
            const run = matchingRun(enqueued.run);
            if (run === undefined) {
                throw new OpenClawGatewayRestartQueueError("unknown-outcome");
            }
            if (enqueued.kind === "inserted") {
                try {
                    await dependencies.wakeEventPump?.();
                } catch {
                    // The durable run remains authoritative for worker polling.
                }
            }
            return waitForTerminal(run.id);
        },
    });
}
