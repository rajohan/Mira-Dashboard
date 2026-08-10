import * as v from "valibot";

import {
    applicationCapabilityListSchema,
    securityRecordIdSchema,
    type ApplicationCapability,
} from "../../../contracts/security.ts";
import {
    securityAuditReasonValues,
    securityAuditSettlementValues,
} from "../../../contracts/securityAudit.ts";
import { auditEventInsertSchema } from "../../database/validation/auditEvents.ts";

type SecurityAuditReason = (typeof securityAuditReasonValues)[number];
const securityAuditReasons: ReadonlySet<string> = new Set(securityAuditReasonValues);
const securityAuditSettlements: ReadonlySet<string> = new Set(
    securityAuditSettlementValues
);

export interface SecurityAuditMetadata {
    readonly addedCapabilities?: readonly ApplicationCapability[];
    readonly reason?: SecurityAuditReason;
    readonly method?: "password" | "recovery" | "totp" | "webauthn";
    readonly pendingMfa?: boolean;
    readonly predecessorCredentialId?: string;
    readonly removedCapabilities?: readonly ApplicationCapability[];
    readonly replacementCredentialId?: string;
    readonly revoked?: boolean;
    readonly revokedCredentials?: number;
    readonly revokedSessions?: number;
    readonly settlement?: (typeof securityAuditSettlementValues)[number];
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
    const sanitized: Record<
        string,
        boolean | number | string | readonly ApplicationCapability[]
    > = {};
    const addedCapabilities = v.safeParse(
        applicationCapabilityListSchema,
        metadata.addedCapabilities
    );
    if (addedCapabilities.success) {
        sanitized.addedCapabilities = addedCapabilities.output;
    }
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
        metadata.method === "password" ||
        metadata.method === "recovery" ||
        metadata.method === "totp" ||
        metadata.method === "webauthn"
    ) {
        sanitized.method = metadata.method;
    }
    if (typeof metadata.pendingMfa === "boolean") {
        sanitized.pendingMfa = metadata.pendingMfa;
    }
    const predecessorCredentialId = v.safeParse(
        securityRecordIdSchema,
        metadata.predecessorCredentialId
    );
    if (predecessorCredentialId.success) {
        sanitized.predecessorCredentialId = predecessorCredentialId.output;
    }
    const removedCapabilities = v.safeParse(
        applicationCapabilityListSchema,
        metadata.removedCapabilities
    );
    if (removedCapabilities.success) {
        sanitized.removedCapabilities = removedCapabilities.output;
    }
    const replacementCredentialId = v.safeParse(
        securityRecordIdSchema,
        metadata.replacementCredentialId
    );
    if (replacementCredentialId.success) {
        sanitized.replacementCredentialId = replacementCredentialId.output;
    }
    if (
        typeof metadata.revokedCredentials === "number" &&
        Number.isSafeInteger(metadata.revokedCredentials) &&
        metadata.revokedCredentials >= 0
    ) {
        sanitized.revokedCredentials = metadata.revokedCredentials;
    }
    if (
        typeof metadata.revokedSessions === "number" &&
        Number.isSafeInteger(metadata.revokedSessions) &&
        metadata.revokedSessions >= 0
    ) {
        sanitized.revokedSessions = metadata.revokedSessions;
    }
    if (
        typeof metadata.settlement === "string" &&
        securityAuditSettlements.has(metadata.settlement)
    ) {
        sanitized.settlement = metadata.settlement;
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
