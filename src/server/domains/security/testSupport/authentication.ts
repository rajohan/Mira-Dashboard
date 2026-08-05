import { addDays, parseISO } from "date-fns";
import * as v from "valibot";

import { authSessions } from "../../../database/schema/authSessions.ts";
import { automationCredentials } from "../../../database/schema/automationCredentials.ts";
import { automationPrincipalCapabilities } from "../../../database/schema/automationPrincipalCapabilities.ts";
import { automationPrincipals } from "../../../database/schema/automationPrincipals.ts";
import { users } from "../../../database/schema/users.ts";
import { authSessionInsertSchema } from "../../../database/validation/authSessions.ts";
import { automationCredentialInsertSchema } from "../../../database/validation/automationCredentials.ts";
import { automationPrincipalCapabilityInsertSchema } from "../../../database/validation/automationPrincipalCapabilities.ts";
import { automationPrincipalInsertSchema } from "../../../database/validation/automationPrincipals.ts";
import { userInsertSchema } from "../../../database/validation/users.ts";
import { generateOpaqueToken } from "../../../shared/opaqueToken.ts";
import { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../../test/support/securityPassword.ts";
import type { TotpSecretCipher } from "../mfa/totpSecretCipher.ts";
import { createRequestAuthenticationRepository } from "../requestAuthenticationRepository.ts";

export const authenticationTestNow = parseISO("2026-08-05T01:00:00.000Z");
export const authenticationTestUserId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
export const authenticationTestCredentialId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";
export const authenticationTestPrincipalId = "openclaw-task-tracking";

/** Fail-closed cipher used by composition tests that do not exercise TOTP. */
export const testTotpSecretCipher: TotpSecretCipher = Object.freeze({
    activeKeyId: "test-primary",
    decrypt: () => Promise.reject(new Error("Test TOTP secret is unavailable")),
    encrypt: () => Promise.reject(new Error("Test TOTP encryption is unavailable")),
    hasKey: () => false,
});

/**
 * Opens a fresh database containing one session and one automation credential.
 * @param now Timestamp used for the persisted authentication records.
 * @returns Fresh authentication fixture with its repository and generated tokens.
 */
export async function openAuthenticationTestDatabase(now = authenticationTestNow) {
    const database = await openFreshMigratedDatabase();
    const session = generateOpaqueToken("session");
    const automation = generateOpaqueToken("automation");
    const expiresAt = addDays(now, 30);

    try {
        database.orm
            .insert(users)
            .values(
                v.parse(userInsertSchema, {
                    createdAt: now,
                    disabledAt: null,
                    id: authenticationTestUserId,
                    passwordHash: testDashboardPasswordHash,
                    updatedAt: now,
                    username: "raymond",
                })
            )
            .run();
        database.orm
            .insert(authSessions)
            .values(
                v.parse(authSessionInsertSchema, {
                    authenticatedAt: now,
                    authenticationVersion: 1,
                    authMethod: "password",
                    createdAt: now,
                    expiresAt,
                    id: session.prefix,
                    lastSeenAt: now,
                    mfaVerifiedAt: null,
                    passwordVerifiedAt: now,
                    userAgent: null,
                    userId: authenticationTestUserId,
                    validatorHash: session.validatorHash,
                })
            )
            .run();
        database.orm
            .insert(automationPrincipals)
            .values(
                v.parse(automationPrincipalInsertSchema, {
                    createdAt: now,
                    disabledAt: null,
                    id: authenticationTestPrincipalId,
                    label: "OpenClaw task tracking",
                    updatedAt: now,
                })
            )
            .run();
        database.orm
            .insert(automationPrincipalCapabilities)
            .values(
                v.parse(automationPrincipalCapabilityInsertSchema, {
                    capability: "reports:read",
                    grantedAt: now,
                    principalId: authenticationTestPrincipalId,
                })
            )
            .run();
        database.orm
            .insert(automationCredentials)
            .values(
                v.parse(automationCredentialInsertSchema, {
                    createdAt: now,
                    expiresAt,
                    id: authenticationTestCredentialId,
                    label: "Primary credential",
                    lastUsedAt: null,
                    prefix: automation.prefix,
                    principalId: authenticationTestPrincipalId,
                    revokedAt: null,
                    validatorHash: automation.validatorHash,
                })
            )
            .run();

        return {
            automation,
            database,
            expiresAt,
            repository: createRequestAuthenticationRepository(database.orm),
            session,
        };
    } catch (error) {
        database.sqlite.close(true);
        throw error;
    }
}
