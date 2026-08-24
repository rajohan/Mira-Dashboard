import {
    logMaintenancePolicyIds,
    type ListLogSourcesOutput,
    type LogMaintenancePolicyId,
    type LogMaintenancePolicyStatus,
    type LogMaintenanceRunStatus,
    type LogMaintenanceStatusOutput,
    type LogSnapshotOutput,
    type RequestLogMaintenanceInput,
    type RequestLogMaintenanceOutput,
    type SearchLogsInput,
    type TailLogsInput,
} from "../../../contracts/logs.ts";
import type { SafeLogReader } from "../../platform/logs/safeLogReader.ts";
import { SafeLogReaderError } from "../../platform/logs/safeLogReader.ts";
import type { LogSourceCatalog } from "../../platform/logs/sourceCatalog.ts";
import type {
    LogMaintenanceAuditContext,
    LogMaintenanceAuditEvent,
    LogMaintenanceAuditWriter,
} from "./operationAudit.ts";

export type LogsServiceFailureReason = "audit-unavailable" | "not-found" | "unavailable";

const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

/** Sanitized domain failure without host paths, log content, or process diagnostics. */
export class LogsServiceError extends Error {
    readonly reason: LogsServiceFailureReason;

    constructor(reason: LogsServiceFailureReason) {
        super(`Logs service is ${reason}`);
        this.name = "LogsServiceError";
        this.reason = reason;
    }

    toJSON() {
        return Object.freeze({ name: this.name, reason: this.reason });
    }

    [inspectSymbol](): ReturnType<LogsServiceError["toJSON"]> {
        return this.toJSON();
    }
}

export interface LogMaintenanceQueuePort {
    /** Returns active and latest terminal non-dry-run observations for fixed policies. */
    readonly runStatuses: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenanceRunStatus[]>;
    /** Returns exact policies accepted by this release's durable queue. */
    readonly queueablePolicies: (
        signal?: AbortSignal
    ) => Promise<readonly LogMaintenancePolicyId[]>;
    /** Enqueues a durable worker-owned fixed-policy operation; it never performs host work inline. */
    readonly enqueue: (
        input: RequestLogMaintenanceInput,
        signal?: AbortSignal
    ) => Promise<{ readonly jobRunId: string }>;
}

export interface LogsServiceDependencies {
    readonly auditWriter: LogMaintenanceAuditWriter;
    readonly catalog: LogSourceCatalog;
    readonly maintenanceQueue: LogMaintenanceQueuePort;
    readonly now?: () => number;
    readonly onAuditSettlementFailure?: (fields: {
        readonly dryRun: boolean;
        readonly policyId: LogMaintenancePolicyId;
        readonly settlement: "failed" | "queued";
    }) => void;
    readonly reader: SafeLogReader;
}

const policyMetadata: Readonly<
    Record<LogMaintenancePolicyId, Pick<LogMaintenancePolicyStatus, "label" | "scope">>
> = Object.freeze({
    "docker-managed": {
        label: "Managed application and container logs",
        scope: "docker",
    },
    "host-alternatives": { label: "Host alternatives log", scope: "host" },
    "host-apport": { label: "Host Apport log", scope: "host" },
    "host-dpkg": { label: "Host package log", scope: "host" },
    "host-rsyslog": { label: "Host system, auth, and kernel logs", scope: "host" },
});

function serviceFailure(error: unknown): LogsServiceError {
    if (error instanceof LogsServiceError) return error;
    if (error instanceof SafeLogReaderError && error.reason === "not-found") {
        return new LogsServiceError("not-found");
    }
    return new LogsServiceError("unavailable");
}

export interface LogsService {
    readonly listSources: () => Promise<ListLogSourcesOutput>;
    readonly maintenanceStatus: (
        signal?: AbortSignal
    ) => Promise<LogMaintenanceStatusOutput>;
    readonly requestMaintenance: (
        input: RequestLogMaintenanceInput,
        auditContext: LogMaintenanceAuditContext,
        signal?: AbortSignal
    ) => Promise<RequestLogMaintenanceOutput>;
    readonly search: (input: SearchLogsInput) => Promise<LogSnapshotOutput>;
    readonly tail: (input: TailLogsInput) => Promise<LogSnapshotOutput>;
}

