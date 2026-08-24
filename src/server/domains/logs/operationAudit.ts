import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { LogMaintenancePolicyId } from "../../../contracts/logs.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { createSecurityAuditEvent } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export interface LogMaintenanceAuditContext {
    readonly actor: {
        readonly authenticatorId: string;
        readonly id: string;
        readonly kind: "user";
    };
    readonly requestId: string;
}

interface LogMaintenanceAuditEventFields extends LogMaintenanceAuditContext {
    readonly dryRun: boolean;
    readonly policyId: LogMaintenancePolicyId;
}

export type LogMaintenanceAuditEvent = LogMaintenanceAuditEventFields &
    (
        | {
              readonly jobRunId?: never;
              readonly settlement: "attempted" | "failed";
          }
        | {
              readonly jobRunId: string;
              readonly settlement: "queued";
          }
    );

/** Durable audit append port supplied by the central database composition. */
export interface LogMaintenanceAuditWriter {
    readonly record: (event: LogMaintenanceAuditEvent) => Promise<void>;
}

export interface SqliteLogMaintenanceAuditWriterOptions {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

function classifiedSettlement(
    settlement: LogMaintenanceAuditEvent["settlement"]
): "attempted" | "failed" | "succeeded" {
    if (settlement === "queued") return "succeeded";
    return settlement;
}

/**
 * Creates a short admitted audit append linking each request to its policy or queued run.
 * @returns Durable, redacted log-maintenance audit writer.
 */
export function createSqliteLogMaintenanceAuditWriter({
    clock = () => new Date(),
    database,
    generateId = () => Bun.randomUUIDv7(),
    writeAdmission,
}: SqliteLogMaintenanceAuditWriterOptions): LogMaintenanceAuditWriter {
    return Object.freeze({
        record(input: LogMaintenanceAuditEvent) {
            const event = createSecurityAuditEvent({
                action: input.dryRun
                    ? "logs.maintenance.dry-run.request"
                    : "logs.maintenance.request",
                actor: input.actor,
                id: generateId(),
                metadata: {
                    settlement: classifiedSettlement(input.settlement),
                },
                occurredAt: clock(),
                outcome: classifiedSettlement(input.settlement),
                requestId: input.requestId,
                targetId: input.settlement === "queued" ? input.jobRunId : input.policyId,
                targetType:
                    input.settlement === "queued" ? "job-run" : "log-maintenance-policy",
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
