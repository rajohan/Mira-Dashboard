import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { createSecurityAuditEvent, type SecurityAuditActor } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export const openClawCronAuditOperations = [
    "delete",
    "reconcile-expired",
    "run",
    "set-enabled",
    "update",
] as const;

export type OpenClawCronAuditOperation = (typeof openClawCronAuditOperations)[number];
export type OpenClawCronAuditSettlement =
    | "attempted"
    | "failed"
    | "partial"
    | "succeeded";

export interface OpenClawCronAuditContext {
    readonly actor: SecurityAuditActor;
    readonly requestId?: string;
}

export interface OpenClawCronOperationAuditInput extends OpenClawCronAuditContext {
    readonly operation: OpenClawCronAuditOperation;
    readonly settlement: OpenClawCronAuditSettlement;
    /** Raw bounded provider identity; persistence stores only its domain-separated digest. */
    readonly targetId: string;
}

export interface OpenClawCronOperationAuditWriter {
    readonly record: (input: OpenClawCronOperationAuditInput) => Promise<void>;
}

export interface SqliteOpenClawCronOperationAuditWriterOptions {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

/**
 * @param targetId Raw bounded provider identity to domain-separate and hash.
 * @returns A stable non-reversible identity for one OpenClaw cron audit target.
 */
export function openClawCronAuditTargetFingerprint(targetId: string): string {
    return `sha256:${sha256Hex(`mira-dashboard:openclaw-cron-target:v1:${targetId}`)}`;
}

function auditOutcome(
    settlement: OpenClawCronAuditSettlement
): "attempted" | "failed" | "succeeded" {
    if (settlement === "attempted") return "attempted";
    if (settlement === "succeeded") return "succeeded";
    return "failed";
}

/**
 * Creates a short admitted SQLite append boundary for sanitized adapter records.
 * Gateway work is completed by the caller outside this transaction.
 * @returns An audit writer that appends one sanitized record per admitted transaction.
 */
export function createSqliteOpenClawCronOperationAuditWriter({
    clock = () => new Date(),
    database,
    generateId = () => Bun.randomUUIDv7(),
    writeAdmission,
}: SqliteOpenClawCronOperationAuditWriterOptions): OpenClawCronOperationAuditWriter {
    return Object.freeze({
        record(input: OpenClawCronOperationAuditInput) {
            const event = createSecurityAuditEvent({
                action: `openclaw.cron.${input.operation}`,
                actor: input.actor,
                id: generateId(),
                metadata: { settlement: input.settlement },
                occurredAt: clock(),
                outcome: auditOutcome(input.settlement),
                ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
                targetId: openClawCronAuditTargetFingerprint(input.targetId),
                targetType: "openclaw-cron-job",
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