/**
 * Creates the read-only log projection and worker-queue maintenance boundary.
 * @param dependencies Catalog, reader, durable audit, queue, and replaceable hooks.
 * @returns A sanitized Logs domain service.
 */
export function createLogsService({
    auditWriter,
    catalog,
    maintenanceQueue,
    now = Date.now,
    onAuditSettlementFailure = () => {},
    reader,
}: LogsServiceDependencies): LogsService {
    async function recordAttempt(
        input: RequestLogMaintenanceInput,
        context: LogMaintenanceAuditContext
    ): Promise<void> {
        try {
            await auditWriter.record({
                ...context,
                dryRun: input.dryRun,
                policyId: input.policyId,
                settlement: "attempted",
            });
        } catch {
            throw new LogsServiceError("audit-unavailable");
        }
    }

    async function settle(
        input: RequestLogMaintenanceInput,
        context: LogMaintenanceAuditContext,
        settlement:
            | { readonly kind: "failed" }
            | { readonly jobRunId: string; readonly kind: "queued" }
    ): Promise<void> {
        try {
            const event: LogMaintenanceAuditEvent =
                settlement.kind === "queued"
                    ? {
                          ...context,
                          dryRun: input.dryRun,
                          jobRunId: settlement.jobRunId,
                          policyId: input.policyId,
                          settlement: "queued",
                      }
                    : {
                          ...context,
                          dryRun: input.dryRun,
                          policyId: input.policyId,
                          settlement: "failed",
                      };
            await auditWriter.record(event);
        } catch {
            onAuditSettlementFailure({
                dryRun: input.dryRun,
                policyId: input.policyId,
                settlement: settlement.kind,
            });
        }
    }

    const service: LogsService = {
        async listSources() {
            try {
                return await catalog.list();
            } catch (error) {
                throw serviceFailure(error);
            }
        },
        async maintenanceStatus(signal?: AbortSignal) {
            try {
                const [queueablePolicies, runStatuses] = await Promise.all([
                    maintenanceQueue.queueablePolicies(signal),
                    maintenanceQueue.runStatuses(signal),
                ]);
                const queueable = new Set(queueablePolicies);
                const runStatusByPolicy = new Map(
                    runStatuses.map((status) => [status.policyId, status])
                );
                return {
                    observedAtMs: now(),
                    policies: logMaintenancePolicyIds.map((id) => {
                        const runStatus = runStatusByPolicy.get(id);
                        return {
                            ...(runStatus?.activeRun === undefined
                                ? {}
                                : { activeRun: runStatus.activeRun }),
                            id,
                            ...policyMetadata[id],
                            ...(runStatus?.lastRun === undefined
                                ? {}
                                : { lastRun: runStatus.lastRun }),
                            state: queueable.has(id) ? "queueable" : "unavailable",
                        };
                    }),
                };
            } catch (error) {
                throw serviceFailure(error);
            }
        },
        async requestMaintenance(
            input: RequestLogMaintenanceInput,
            auditContext: LogMaintenanceAuditContext,
            signal?: AbortSignal
        ) {
            await recordAttempt(input, auditContext);
            let result: { readonly jobRunId: string };
            try {
                result = await maintenanceQueue.enqueue(input, signal);
            } catch (error) {
                await settle(input, auditContext, { kind: "failed" });
                throw serviceFailure(error);
            }
            await settle(input, auditContext, {
                jobRunId: result.jobRunId,
                kind: "queued",
            });
            return {
                dryRun: input.dryRun,
                jobRunId: result.jobRunId,
                policyId: input.policyId,
                queued: true,
            };
        },
        async search(input: SearchLogsInput) {
            try {
                return await reader.search(input);
            } catch (error) {
                throw serviceFailure(error);
            }
        },
        async tail(input: TailLogsInput) {
            try {
                return await reader.tail(input);
            } catch (error) {
                throw serviceFailure(error);
            }
        },
    };
    return Object.freeze(service);
}
