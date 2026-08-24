import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    type GetServiceActionsStatusResult,
    type RequestServiceActionInput,
    type RequestServiceActionResult,
    type ServiceActionStatus,
    getServiceActionsStatusResultSchema,
    requestServiceActionInputSchema,
    requestServiceActionResultSchema,
} from "../../../contracts/serviceActions.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import {
    ServiceActionQueueError,
    type ServiceActionQueue,
} from "../jobs/serviceActionQueue.ts";
import { createSecurityAuditEvent } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export type ServiceActionAuditSettlement =
    | "attempted"
    | "failed"
    | "partial"
    | "succeeded";

export interface ServiceActionAuditContext {
    readonly actor: {
        readonly authenticatorId: string;
        readonly id: string;
        readonly kind: "user";
    };
    readonly requestId: string;
}

export interface ServiceActionAuditEvent extends ServiceActionAuditContext {
    readonly actionId: RequestServiceActionInput["actionId"];
    readonly jobRunId?: string;
    readonly settlement: ServiceActionAuditSettlement;
}

/** Durable audit append port. Commands, provider results, and host details are absent. */
export interface ServiceActionAuditWriter {
    readonly record: (event: ServiceActionAuditEvent) => Promise<void>;
}

export interface SqliteServiceActionAuditWriterOptions {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

function auditOutcome(
    settlement: ServiceActionAuditSettlement
): "attempted" | "failed" | "succeeded" {
    if (settlement === "attempted") return "attempted";
    if (settlement === "succeeded") return "succeeded";
    return "failed";
}

/**
 * Creates a fail-closed admitted audit writer for fixed privileged service actions.
 * @returns A sanitized append-only audit writer.
 */
export function createSqliteServiceActionAuditWriter({
    clock = () => new Date(),
    database,
    generateId = () => Bun.randomUUIDv7(),
    writeAdmission,
}: SqliteServiceActionAuditWriterOptions): ServiceActionAuditWriter {
    return Object.freeze({
        record(input: ServiceActionAuditEvent) {
            const event = createSecurityAuditEvent({
                action: `service-actions.${input.actionId}.request`,
                actor: input.actor,
                id: generateId(),
                metadata: { settlement: input.settlement },
                occurredAt: clock(),
                outcome: auditOutcome(input.settlement),
                requestId: input.requestId,
                targetId: input.jobRunId ?? input.actionId,
                targetType: input.jobRunId === undefined ? "service-action" : "job-run",
            });
            return writeAdmission.run((markTransactionStarted) =>
                database.transaction(
                    (transaction) => {
                        markTransactionStarted();
                        new DrizzleSecurityAuditStore(transaction).insertAuditEvent(
                            event
                        );
                    },
                    { behavior: "immediate" }
                )
            );
        },
    });
}

export type ServiceActionsServiceErrorReason =
    | "audit-unavailable"
    | "conflict"
    | "unavailable"
    | "unknown-outcome";

/** Sanitized domain failure without commands, provider results, or host diagnostics. */
export class ServiceActionsServiceError extends Error {
    readonly reason: ServiceActionsServiceErrorReason;

    constructor(reason: ServiceActionsServiceErrorReason, options?: ErrorOptions) {
        super("Service action operation failed", options);
        this.name = "ServiceActionsServiceError";
        this.reason = reason;
    }
}

export interface ServiceActionControlContext extends ServiceActionAuditContext {
    /** Re-checks the current session and recent MFA inside durable enqueue admission. */
    readonly reauthorize: () => void;
}

export interface ServiceActionStatusReader {
    readonly read: (signal?: AbortSignal) => Promise<readonly ServiceActionStatus[]>;
}

export interface ServiceActionsService {
    readonly getStatus: (signal?: AbortSignal) => Promise<GetServiceActionsStatusResult>;
    readonly request: (
        input: RequestServiceActionInput,
        context: ServiceActionControlContext,
        signal?: AbortSignal
    ) => Promise<RequestServiceActionResult>;
}

export interface ServiceActionsServiceOptions {
    readonly auditWriter: ServiceActionAuditWriter;
    readonly nowMs?: () => number;
    readonly onAuditSettlementFailure?: (failure: {
        readonly actionId: RequestServiceActionInput["actionId"];
        readonly cause: unknown;
        readonly settlement: Exclude<ServiceActionAuditSettlement, "attempted">;
    }) => void;
    readonly queue: ServiceActionQueue;
    readonly statusReader: ServiceActionStatusReader;
}

function queueFailure(error: ServiceActionQueueError): ServiceActionsServiceError {
    return new ServiceActionsServiceError(error.reason, { cause: error });
}

function validNowMs(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ServiceActionsServiceError("unavailable");
    }
    return value;
}

