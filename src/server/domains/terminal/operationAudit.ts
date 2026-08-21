import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { createSecurityAuditEvent } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export interface TerminalOperationAuditContext {
    readonly actor: {
        readonly authenticatorId: string;
        readonly id: string;
        readonly kind: "user";
    };
    readonly requestId: string;
}

export interface TerminalOperationAuditEvent extends TerminalOperationAuditContext {
    readonly operation: "prepare" | "resume" | "terminate";
    readonly rootId?: string;
    readonly sessionId: string;
    readonly settlement: "attempted" | "failed" | "succeeded";
}

/** Durable audit append port. Terminal input and output are intentionally absent. */
export interface TerminalOperationAuditWriter {
    readonly record: (event: TerminalOperationAuditEvent) => Promise<void>;
}

export interface SqliteTerminalOperationAuditWriterOptions {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

function auditOutcome(
    settlement: TerminalOperationAuditEvent["settlement"]
): "attempted" | "failed" | "succeeded" {
    if (settlement === "attempted") return "attempted";
    if (settlement === "succeeded") return "succeeded";
    return "failed";
}

/**
 * Creates an admitted append-only lifecycle audit that cannot receive PTY contents.
 * @returns A durable, admitted terminal lifecycle audit writer.
 */
export function createSqliteTerminalOperationAuditWriter({
    clock = () => new Date(),
    database,
    generateId = () => Bun.randomUUIDv7(),
    writeAdmission,
}: SqliteTerminalOperationAuditWriterOptions): TerminalOperationAuditWriter {
    return Object.freeze({
        record(input: TerminalOperationAuditEvent) {
            const event = createSecurityAuditEvent({
                action: `terminal.session.${input.operation}`,
                actor: input.actor,
                id: generateId(),
                metadata: { settlement: input.settlement },
                occurredAt: clock(),
                outcome: auditOutcome(input.settlement),
                requestId: input.requestId,
                targetId: input.sessionId,
                targetType: "terminal-session",
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
