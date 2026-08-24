import * as v from "valibot";

import {
    type DockerGetContainerLogsInput,
    type DockerGetContainerLogsResult,
    type DockerOverview,
    type DockerPreparePruneInput,
    type DockerPreparePruneResult,
    type DockerRequestOperationInput,
    type DockerRequestOperationResult,
    dockerGetContainerLogsInputSchema,
    dockerGetContainerLogsResultSchema,
    dockerOverviewCacheKey,
    dockerOverviewCachePayloadSchema,
    dockerOverviewCacheSchemaId,
    dockerOverviewCacheSource,
    dockerOverviewSchema,
    dockerPreparePruneInputSchema,
    dockerPreparePruneResultSchema,
    dockerPrunePreviewTicketTtlMs,
    dockerRequestOperationInputSchema,
    dockerRequestOperationResultSchema,
} from "../../../contracts/docker.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { DockerOperationJobPayload } from "./jobPayload.ts";
import type {
    DockerOperationAuditContext,
    DockerOperationAuditWriter,
    DockerOperationActor,
} from "./operationAudit.ts";
import {
    type DockerOperationQueue,
    DockerOperationQueueError,
} from "./operationQueue.ts";
import type {
    DockerOverviewSnapshotRecord,
    DockerOverviewSnapshotRepository,
} from "./snapshotRepository.ts";

/** Maximum age of a retained successful Docker snapshot. */
export const dockerOverviewLastKnownGoodMs = 24 * 60 * 60 * 1000;
const dockerPruneTicketCapacity = 128;
const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

export type DockerServiceErrorReason =
    | "audit-unavailable"
    | "conflict"
    | "not-found"
    | "unavailable"
    | "unknown-outcome";

/** Publicly safe domain failure without Docker output, paths, or source content. */
export class DockerServiceError extends Error {
    readonly reason: DockerServiceErrorReason;

    constructor(reason: DockerServiceErrorReason, options?: ErrorOptions) {
        super("Docker operation failed", options);
        this.name = "DockerServiceError";
        this.reason = reason;
    }

    toJSON() {
        return Object.freeze({ name: this.name, reason: this.reason });
    }

    [inspectSymbol](): ReturnType<DockerServiceError["toJSON"]> {
        return this.toJSON();
    }
}

export type DockerWorkerPrunePreview =
    | Omit<
          Extract<DockerPreparePruneResult, { readonly target: "images" }>,
          "expiresAtMs" | "issuedAtMs" | "ticketId"
      >
    | Omit<
          Extract<DockerPreparePruneResult, { readonly target: "volumes" }>,
          "expiresAtMs" | "issuedAtMs" | "ticketId"
      >;

/** Sanitized worker-read error; raw Engine/Compose diagnostics stay behind the port. */
export class DockerWorkerReadPortError extends Error {
    readonly reason: "conflict" | "not-found" | "unavailable";

    constructor(reason: DockerWorkerReadPortError["reason"]) {
        super("Docker worker read failed");
        this.name = "DockerWorkerReadPortError";
        this.reason = reason;
    }
}

/** Narrow web-to-worker read boundary. It contains no generic command surface. */
export interface DockerWorkerReadPort {
    readonly previewPrune: (
        input: DockerPreparePruneInput,
        signal?: AbortSignal
    ) => Promise<DockerWorkerPrunePreview>;
    readonly readContainerLogs: (
        input: DockerGetContainerLogsInput,
        signal?: AbortSignal
    ) => Promise<DockerGetContainerLogsResult>;
}

export interface DockerReadContext {
    readonly actor: DockerOperationActor;
}

export interface DockerControlContext extends DockerOperationAuditContext {
    /** Re-checks this exact session and recent MFA in durable enqueue admission. */
    readonly reauthorize: () => void;
}

export interface DockerService {
    readonly getContainerLogs: (
        input: DockerGetContainerLogsInput,
        signal?: AbortSignal
    ) => Promise<DockerGetContainerLogsResult>;
    readonly overview: () => DockerOverview;
    readonly preparePrune: (
        input: DockerPreparePruneInput,
        context: DockerReadContext,
        signal?: AbortSignal
    ) => Promise<DockerPreparePruneResult>;
    readonly requestOperation: (
        input: DockerRequestOperationInput,
        context: DockerControlContext,
        signal?: AbortSignal
    ) => Promise<DockerRequestOperationResult>;
}

export interface DockerServiceOptions {
    readonly auditWriter: DockerOperationAuditWriter;
    readonly generateId?: () => string;
    readonly lastKnownGoodMs?: number;
    readonly nowMs?: () => number;
    readonly onAuditSettlementFailure?: (event: {
        readonly operation: DockerRequestOperationInput["operation"];
        readonly settlement: "failed" | "queued";
    }) => void;
    readonly operationQueue: DockerOperationQueue;
    readonly snapshotRepository: DockerOverviewSnapshotRepository;
    readonly workerReadPort: DockerWorkerReadPort;
}

