import * as v from "valibot";

import { auditEventInsertSchema } from "../../database/validation/auditEvents.ts";

const securityAuditReasons = new Set([
    "gateway_unavailable",
    "identity_changed",
    "invalid_credentials",
    "invalid_current_password",
    "invalid_gateway",
]);

export interface SecurityAuditMetadata {
    readonly reason?:
        | "gateway_unavailable"
        | "identity_changed"
        | "invalid_credentials"
        | "invalid_current_password"
        | "invalid_gateway";
    readonly revoked?: boolean;
    readonly revokedSessions?: number;
}

export interface SecurityAuditActor {
    readonly authenticatorId: string | null;
    readonly id: string;
    readonly kind: "anonymous" | "automation" | "system" | "user";
}

export interface SecurityAuditEventInput {
    readonly action: string;
    readonly actor: SecurityAuditActor;
    readonly id: string;
    readonly metadata?: SecurityAuditMetadata;
    readonly occurredAt: Date;
    readonly outcome:
        | "accepted"
        | "attempted"
        | "cancelled"
        | "denied"
        | "failed"
        | "succeeded";
    readonly requestId?: string;
    readonly targetId: string;
    readonly targetType: string;
}

/**
 * Serializes only explicitly classified, non-secret audit metadata fields.
 * @param metadata Candidate metadata from a controlled security event.
 * @returns Canonical JSON containing only allowlisted scalar fields.
 */
export function serializeRedactedAuditMetadata(
    metadata: SecurityAuditMetadata | Readonly<Record<string, unknown>> = {}
): string {
    const sanitized: Record<string, boolean | number | string> = {};
    if (
        typeof metadata.reason === "string" &&
        securityAuditReasons.has(metadata.reason)
    ) {
        sanitized.reason = metadata.reason;
    }
    if (typeof metadata.revoked === "boolean") {
        sanitized.revoked = metadata.revoked;
    }
    if (
        typeof metadata.revokedSessions === "number" &&
        Number.isSafeInteger(metadata.revokedSessions) &&
        metadata.revokedSessions >= 0
    ) {
        sanitized.revokedSessions = metadata.revokedSessions;
    }
    return JSON.stringify(sanitized);
}

/**
 * Builds and validates one immutable redacted security audit row.
 * @param input Classified audit fields supplied by the security service.
 * @returns A persistence-safe audit event.
 */
export function createSecurityAuditEvent(input: SecurityAuditEventInput) {
    return v.parse(auditEventInsertSchema, {
        action: input.action,
        actorId: input.actor.id,
        actorKind: input.actor.kind,
        authenticatorId: input.actor.authenticatorId,
        id: input.id,
        metadataJson: serializeRedactedAuditMetadata(input.metadata),
        occurredAt: input.occurredAt,
        outcome: input.outcome,
        requestId: input.requestId ?? null,
        targetId: input.targetId,
        targetType: input.targetType,
    });
}

export type SecurityAuditEvent = ReturnType<typeof createSecurityAuditEvent>;
