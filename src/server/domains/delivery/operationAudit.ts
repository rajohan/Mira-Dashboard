import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { DeliveryOperationId } from "../../../contracts/delivery.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { createSecurityAuditEvent } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export interface DeliveryOperationActor {
    readonly authenticatorId: string;
    readonly id: string;
    readonly kind: "automation" | "user";
}

export interface DeliveryOperationAuditContext {
    readonly actor: DeliveryOperationActor;
    readonly requestId: string;
}

export type DeliveryOperationAuditEvent = DeliveryOperationAuditContext &
    (
        | {
              readonly jobRunId?: never;
              readonly operation: DeliveryOperationId;
              readonly settlement: "attempted" | "failed";
          }
        | {
              readonly jobRunId: string;
              readonly operation: DeliveryOperationId;
              readonly settlement: "queued";
          }
    );

/** Append-only redacted audit boundary for Delivery operation admission. */
export interface DeliveryOperationAuditWriter {
    readonly record: (event: DeliveryOperationAuditEvent) => Promise<void>;
}

export interface SqliteDeliveryOperationAuditWriterOptions {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

function auditSettlement(
    settlement: DeliveryOperationAuditEvent["settlement"]
): "attempted" | "failed" | "succeeded" {
    return settlement === "queued" ? "succeeded" : settlement;
}

/**
 * Creates the admitted SQLite audit writer without provider data or mutation targets.
 * @param options Central database, write gate, clock, and id source.
 * @returns One append-only redacted Delivery audit writer.
 */
export function createSqliteDeliveryOperationAuditWriter({
    clock = () => new Date(),
    database,
    generateId = () => Bun.randomUUIDv7(),
    writeAdmission,
}: SqliteDeliveryOperationAuditWriterOptions): DeliveryOperationAuditWriter {
    return Object.freeze({
        record(input: DeliveryOperationAuditEvent) {
            const settlement = auditSettlement(input.settlement);
            const event = createSecurityAuditEvent({
                action: `delivery.${input.operation}.request`,
                actor: input.actor,
                id: generateId(),
                metadata: { settlement },
                occurredAt: clock(),
                outcome: settlement,
                requestId: input.requestId,
                targetId:
                    input.settlement === "queued" ? input.jobRunId : input.operation,
                targetType:
                    input.settlement === "queued" ? "job-run" : "delivery-operation",
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