interface PruneTicketRecord {
    readonly actor: DockerOperationActor;
    readonly result: DockerPreparePruneResult;
}

interface AuthorizedOperation {
    readonly payload: DockerOperationJobPayload;
    readonly pruneTicket?: PruneTicketRecord;
}

function checkedTime(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new DockerServiceError("unavailable");
    }
    return value;
}

function unavailable(checkedAtMs: number): DockerOverview {
    return v.parse(dockerOverviewSchema, { checkedAtMs, state: "unavailable" });
}

function projectSnapshot(
    record: DockerOverviewSnapshotRecord | undefined,
    checkedAtMs: number,
    lastKnownGoodMs: number
): DockerOverview {
    if (
        record === undefined ||
        record.key !== dockerOverviewCacheKey ||
        record.schemaId !== dockerOverviewCacheSchemaId ||
        record.source !== dockerOverviewCacheSource ||
        record.expiresAtMs === null ||
        record.lastSuccessAtMs === null
    ) {
        return unavailable(checkedAtMs);
    }
    if (
        [record.expiresAtMs, record.lastAttemptAtMs, record.lastSuccessAtMs].some(
            (value) => !Number.isSafeInteger(value) || value < 0
        ) ||
        record.lastAttemptAtMs > checkedAtMs ||
        record.lastSuccessAtMs > record.lastAttemptAtMs ||
        record.expiresAtMs <= record.lastSuccessAtMs ||
        (record.lastAttemptStatus === "succeeded" &&
            record.lastAttemptAtMs !== record.lastSuccessAtMs) ||
        checkedAtMs - record.lastSuccessAtMs > lastKnownGoodMs
    ) {
        return unavailable(checkedAtMs);
    }
    let payload: unknown = record.payload;
    if (typeof payload === "string") {
        try {
            payload = parseJsonText(payload);
        } catch {
            return unavailable(checkedAtMs);
        }
    }
    const parsed = v.safeParse(dockerOverviewCachePayloadSchema, payload);
    if (
        !parsed.success ||
        parsed.output.observedAtMs > record.lastSuccessAtMs ||
        parsed.output.observedAtMs > checkedAtMs
    ) {
        return unavailable(checkedAtMs);
    }
    const fresh =
        record.lastAttemptStatus === "succeeded" &&
        record.lastAttemptAtMs === record.lastSuccessAtMs &&
        record.expiresAtMs > checkedAtMs;
    if (fresh) {
        return v.parse(dockerOverviewSchema, {
            ...parsed.output,
            checkedAtMs,
            state: "fresh",
        });
    }
    const staleSinceMs =
        record.lastAttemptStatus === "failed"
            ? record.lastAttemptAtMs
            : record.expiresAtMs;
    if (staleSinceMs < parsed.output.observedAtMs || staleSinceMs > checkedAtMs) {
        return unavailable(checkedAtMs);
    }
    return v.parse(dockerOverviewSchema, {
        ...parsed.output,
        checkedAtMs,
        staleSinceMs,
        state: "last-known-good",
    });
}

function workerFailure(error: unknown): DockerServiceError {
    if (error instanceof DockerServiceError) return error;
    if (error instanceof DockerWorkerReadPortError) {
        return new DockerServiceError(error.reason, { cause: error });
    }
    return new DockerServiceError("unavailable", { cause: error });
}

function queueFailure(error: DockerOperationQueueError): DockerServiceError {
    return new DockerServiceError(error.reason, { cause: error });
}

/**
 * Creates strict cache projection, bounded worker reads, actor-bound prune previews,
 * and audited durable Docker mutation admission.
 * @param options Cache, worker, queue, audit, clock, and id boundaries.
 * @returns One request-safe Docker domain service.
 */
