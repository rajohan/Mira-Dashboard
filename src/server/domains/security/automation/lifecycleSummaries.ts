import { getTime } from "date-fns";
import * as v from "valibot";

import {
    automationCredentialSummarySchema,
    automationPrincipalSummarySchema,
    type AutomationCredentialSummary,
    type AutomationPrincipalSummary,
} from "../../../../contracts/automationSecurity.ts";
import type {
    AutomationCapabilityRecord,
    AutomationCredentialRecord,
    AutomationLifecycleReader,
    AutomationPrincipalRecord,
} from "./lifecycleRepositoryTypes.ts";

export class AutomationLifecycleStateChangedError extends Error {}

/**
 * Rejects capability grants outside the principal and transaction clock window.
 * @param grants Persisted grants owned by the principal.
 * @param principal Principal creation/update bounds.
 * @param checkedAt Transaction-owned policy time.
 */
export function assertGrantsWithinPrincipalWindow(
    grants: readonly AutomationCapabilityRecord[],
    principal: AutomationPrincipalRecord,
    checkedAt: Date
): void {
    if (
        grants.some(
            ({ grantedAt }) =>
                getTime(grantedAt) < getTime(principal.createdAt) ||
                getTime(grantedAt) > getTime(principal.updatedAt) ||
                getTime(grantedAt) > getTime(checkedAt)
        )
    ) {
        throw new AutomationLifecycleStateChangedError();
    }
}

/**
 * Rejects credential history that is not yet observable at the transaction clock.
 * `listCredentials` orders by creation time and ID descending, so limit one is newest.
 * @param reader Consistent lifecycle reader for the current transaction.
 * @param principalId Principal whose newest credential anchors the history check.
 * @param checkedAt Transaction-owned policy time.
 */
export function assertNoFutureCredentialHistory(
    reader: AutomationLifecycleReader,
    principalId: string,
    checkedAt: Date
): void {
    const newestCredential = reader.listCredentials({ limit: 1, principalId })[0];
    if (
        newestCredential !== undefined &&
        getTime(newestCredential.createdAt) > getTime(checkedAt)
    ) {
        throw new AutomationLifecycleStateChangedError();
    }
}

export function credentialSummary(
    credential: AutomationCredentialRecord,
    checkedAt: Date
): AutomationCredentialSummary {
    const checkedAtMs = getTime(checkedAt);
    if (
        getTime(credential.createdAt) > checkedAtMs ||
        (credential.revokedAt !== null && getTime(credential.revokedAt) > checkedAtMs)
    ) {
        throw new AutomationLifecycleStateChangedError();
    }
    return v.parse(automationCredentialSummarySchema, {
        createdAtMs: getTime(credential.createdAt),
        ...(credential.expiresAt === null
            ? {}
            : { expiresAtMs: getTime(credential.expiresAt) }),
        id: credential.id,
        label: credential.label,
        prefix: credential.prefix,
        ...(credential.replacesCredentialId === null
            ? {}
            : { replacesCredentialId: credential.replacesCredentialId }),
        ...(credential.revokedAt === null
            ? {}
            : { revokedAtMs: getTime(credential.revokedAt) }),
    });
}

function validatePrincipalTimes(
    principal: AutomationPrincipalRecord,
    checkedAt: Date
): void {
    const checkedAtMs = getTime(checkedAt);
    if (
        getTime(principal.createdAt) > checkedAtMs ||
        getTime(principal.updatedAt) > checkedAtMs ||
        (principal.disabledAt !== null && getTime(principal.disabledAt) > checkedAtMs)
    ) {
        throw new AutomationLifecycleStateChangedError();
    }
}

export function principalSummary(
    reader: AutomationLifecycleReader,
    principal: AutomationPrincipalRecord,
    checkedAt: Date
): AutomationPrincipalSummary {
    validatePrincipalTimes(principal, checkedAt);
    if (principal.disabledAt === null) {
        assertNoFutureCredentialHistory(reader, principal.id, checkedAt);
    }
    const grants = reader.listCapabilities(principal.id);
    assertGrantsWithinPrincipalWindow(grants, principal, checkedAt);
    // Disablement is terminal, so credentials remain unusable even when an expired
    // row does not receive a redundant physical revocation timestamp.
    const activeCredentialCount =
        principal.disabledAt === null
            ? reader.countActiveCredentials(principal.id, checkedAt)
            : 0;
    return v.parse(automationPrincipalSummarySchema, {
        activeCredentialCount,
        authorizationVersion: principal.authorizationVersion,
        capabilities: grants.map(({ capability }) => capability),
        createdAtMs: getTime(principal.createdAt),
        disabled: principal.disabledAt !== null,
        ...(principal.disabledAt === null
            ? {}
            : { disabledAtMs: getTime(principal.disabledAt) }),
        id: principal.id,
        label: principal.label,
        totalCredentialCount: reader.countCredentials(principal.id),
        updatedAtMs: getTime(principal.updatedAt),
    });
}
