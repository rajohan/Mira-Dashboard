import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { DockerOperationId } from "../../../contracts/docker.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { createSecurityAuditEvent } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export interface DockerOperationActor {
    readonly authenticatorId: string;
    readonly id: string;
    readonly kind: "user";
}

export interface DockerOperationAuditContext {
    readonly actor: DockerOperationActor;
    readonly requestId: string;
}

export type DockerOperationAuditEvent = DockerOperationAuditContext &
    (
        | {
              readonly jobRunId?: never;
              readonly operation: DockerOperationId;
              readonly settlement: "attempted" | "failed";
          }
        | {
              readonly jobRunId: string;
              readonly operation: DockerOperationId;
              readonly settlement: "queued";
          }
    );

/** Append-only redacted audit boundary for Docker operation admission. */
export interface DockerOperationAuditWriter {
    readonly record: (event: DockerOperationAuditEvent) => Promise<void>;
}

export interface SqliteDockerOperationAuditWriterOptions {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

function auditSettlement(
    settlement: DockerOperationAuditEvent["settlement"]
): "attempted" | "failed" | "succeeded" {
    return settlement === "queued" ? "succeeded" : settlement;
}

/**
 * Creates the admitted SQLite audit writer without recording targets or provider data.
 * @param options Central database, admission gate, clock, and id source.
 * @returns One append-only redacted Docker audit writer.
 */
export function createSqliteDockerOperationAuditWriter({
    clock = () => new Date(),
    database,
    generateId = () => Bun.randomUUIDv7(),
    writeAdmission,
}: SqliteDockerOperationAuditWriterOptions): DockerOperationAuditWriter {
    return Object.freeze({
        record(input: DockerOperationAuditEvent) {
            const settlement = auditSettlement(input.settlement);
            const event = createSecurityAuditEvent({
                action: `docker.${input.operation}.request`,
                actor: input.actor,
                id: generateId(),
                metadata: { settlement },
                occurredAt: clock(),
                outcome: settlement,
                requestId: input.requestId,
                targetId:
                    input.settlement === "queued" ? input.jobRunId : input.operation,
                targetType:
                    input.settlement === "queued" ? "job-run" : "docker-operation",
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