/**
 * Creates status reads and fail-closed audited enqueue controls for fixed service actions.
 * @param options Queue, status, audit, clock, and settlement-observation boundaries.
 * @returns A sanitized Service Actions domain service.
 */
export function createServiceActionsService(
    options: ServiceActionsServiceOptions
): ServiceActionsService {
    const nowMs = options.nowMs ?? Date.now;

    async function recordAttempt(
        input: RequestServiceActionInput,
        context: ServiceActionAuditContext
    ): Promise<void> {
        try {
            await options.auditWriter.record({
                ...context,
                actionId: input.actionId,
                settlement: "attempted",
            });
        } catch (error) {
            throw new ServiceActionsServiceError("audit-unavailable", { cause: error });
        }
    }

    async function settleAudit(
        input: RequestServiceActionInput,
        context: ServiceActionAuditContext,
        settlement: Exclude<ServiceActionAuditSettlement, "attempted">,
        jobRunId?: string
    ): Promise<void> {
        try {
            await options.auditWriter.record({
                ...context,
                actionId: input.actionId,
                ...(jobRunId === undefined ? {} : { jobRunId }),
                settlement,
            });
        } catch (error) {
            try {
                options.onAuditSettlementFailure?.({
                    actionId: input.actionId,
                    cause: error,
                    settlement,
                });
            } catch {
                // Operational observation cannot replace an already-known queue result.
            }
        }
    }

    async function getStatus(
        signal?: AbortSignal
    ): Promise<GetServiceActionsStatusResult> {
        signal?.throwIfAborted();
        try {
            const actions = await options.statusReader.read(signal);
            signal?.throwIfAborted();
            return v.parse(getServiceActionsStatusResultSchema, {
                actions,
                observedAtMs: validNowMs(nowMs),
            });
        } catch (error) {
            if (signal?.aborted) throw error;
            if (error instanceof ServiceActionsServiceError) throw error;
            throw new ServiceActionsServiceError("unavailable", { cause: error });
        }
    }

    async function request(
        input: RequestServiceActionInput,
        context: ServiceActionControlContext,
        signal?: AbortSignal
    ): Promise<RequestServiceActionResult> {
        const parsed = v.parse(requestServiceActionInputSchema, input);
        signal?.throwIfAborted();
        await recordAttempt(parsed, context);
        let authorizationFailed = false;
        let authorizationFailure: unknown;
        try {
            const result = await options.queue.enqueue({
                actionId: parsed.actionId,
                actor: context.actor,
                authorizeDispatch: async () => {
                    signal?.throwIfAborted();
                    const statuses = await options.statusReader.read(signal);
                    if (
                        statuses.find(({ id }) => id === parsed.actionId)
                            ?.availability !== "available"
                    ) {
                        throw new ServiceActionsServiceError("unavailable");
                    }
                    signal?.throwIfAborted();
                    return () => {
                        signal?.throwIfAborted();
                        try {
                            context.reauthorize();
                            signal?.throwIfAborted();
                        } catch (error) {
                            authorizationFailed = true;
                            authorizationFailure = error;
                            throw error;
                        }
                    };
                },
                idempotencyKey: parsed.idempotencyKey,
                requestId: context.requestId,
                ...(signal === undefined ? {} : { signal }),
            });
            if (authorizationFailed) throw authorizationFailure;
            const output = v.parse(requestServiceActionResultSchema, {
                actionId: parsed.actionId,
                jobRunId: result.jobRunId,
                queued: true,
            });
            await settleAudit(parsed, context, "succeeded", output.jobRunId);
            return output;
        } catch (error) {
            if (authorizationFailed) {
                await settleAudit(parsed, context, "failed");
                throw authorizationFailure;
            }
            let mapped: unknown;
            if (error instanceof ServiceActionsServiceError) {
                mapped = error;
            } else if (error instanceof ServiceActionQueueError) {
                mapped = queueFailure(error);
            } else if (error instanceof v.ValiError) {
                mapped = new ServiceActionsServiceError("unknown-outcome", {
                    cause: error,
                });
            } else {
                mapped = signal?.aborted
                    ? error
                    : new ServiceActionsServiceError("unavailable", { cause: error });
            }
            await settleAudit(
                parsed,
                context,
                mapped instanceof ServiceActionsServiceError &&
                    mapped.reason === "unknown-outcome"
                    ? "partial"
                    : "failed"
            );
            throw mapped;
        }
    }

    return Object.freeze({ getStatus, request });
}
