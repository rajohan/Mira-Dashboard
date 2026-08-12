import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ServiceActionId } from "../../../contracts/serviceActions.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
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
    readonly actionId: ServiceActionId;
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
 * @param options Database, admission, clock, and identity dependencies.
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
