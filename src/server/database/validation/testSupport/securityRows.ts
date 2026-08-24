import { addDays, addMilliseconds, addMinutes, parseISO } from "date-fns";

import { pendingLoginLifetimeMs } from "../../../shared/pendingLoginPolicy.ts";
import { testDashboardPasswordHash } from "../../../test/support/securityPassword.ts";

export const securityCreatedAt = parseISO("2026-08-05T01:00:00.000Z");
export const securityUpdatedAt = addMinutes(securityCreatedAt, 1);
export const securityExpiresAt = addDays(securityCreatedAt, 30);

export const securityUserId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
export const automationCredentialId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";
export const auditEventId = "019fc968-1a9b-7772-af1b-d5b863b0e7b4";
export const totpFactorId = "019fc968-1a9b-7773-bf1b-d5b863b0e7b4";
export const recoveryCodeId = "019fc968-1a9b-7774-8f1b-d5b863b0e7b4";
export const sessionSelector = "a".repeat(32);
export const pendingLoginSelector = "c".repeat(32);
export const recoveryCodeSelector = "d".repeat(32);
export const tokenValidatorHash = "b".repeat(64);
export const automationPrincipalId = "openclaw-task-tracking";

export const validUserInsert = Object.freeze({
    createdAt: securityCreatedAt,
    disabledAt: null,
    id: securityUserId,
    mfaEnabledAt: null,
    passwordHash: testDashboardPasswordHash,
    updatedAt: securityUpdatedAt,
    username: "raymond",
});

export const validAuthSessionInsert = Object.freeze({
    authenticatedAt: securityCreatedAt,
    authenticationVersion: 1,
    authMethod: "password" as const,
    createdAt: securityCreatedAt,
    expiresAt: securityExpiresAt,
    id: sessionSelector,
    lastSeenAt: securityCreatedAt,
    mfaVerifiedAt: null,
    passwordVerifiedAt: securityCreatedAt,
    userAgent: null,
    userId: securityUserId,
    validatorHash: tokenValidatorHash,
});

export const validAuthPendingLoginInsert = Object.freeze({
    allowsRecovery: true,
    allowsTotp: true,
    authenticationVersion: 1,
    createdAt: securityCreatedAt,
    expiresAt: addMilliseconds(securityCreatedAt, pendingLoginLifetimeMs),
    id: pendingLoginSelector,
    passwordVerifiedAt: securityCreatedAt,
    replacedSessionId: sessionSelector,
    userAgent: "Mira test browser",
    userId: securityUserId,
    validatorHash: "c".repeat(64),
});

export const validUserTotpFactorInsert = Object.freeze({
    confirmedAt: null,
    createdAt: securityCreatedAt,
    encryptedSecret: `v1.${"A".repeat(16)}.${"B".repeat(64)}`,
    enrollmentExpiresAt: addMinutes(securityCreatedAt, 5),
    id: totpFactorId,
    label: "Primary authenticator",
    lastUsedStep: null,
    secretKeyId: "primary_2026-08",
    userId: securityUserId,
});

export const validUserRecoveryCodeInsert = Object.freeze({
    createdAt: securityCreatedAt,
    id: recoveryCodeId,
    selector: recoveryCodeSelector,
    usedAt: null,
    userId: securityUserId,
    validatorHash: testDashboardPasswordHash,
});

export const validAutomationPrincipalInsert = Object.freeze({
    createdAt: securityCreatedAt,
    disabledAt: null,
    id: automationPrincipalId,
    label: "OpenClaw task tracking",
    updatedAt: securityCreatedAt,
});

export const validAutomationCredentialInsert = Object.freeze({
    createdAt: securityCreatedAt,
    expiresAt: null,
    id: automationCredentialId,
    label: "Primary credential",
    lastUsedAt: null,
    prefix: "c".repeat(32),
    principalId: automationPrincipalId,
    revokedAt: null,
    validatorHash: "d".repeat(64),
});

export const validAutomationCapabilityInsert = Object.freeze({
    capability: "notifications:read" as const,
    grantedAt: securityCreatedAt,
    principalId: automationPrincipalId,
});

export const validAuditEventInsert = Object.freeze({
    action: "security.session.authenticate",
    actorId: securityUserId,
    actorKind: "user" as const,
    authenticatorId: sessionSelector,
    id: auditEventId,
    metadataJson: '{"method":"password"}',
    occurredAt: securityCreatedAt,
    outcome: "succeeded" as const,
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    targetId: sessionSelector,
    targetType: "auth-session",
});
