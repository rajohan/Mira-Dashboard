import { and, eq, type SQL } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    applicationCapabilities,
    applicationCapabilitySchema,
    automationPrincipalIdSchema,
    securityRecordIdSchema,
    opaqueSelectorSchema,
    type ApplicationCapability,
} from "../../../contracts/security.ts";
import { nonnegativeDateAction } from "../../../shared/dateTime.ts";
import {
    hasUniqueArrayItems,
    lowercaseSha256Schema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { authSessions } from "../../database/schema/authSessions.ts";
import { automationCredentials } from "../../database/schema/automationCredentials.ts";
import { automationPrincipalCapabilities } from "../../database/schema/automationPrincipalCapabilities.ts";
import { automationPrincipals } from "../../database/schema/automationPrincipals.ts";
import { users } from "../../database/schema/users.ts";
import { opaqueTokenValidatorVersion } from "../../shared/opaqueToken.ts";

const persistedDateSchema = v.pipe(v.date(), nonnegativeDateAction());
const persistedOptionalDateSchema = v.nullable(persistedDateSchema);
const validatorVersionSchema = v.pipe(
    positiveSafeIntegerSchema(),
    v.value(opaqueTokenValidatorVersion)
);

const sessionAuthenticationRecordSchema = v.strictObject({
    authenticationVersion: positiveSafeIntegerSchema(),
    createdAt: persistedDateSchema,
    expiresAt: persistedDateSchema,
    id: opaqueSelectorSchema,
    lastSeenAt: persistedDateSchema,
    mfaVerifiedAt: persistedOptionalDateSchema,
    userAuthenticationVersion: positiveSafeIntegerSchema(),
    userDisabledAt: persistedOptionalDateSchema,
    userId: securityRecordIdSchema,
    userMfaEnabledAt: persistedOptionalDateSchema,
    validatorHash: lowercaseSha256Schema(),
    validatorVersion: validatorVersionSchema,
});

const automationAuthenticationRowSchema = v.strictObject({
    capability: v.nullable(applicationCapabilitySchema),
    credentialCreatedAt: persistedDateSchema,
    credentialExpiresAt: persistedOptionalDateSchema,
    credentialId: securityRecordIdSchema,
    credentialPrefix: opaqueSelectorSchema,
    credentialRevokedAt: persistedOptionalDateSchema,
    principalAuthorizationVersion: positiveSafeIntegerSchema(),
    principalCreatedAt: persistedDateSchema,
    principalDisabledAt: persistedOptionalDateSchema,
    principalId: automationPrincipalIdSchema,
    principalUpdatedAt: persistedDateSchema,
    validatorHash: lowercaseSha256Schema(),
    validatorVersion: validatorVersionSchema,
});

const capabilitySetSchema = v.pipe(
    v.array(applicationCapabilitySchema),
    v.maxLength(applicationCapabilities.length),
    v.check(
        hasUniqueArrayItems<ApplicationCapability>,
        "Automation capabilities must be unique"
    ),
    v.transform((capabilities) => Object.freeze(capabilities.toSorted()))
);

const automationAuthenticationRecordSchema = v.strictObject({
    capabilities: capabilitySetSchema,
    credentialCreatedAt: persistedDateSchema,
    credentialExpiresAt: persistedOptionalDateSchema,
    credentialId: securityRecordIdSchema,
    credentialPrefix: opaqueSelectorSchema,
    credentialRevokedAt: persistedOptionalDateSchema,
    principalAuthorizationVersion: positiveSafeIntegerSchema(),
    principalCreatedAt: persistedDateSchema,
    principalDisabledAt: persistedOptionalDateSchema,
    principalId: automationPrincipalIdSchema,
    principalUpdatedAt: persistedDateSchema,
    validatorHash: lowercaseSha256Schema(),
    validatorVersion: validatorVersionSchema,
});

export type SessionAuthenticationRecord = v.InferOutput<
    typeof sessionAuthenticationRecordSchema
>;
export type AutomationAuthenticationRecord = v.InferOutput<
    typeof automationAuthenticationRecordSchema
>;

/** Read-only security queries used by initial authentication and lease revalidation. */
export interface RequestAuthenticationRepository {
    findAutomationByCredentialId(
        credentialId: string
    ): AutomationAuthenticationRecord | undefined;
    findAutomationByPrefix(prefix: string): AutomationAuthenticationRecord | undefined;
    findSessionById(sessionId: string): SessionAuthenticationRecord | undefined;
}

function rowsShareAutomationIdentity(
    rows: readonly v.InferOutput<typeof automationAuthenticationRowSchema>[]
): boolean {
    const first = rows[0];
    return (
        first !== undefined &&
        rows.every(
            (row) =>
                row.credentialCreatedAt.getTime() ===
                    first.credentialCreatedAt.getTime() &&
                row.credentialExpiresAt?.getTime() ===
                    first.credentialExpiresAt?.getTime() &&
                row.credentialId === first.credentialId &&
                row.credentialPrefix === first.credentialPrefix &&
                row.credentialRevokedAt?.getTime() ===
                    first.credentialRevokedAt?.getTime() &&
                row.principalAuthorizationVersion ===
                    first.principalAuthorizationVersion &&
                row.principalCreatedAt.getTime() === first.principalCreatedAt.getTime() &&
                row.principalDisabledAt?.getTime() ===
                    first.principalDisabledAt?.getTime() &&
                row.principalId === first.principalId &&
                row.principalUpdatedAt.getTime() === first.principalUpdatedAt.getTime() &&
                row.validatorHash === first.validatorHash &&
                row.validatorVersion === first.validatorVersion
        )
    );
}

function readAutomationRecord(
    database: SQLiteBunDatabase,
    where: SQL<unknown>
): AutomationAuthenticationRecord | undefined {
    const rows = database
        .select({
            capability: automationPrincipalCapabilities.capability,
            credentialCreatedAt: automationCredentials.createdAt,
            credentialExpiresAt: automationCredentials.expiresAt,
            credentialId: automationCredentials.id,
            credentialPrefix: automationCredentials.prefix,
            credentialRevokedAt: automationCredentials.revokedAt,
            principalAuthorizationVersion: automationPrincipals.authorizationVersion,
            principalCreatedAt: automationPrincipals.createdAt,
            principalDisabledAt: automationPrincipals.disabledAt,
            principalId: automationPrincipals.id,
            principalUpdatedAt: automationPrincipals.updatedAt,
            validatorHash: automationCredentials.validatorHash,
            validatorVersion: automationCredentials.validatorVersion,
        })
        .from(automationCredentials)
        .innerJoin(
            automationPrincipals,
            eq(automationPrincipals.id, automationCredentials.principalId)
        )
        .leftJoin(
            automationPrincipalCapabilities,
            eq(automationPrincipalCapabilities.principalId, automationPrincipals.id)
        )
        .where(
            and(
                where,
                eq(automationCredentials.validatorVersion, opaqueTokenValidatorVersion)
            )
        )
        .limit(applicationCapabilities.length + 1)
        .all()
        .map((row) => v.parse(automationAuthenticationRowSchema, row));

    if (rows.length === 0) return undefined;
    if (!rowsShareAutomationIdentity(rows)) {
        throw new Error("Automation authentication rows are inconsistent");
    }
    const first = rows[0];
    if (first === undefined) return undefined;

    return v.parse(automationAuthenticationRecordSchema, {
        capabilities: rows.flatMap((row) =>
            row.capability === null ? [] : [row.capability]
        ),
        credentialCreatedAt: first.credentialCreatedAt,
        credentialExpiresAt: first.credentialExpiresAt,
        credentialId: first.credentialId,
        credentialPrefix: first.credentialPrefix,
        credentialRevokedAt: first.credentialRevokedAt,
        principalAuthorizationVersion: first.principalAuthorizationVersion,
        principalCreatedAt: first.principalCreatedAt,
        principalDisabledAt: first.principalDisabledAt,
        principalId: first.principalId,
        principalUpdatedAt: first.principalUpdatedAt,
        validatorHash: first.validatorHash,
        validatorVersion: first.validatorVersion,
    });
}

/**
 * Creates the raw-read-validation boundary for request authentication.
 * @param database Drizzle client owned by the process composition root.
 * @returns Read-only authentication repository without credential caching.
 */
export function createRequestAuthenticationRepository(
    database: SQLiteBunDatabase
): RequestAuthenticationRepository {
    return Object.freeze({
        findAutomationByCredentialId(credentialId: string) {
            return readAutomationRecord(
                database,
                eq(automationCredentials.id, credentialId)
            );
        },
        findAutomationByPrefix(prefix: string) {
            return readAutomationRecord(
                database,
                eq(automationCredentials.prefix, prefix)
            );
        },
        findSessionById(sessionId: string) {
            const row = database
                .select({
                    authenticationVersion: authSessions.authenticationVersion,
                    createdAt: authSessions.createdAt,
                    expiresAt: authSessions.expiresAt,
                    id: authSessions.id,
                    lastSeenAt: authSessions.lastSeenAt,
                    mfaVerifiedAt: authSessions.mfaVerifiedAt,
                    userAuthenticationVersion: users.authenticationVersion,
                    userDisabledAt: users.disabledAt,
                    userId: users.id,
                    userMfaEnabledAt: users.mfaEnabledAt,
                    validatorHash: authSessions.validatorHash,
                    validatorVersion: authSessions.validatorVersion,
                })
                .from(authSessions)
                .innerJoin(users, eq(users.id, authSessions.userId))
                .where(
                    and(
                        eq(authSessions.id, sessionId),
                        eq(authSessions.validatorVersion, opaqueTokenValidatorVersion)
                    )
                )
                .get();
            return row === undefined
                ? undefined
                : v.parse(sessionAuthenticationRecordSchema, row);
        },
    });
}
