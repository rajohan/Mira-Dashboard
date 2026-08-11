import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { createSecurityAuditEvent, type SecurityAuditActor } from "../security/audit.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";

export const openClawSettingsAuditOperations = [
    "set-skill-enabled",
    "update-configuration",
] as const;

export type OpenClawSettingsAuditOperation =
    (typeof openClawSettingsAuditOperations)[number];
export type OpenClawSettingsAuditSettlement =
    | "attempted"
    | "failed"
    | "partial"
    | "succeeded";

export interface OpenClawSettingsAuditContext {
    readonly actor: SecurityAuditActor;
    readonly requestId: string;
}

export interface OpenClawSettingsOperationAuditInput extends OpenClawSettingsAuditContext {
    readonly operation: OpenClawSettingsAuditOperation;
    readonly settlement: OpenClawSettingsAuditSettlement;
    /** Raw bounded target used only as input to a domain-separated digest. */
    readonly targetId: string;
}

export interface OpenClawSettingsOperationAuditWriter {
    readonly record: (input: OpenClawSettingsOperationAuditInput) => Promise<void>;
}

export interface OpenClawSettingsAuditSettlementFailure {
    readonly operation: OpenClawSettingsAuditOperation;
    readonly settlement: Exclude<OpenClawSettingsAuditSettlement, "attempted">;
    readonly targetFingerprint: string;
}

export interface SqliteOpenClawSettingsOperationAuditWriterOptions {
    readonly clock?: () => Date;
    readonly database: SQLiteBunDatabase;
    readonly generateId?: () => string;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

/**
 * Returns a stable non-reversible identifier without persisting config values or skill keys.
 * @param targetId Bounded code-owned target identity.
 * @returns A domain-separated SHA-256 fingerprint.
 */
export function openClawSettingsAuditTargetFingerprint(targetId: string): string {
    return `sha256:${sha256Hex(
        `mira-dashboard:openclaw-settings-target:v1\0${targetId}`
    )}`;
}

function auditOutcome(
    settlement: OpenClawSettingsAuditSettlement
): "attempted" | "failed" | "succeeded" {
    if (settlement === "attempted") return "attempted";
    if (settlement === "succeeded") return "succeeded";
    return "failed";
}

/**
 * Creates a fail-closed admitted append boundary for sanitized Settings controls.
 * @returns An audit writer backed by the admitted SQLite transaction boundary.
 */
export function createSqliteOpenClawSettingsOperationAuditWriter({
    clock = () => new Date(),
    database,
    generateId = () => Bun.randomUUIDv7(),
    writeAdmission,
}: SqliteOpenClawSettingsOperationAuditWriterOptions): OpenClawSettingsOperationAuditWriter {
    return Object.freeze({
        record(input: OpenClawSettingsOperationAuditInput) {
            const event = createSecurityAuditEvent({
                action: `openclaw.settings.${input.operation}`,
                actor: input.actor,
                id: generateId(),
                metadata: { settlement: input.settlement },
                occurredAt: clock(),
                outcome: auditOutcome(input.settlement),
                requestId: input.requestId,
                targetId: openClawSettingsAuditTargetFingerprint(input.targetId),
                targetType: "openclaw-settings-control",
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
