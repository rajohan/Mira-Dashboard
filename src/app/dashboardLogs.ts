import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { LogMaintenancePolicyId } from "../contracts/logs.ts";
import type { ImmediateDatabaseWriteAdmission } from "../server/database/immediateWriteAdmission.ts";
import { createLogMaintenanceJobQueue } from "../server/domains/jobs/logMaintenanceQueue.ts";
import type { JobRepository } from "../server/domains/jobs/repository.ts";
import { createSqliteLogMaintenanceAuditWriter } from "../server/domains/logs/operationAudit.ts";
import { createLogsService, type LogsService } from "../server/domains/logs/service.ts";
import { createLogMaintenanceAvailabilityProbe } from "../server/platform/logs/logMaintenanceAvailability.ts";
import { createLogRotationEpochProbe } from "../server/platform/logs/logRotationEpochProbe.ts";
import { createSafeLogReader } from "../server/platform/logs/safeLogReader.ts";
import { createLogSourceCatalog } from "../server/platform/logs/sourceCatalog.ts";

/** Process-owned inputs for the read-only log catalog and durable maintenance queue. */
export interface DashboardLogsOptions {
    readonly dashboardLogsRoot: string;
    readonly database: SQLiteBunDatabase;
    readonly jobRepository: Pick<
        JobRepository,
        | "enqueueManualRun"
        | "findRunByIdempotency"
        | "findSchedule"
        | "readActionPayloadRunSnapshots"
    >;
    readonly logMaintenanceRoot: string;
    readonly now?: () => Date;
    readonly onAuditSettlementFailure?: (fields: {
        readonly dryRun: boolean;
        readonly policyId: LogMaintenancePolicyId;
        readonly settlement: "failed" | "queued";
    }) => void;
    readonly wakeEventPump?: () => Promise<void> | void;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

/**
 * Composes the web-safe Logs domain without granting the web process rotation authority.
 * @param options Database, reviewed roots, clock, and durable queue dependencies.
 * @returns The bounded read service and fixed-policy enqueue boundary.
 */
export function createDashboardLogsService(options: DashboardLogsOptions): LogsService {
    const clock = options.now ?? (() => new Date());
    const nowMs = (): number => clock().getTime();
    const catalog = createLogSourceCatalog({
        dashboardLogsRoot: options.dashboardLogsRoot,
        now: nowMs,
    });
    const maintenanceAvailability = createLogMaintenanceAvailabilityProbe({
        logMaintenanceRoot: options.logMaintenanceRoot,
        nowMs,
    });
    return createLogsService({
        auditWriter: createSqliteLogMaintenanceAuditWriter({
            clock,
            database: options.database,
            writeAdmission: options.writeAdmission,
        }),
        catalog,
        maintenanceQueue: createLogMaintenanceJobQueue({
            availablePolicies: maintenanceAvailability.availablePolicies,
            nowMs,
            repository: options.jobRepository,
            wakeEventPump: options.wakeEventPump,
        }),
        now: nowMs,
        ...(options.onAuditSettlementFailure === undefined
            ? {}
            : {
                  onAuditSettlementFailure: options.onAuditSettlementFailure,
              }),
        reader: createSafeLogReader(
            catalog,
            nowMs,
            createLogRotationEpochProbe({
                logMaintenanceRoot: options.logMaintenanceRoot,
            })
        ),
    });
}