export function createDockerService(options: DockerServiceOptions): DockerService {
    const generateId = options.generateId ?? (() => Bun.randomUUIDv7());
    const lastKnownGoodMs = options.lastKnownGoodMs ?? dockerOverviewLastKnownGoodMs;
    if (!Number.isSafeInteger(lastKnownGoodMs) || lastKnownGoodMs < 0) {
        throw new RangeError("Docker snapshot stale window is invalid");
    }
    const nowMs = options.nowMs ?? Date.now;
    const tickets = new Map<string, PruneTicketRecord>();

    function overview(): DockerOverview {
        let checkedAtMs = 0;
        try {
            checkedAtMs = checkedTime(nowMs);
            return projectSnapshot(
                options.snapshotRepository.read(),
                checkedAtMs,
                lastKnownGoodMs
            );
        } catch {
            return unavailable(checkedAtMs);
        }
    }

    function freshSnapshot(
        sourceRevision: string
    ): Extract<DockerOverview, { readonly state: "fresh" }> {
        const snapshot = overview();
        if (snapshot.state !== "fresh" || snapshot.sourceRevision !== sourceRevision) {
            throw new DockerServiceError("conflict");
        }
        return snapshot;
    }

    function purgeExpiredTickets(atMs: number): void {
        for (const [ticketId, ticket] of tickets) {
            if (ticket.result.expiresAtMs <= atMs) tickets.delete(ticketId);
        }
    }

    function requirePruneTicketCapacity(atMs: number): void {
        purgeExpiredTickets(atMs);
        if (tickets.size >= dockerPruneTicketCapacity) {
            throw new DockerServiceError("unavailable");
        }
    }

    function ticketPayload(
        input: Extract<DockerRequestOperationInput, { operation: "prune-execute" }>,
        actor: DockerOperationActor
    ): AuthorizedOperation {
        const atMs = checkedTime(nowMs);
        purgeExpiredTickets(atMs);
        const ticket = tickets.get(input.ticketId);
        if (
            ticket === undefined ||
            ticket.actor.id !== actor.id ||
            ticket.actor.authenticatorId !== actor.authenticatorId
        ) {
            throw new DockerServiceError("not-found");
        }
        if (
            ticket.result.target !== input.target ||
            ticket.result.sourceRevision !== input.sourceRevision
        ) {
            throw new DockerServiceError("conflict");
        }
        return {
            payload:
                ticket.result.target === "images"
                    ? {
                          imageIds: ticket.result.items.map(({ id }) => id),
                          operation: "prune-execute",
                          sourceRevision: ticket.result.sourceRevision,
                          target: "images",
                      }
                    : {
                          operation: "prune-execute",
                          sourceRevision: ticket.result.sourceRevision,
                          target: "volumes",
                          volumeNames: ticket.result.items.map(({ name }) => name),
                      },
            pruneTicket: ticket,
        };
    }

    function authorizedOperation(
        input: DockerRequestOperationInput,
        actor: DockerOperationActor
    ): AuthorizedOperation {
        const snapshot = freshSnapshot(input.sourceRevision);
        switch (input.operation) {
            case "container-restart":
            case "container-start":
            case "container-stop": {
                if (!snapshot.containers.some(({ id }) => id === input.containerId)) {
                    throw new DockerServiceError("not-found");
                }
                return {
                    payload: {
                        containerId: input.containerId,
                        operation: input.operation,
                        sourceRevision: input.sourceRevision,
                    },
                };
            }
            case "image-delete": {
                const image = snapshot.images.find(({ id }) => id === input.imageId);
                if (image === undefined) throw new DockerServiceError("not-found");
                if (image.usedByContainerIds.length > 0) {
                    throw new DockerServiceError("conflict");
                }
                return {
                    payload: {
                        imageId: input.imageId,
                        operation: input.operation,
                        sourceRevision: input.sourceRevision,
                    },
                };
            }
            case "prune-execute": {
                return ticketPayload(input, actor);
            }
            case "updater-update-service": {
                const service = snapshot.updaterServices.find(
                    ({ id }) => id === input.serviceId
                );
                if (service === undefined) throw new DockerServiceError("not-found");
                if (
                    service.policy.state !== "managed" ||
                    service.status.state !== "update-available" ||
                    service.currentImage !== input.currentImage ||
                    service.status.candidateImage !== input.candidateImage
                ) {
                    throw new DockerServiceError("conflict");
                }
                return {
                    payload: {
                        candidateImage: input.candidateImage,
                        currentImage: input.currentImage,
                        operation: input.operation,
                        serviceId: input.serviceId,
                        sourceRevision: input.sourceRevision,
                    },
                };
            }
            case "volume-delete": {
                const volume = snapshot.volumes.find(
                    ({ name }) => name === input.volumeName
                );
                if (volume === undefined) throw new DockerServiceError("not-found");
                if (volume.usedByContainerIds.length > 0) {
                    throw new DockerServiceError("conflict");
                }
                return {
                    payload: {
                        operation: input.operation,
                        sourceRevision: input.sourceRevision,
                        volumeName: input.volumeName,
                    },
                };
            }
            case "stack-restart":
            case "stack-start":
            case "stack-stop":
            case "updater-run":
            case "updater-scan": {
                return {
                    payload: {
                        operation: input.operation,
                        sourceRevision: input.sourceRevision,
                    },
                };
            }
        }
    }

    async function settleAudit(
        input: DockerRequestOperationInput,
        context: DockerOperationAuditContext,
        settlement:
            | { readonly kind: "failed" }
            | { readonly jobRunId: string; readonly kind: "queued" }
    ): Promise<void> {
        try {
            await options.auditWriter.record(
                settlement.kind === "queued"
                    ? {
                          ...context,
                          jobRunId: settlement.jobRunId,
                          operation: input.operation,
                          settlement: "queued",
                      }
                    : {
                          ...context,
                          operation: input.operation,
                          settlement: "failed",
                      }
            );
        } catch {
            try {
                options.onAuditSettlementFailure?.({
                    operation: input.operation,
                    settlement: settlement.kind,
                });
            } catch {
                // Observation cannot replace an already-known durable queue outcome.
            }
        }
    }

    const service: DockerService = {
        async getContainerLogs(input, signal) {
            const parsed = v.parse(dockerGetContainerLogsInputSchema, input);
            signal?.throwIfAborted();
            const snapshot = freshSnapshot(parsed.sourceRevision);
            if (!snapshot.containers.some(({ id }) => id === parsed.containerId)) {
                throw new DockerServiceError("not-found");
            }
            try {
                const result = v.parse(
                    dockerGetContainerLogsResultSchema,
                    await options.workerReadPort.readContainerLogs(parsed, signal)
                );
                if (
                    result.containerId !== parsed.containerId ||
                    result.sourceRevision !== parsed.sourceRevision ||
                    result.observedAtMs > checkedTime(nowMs)
                ) {
                    throw new DockerServiceError("conflict");
                }
                return result;
            } catch (error) {
                throw workerFailure(error);
            }
        },
        overview,
        async preparePrune(input, context, signal) {
            const parsed = v.parse(dockerPreparePruneInputSchema, input);
            signal?.throwIfAborted();
            freshSnapshot(parsed.sourceRevision);
            requirePruneTicketCapacity(checkedTime(nowMs));
            let preview: DockerWorkerPrunePreview;
            try {
                preview = await options.workerReadPort.previewPrune(parsed, signal);
            } catch (error) {
                throw workerFailure(error);
            }
            signal?.throwIfAborted();
            const issuedAtMs = checkedTime(nowMs);
            requirePruneTicketCapacity(issuedAtMs);
            let result: DockerPreparePruneResult;
            try {
                result = v.parse(dockerPreparePruneResultSchema, {
                    ...preview,
                    expiresAtMs: issuedAtMs + dockerPrunePreviewTicketTtlMs,
                    issuedAtMs,
                    ticketId: generateId(),
                });
            } catch (error) {
                throw workerFailure(error);
            }
            if (
                result.sourceRevision !== parsed.sourceRevision ||
                result.target !== parsed.target
            ) {
                throw new DockerServiceError("conflict");
            }
            if (tickets.has(result.ticketId)) {
                throw new DockerServiceError("unavailable");
            }
            tickets.set(result.ticketId, {
                actor: { ...context.actor },
                result,
            });
            return result;
        },
        async requestOperation(input, context, signal) {
            const parsed = v.parse(dockerRequestOperationInputSchema, input);
            signal?.throwIfAborted();
            try {
                await options.auditWriter.record({
                    actor: context.actor,
                    operation: parsed.operation,
                    requestId: context.requestId,
                    settlement: "attempted",
                });
            } catch (error) {
                throw new DockerServiceError("audit-unavailable", { cause: error });
            }
            try {
                const result = await options.operationQueue.enqueue({
                    actor: context.actor,
                    authorizeDispatch: () => {
                        const authorized = authorizedOperation(parsed, context.actor);
                        const serialized = JSON.stringify(authorized.payload);
                        return Promise.resolve({
                            authorize: () => {
                                context.reauthorize();
                                const admitted = authorizedOperation(
                                    parsed,
                                    context.actor
                                );
                                if (
                                    JSON.stringify(admitted.payload) !== serialized ||
                                    admitted.pruneTicket !== authorized.pruneTicket
                                ) {
                                    throw new DockerServiceError("conflict");
                                }
                            },
                            onAccepted: () => {
                                if (
                                    parsed.operation === "prune-execute" &&
                                    authorized.pruneTicket !== undefined &&
                                    tickets.get(parsed.ticketId) ===
                                        authorized.pruneTicket
                                ) {
                                    tickets.delete(parsed.ticketId);
                                }
                            },
                            payload: authorized.payload,
                        });
                    },
                    input: parsed,
                    requestId: context.requestId,
                    signal,
                });
                const output = v.parse(dockerRequestOperationResultSchema, result);
                await settleAudit(parsed, context, {
                    jobRunId: output.jobRunId,
                    kind: "queued",
                });
                return output;
            } catch (error) {
                await settleAudit(parsed, context, { kind: "failed" });
                if (error instanceof DockerOperationQueueError) {
                    throw queueFailure(error);
                }
                if (error instanceof v.ValiError) {
                    throw new DockerServiceError("unavailable", { cause: error });
                }
                throw error;
            }
        },
    };
    return Object.freeze(service);
}
