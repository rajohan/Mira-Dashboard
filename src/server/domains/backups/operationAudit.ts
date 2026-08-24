import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type {
    BackupRequestOperationInput,
    BackupType,
} from "../../../contracts/backups.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { createSecurityAuditEvent } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export interface BackupOperationActor {
    readonly authenticatorId: string;
    readonly id: string;
    readonly kind: "user";
}

export interface BackupOperationAuditContext {
    readonly actor: BackupOperationActor;
    readonly requestId: string;
}

export type BackupOperationAuditEvent = BackupOperationAuditContext & {
    readonly jobRunId?: string;
    readonly operation: BackupRequestOperationInput["operation"];
    readonly settlement: "attempted" | "failed" | "queued";
    readonly type: BackupType;
};

export interface BackupOperationAuditWriter {
    readonly record: (event: BackupOperationAuditEvent) => Promise<void>;
}

/**
 * Creates an admitted append-only backup audit writer with no provider identifiers.
 *
 * @param options - Database, admission, clock, and identifier dependencies.
 * @returns The immutable append-only backup audit writer.
 */
export function createSqliteBackupOperationAuditWriter(options: {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}): BackupOperationAuditWriter {
    const clock = options.clock ?? (() => new Date());
    const generateId = options.generateId ?? (() => Bun.randomUUIDv7());
    const writer: BackupOperationAuditWriter = {
        record(input) {
            const settlement =
                input.settlement === "queued" ? "succeeded" : input.settlement;
            const event = createSecurityAuditEvent({
                action: `backups.${input.type}.${input.operation}.request`,
                actor: input.actor,
                id: generateId(),
                metadata: { settlement },
                occurredAt: clock(),
                outcome: settlement,
                requestId: input.requestId,
                targetId:
                    input.settlement === "queued"
                        ? input.jobRunId!
                        : `${input.type}:${input.operation}`,
                targetType:
                    input.settlement === "queued" ? "job-run" : "backup-operation",
            });
            return options.writeAdmission.run((markTransactionStarted) =>
                options.database.transaction(
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
    };
    return Object.freeze(writer);
}
