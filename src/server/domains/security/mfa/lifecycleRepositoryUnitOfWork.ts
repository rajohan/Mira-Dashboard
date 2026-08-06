import { and, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import * as v from "valibot";

import { authChallenges } from "../../../database/schema/authChallenges.ts";
import { authPendingLogins } from "../../../database/schema/authPendingLogins.ts";
import type { AuthenticationRateLimitKind } from "../../../database/schema/authRateLimitBuckets.ts";
import { userRecoveryCodes } from "../../../database/schema/userRecoveryCodes.ts";
import { userTotpFactors } from "../../../database/schema/userTotpFactors.ts";
import {
    userWebAuthnCredentials,
    webAuthnCounterMaximum,
} from "../../../database/schema/userWebAuthnCredentials.ts";
import { authChallengeInsertSchema } from "../../../database/validation/authChallenges.ts";
import { authPendingLoginInsertSchema } from "../../../database/validation/authPendingLogins.ts";
import { userRecoveryCodeInsertSchema } from "../../../database/validation/userRecoveryCodes.ts";
import { userTotpFactorInsertSchema } from "../../../database/validation/userTotpFactors.ts";
import { userWebAuthnCredentialInsertSchema } from "../../../database/validation/userWebAuthnCredentials.ts";
import { opaqueTokenValidatorVersion } from "../../../shared/opaqueToken.ts";
import {
    DrizzleSecurityAuditStore,
    type SecurityAuditWriter,
} from "../securityAuditStore.ts";
import type {
    AuthRateLimitBucket,
    AuthRateLimitBucketInsert,
    BrowserSessionInsert,
    BrowserSessionRecord,
    PruneAuthenticationRateLimitBucketsInput,
    SecurityTransaction,
} from "../securityPersistenceTypes.ts";
import { DrizzleMfaLifecycleReader } from "./lifecycleRepositoryReader.ts";
import {
    parsePendingLogin,
    parseRecoveryCode,
    parseTotpFactor,
    parseWebAuthnChallenge,
    parseWebAuthnCredential,
    requiredMfaRow,
} from "./lifecycleRepositoryRecords.ts";
import {
    pendingLoginAttemptMaximum,
    type AdvanceTotpLastUsedStepInput,
    type AdvanceWebAuthnCredentialInput,
    type ConfirmTotpFactorInput,
    type ConsumePendingLoginInput,
    type ConsumeRecoveryCodeInput,
    type ConsumeWebAuthnChallengeInput,
    type DeleteSessionForRotationInput,
    type IncrementPendingLoginAttemptInput,
    type MfaLifecycleUnitOfWork,
    type MfaPendingLoginInsert,
    type MfaPendingLoginRecord,
    type MfaRecoveryCodeInsert,
    type MfaRecoveryCodeRecord,
    type MfaSessionRecord,
    type MfaTotpFactorInsert,
    type MfaTotpFactorRecord,
    type MfaUserRecord,
    type MfaWebAuthnChallengeInsert,
    type MfaWebAuthnChallengeRecord,
    type MfaWebAuthnCredentialInsert,
    type MfaWebAuthnCredentialRecord,
    type PruneMfaSessionsInput,
    type UpdateUserMfaStateInput,
} from "./lifecycleRepositoryTypes.ts";

export class DrizzleMfaLifecycleUnitOfWork
    extends DrizzleMfaLifecycleReader
    implements MfaLifecycleUnitOfWork
{
    readonly #auditEvents: DrizzleSecurityAuditStore;
    readonly #transaction: SecurityTransaction;

    constructor(transaction: SecurityTransaction) {
        super(transaction);
        this.#transaction = transaction;
        this.#auditEvents = new DrizzleSecurityAuditStore(transaction);
    }

    advanceTotpLastUsedStep(
        input: AdvanceTotpLastUsedStepInput
    ): MfaTotpFactorRecord | undefined {
        if (
            !Number.isSafeInteger(input.expectedLastUsedStep) ||
            input.expectedLastUsedStep < 0 ||
            !Number.isSafeInteger(input.lastUsedStep) ||
            input.lastUsedStep <= input.expectedLastUsedStep
        ) {
            throw new RangeError("TOTP replay transition is invalid");
        }
        const row = this.#transaction
            .update(userTotpFactors)
            .set({ lastUsedStep: input.lastUsedStep })
            .where(
                and(
                    eq(userTotpFactors.id, input.factorId),
                    eq(userTotpFactors.userId, input.userId),
                    eq(userTotpFactors.confirmedAt, input.expectedConfirmedAt),
                    eq(userTotpFactors.encryptedSecret, input.expectedEncryptedSecret),
                    eq(userTotpFactors.secretKeyId, input.expectedSecretKeyId),
                    eq(userTotpFactors.lastUsedStep, input.expectedLastUsedStep),
                    lt(userTotpFactors.lastUsedStep, input.lastUsedStep)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseTotpFactor(row);
    }

    advanceWebAuthnCredential(
        input: AdvanceWebAuthnCredentialInput
    ): MfaWebAuthnCredentialRecord | undefined {
        const usedAtMs = input.usedAt.getTime();
        const expectedLastUsedAtMs = input.expectedLastUsedAt?.getTime();
        const counterAdvanced = input.counter > input.expectedCounter;
        if (
            !Number.isSafeInteger(input.expectedCounter) ||
            input.expectedCounter < 0 ||
            input.expectedCounter > webAuthnCounterMaximum ||
            !Number.isSafeInteger(input.counter) ||
            input.counter < 0 ||
            input.counter > webAuthnCounterMaximum ||
            ((input.counter > 0 || input.expectedCounter > 0) &&
                input.counter <= input.expectedCounter) ||
            input.deviceType !== input.expectedDeviceType ||
            (input.deviceType === "singleDevice" && input.backedUp) ||
            !Number.isFinite(usedAtMs) ||
            (expectedLastUsedAtMs !== undefined &&
                (!Number.isFinite(expectedLastUsedAtMs) ||
                    usedAtMs < expectedLastUsedAtMs ||
                    (!counterAdvanced && usedAtMs === expectedLastUsedAtMs)))
        ) {
            throw new RangeError("WebAuthn credential transition is invalid");
        }
        const expectedLastUsedAt =
            input.expectedLastUsedAt === null
                ? isNull(userWebAuthnCredentials.lastUsedAt)
                : eq(userWebAuthnCredentials.lastUsedAt, input.expectedLastUsedAt);
        let advancesLastUsedAt;
        if (input.expectedLastUsedAt === null) {
            advancesLastUsedAt = lte(userWebAuthnCredentials.createdAt, input.usedAt);
        } else if (counterAdvanced) {
            advancesLastUsedAt = lte(userWebAuthnCredentials.lastUsedAt, input.usedAt);
        } else {
            advancesLastUsedAt = lt(userWebAuthnCredentials.lastUsedAt, input.usedAt);
        }
        const row = this.#transaction
            .update(userWebAuthnCredentials)
            .set({
                backedUp: input.backedUp,
                counter: input.counter,
                deviceType: input.deviceType,
                lastUsedAt: input.usedAt,
            })
            .where(
                and(
                    eq(userWebAuthnCredentials.id, input.id),
                    eq(userWebAuthnCredentials.userId, input.userId),
                    eq(userWebAuthnCredentials.credentialId, input.credentialId),
                    eq(userWebAuthnCredentials.counter, input.expectedCounter),
                    eq(userWebAuthnCredentials.createdAt, input.expectedCreatedAt),
                    eq(userWebAuthnCredentials.deviceType, input.expectedDeviceType),
                    eq(userWebAuthnCredentials.backedUp, input.expectedBackedUp),
                    eq(userWebAuthnCredentials.publicKey, input.expectedPublicKey),
                    eq(userWebAuthnCredentials.rpId, input.expectedRpId),
                    expectedLastUsedAt,
                    advancesLastUsedAt
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseWebAuthnCredential(row);
    }

    confirmTotpFactor(input: ConfirmTotpFactorInput): MfaTotpFactorRecord | undefined {
        if (!Number.isSafeInteger(input.lastUsedStep) || input.lastUsedStep < 0) {
            throw new RangeError("TOTP confirmation step is invalid");
        }
        const row = this.#transaction
            .update(userTotpFactors)
            .set({
                confirmedAt: input.confirmedAt,
                lastUsedStep: input.lastUsedStep,
            })
            .where(
                and(
                    eq(userTotpFactors.id, input.factorId),
                    eq(userTotpFactors.userId, input.userId),
                    eq(userTotpFactors.createdAt, input.expectedCreatedAt),
                    eq(userTotpFactors.encryptedSecret, input.expectedEncryptedSecret),
                    eq(
                        userTotpFactors.enrollmentExpiresAt,
                        input.expectedEnrollmentExpiresAt
                    ),
                    eq(userTotpFactors.secretKeyId, input.expectedSecretKeyId),
                    isNull(userTotpFactors.confirmedAt),
                    isNull(userTotpFactors.lastUsedStep),
                    lte(userTotpFactors.createdAt, input.confirmedAt),
                    gt(userTotpFactors.enrollmentExpiresAt, input.confirmedAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseTotpFactor(row);
    }

    consumePendingLogin(
        input: ConsumePendingLoginInput
    ): MfaPendingLoginRecord | undefined {
        let methodAllowed;
        switch (input.method) {
            case "recovery": {
                methodAllowed = eq(authPendingLogins.allowsRecovery, true);
                break;
            }
            case "totp": {
                methodAllowed = eq(authPendingLogins.allowsTotp, true);
                break;
            }
            case "webauthn": {
                methodAllowed = eq(authPendingLogins.allowsWebAuthn, true);
                break;
            }
        }
        const row = this.#transaction
            .delete(authPendingLogins)
            .where(
                and(
                    eq(authPendingLogins.id, input.id),
                    eq(authPendingLogins.userId, input.userId),
                    eq(
                        authPendingLogins.authenticationVersion,
                        input.authenticationVersion
                    ),
                    eq(authPendingLogins.validatorHash, input.validatorHash),
                    eq(authPendingLogins.validatorVersion, opaqueTokenValidatorVersion),
                    methodAllowed,
                    lte(authPendingLogins.createdAt, input.checkedAt),
                    gt(authPendingLogins.expiresAt, input.checkedAt),
                    lt(authPendingLogins.attemptCount, pendingLoginAttemptMaximum)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parsePendingLogin(row);
    }

    consumeRecoveryCode(
        input: ConsumeRecoveryCodeInput
    ): MfaRecoveryCodeRecord | undefined {
        const row = this.#transaction
            .update(userRecoveryCodes)
            .set({ usedAt: input.usedAt })
            .where(
                and(
                    eq(userRecoveryCodes.id, input.codeId),
                    eq(userRecoveryCodes.userId, input.userId),
                    eq(userRecoveryCodes.selector, input.selector),
                    eq(userRecoveryCodes.validatorHash, input.expectedValidatorHash),
                    eq(userRecoveryCodes.createdAt, input.expectedCreatedAt),
                    isNull(userRecoveryCodes.usedAt),
                    lte(userRecoveryCodes.createdAt, input.usedAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseRecoveryCode(row);
    }

    consumeWebAuthnChallenge(
        input: ConsumeWebAuthnChallengeInput
    ): MfaWebAuthnChallengeRecord | undefined {
        const pendingLoginBinding =
            input.pendingLoginId === null
                ? isNull(authChallenges.pendingLoginId)
                : eq(authChallenges.pendingLoginId, input.pendingLoginId);
        const sessionBinding =
            input.sessionId === null
                ? isNull(authChallenges.sessionId)
                : eq(authChallenges.sessionId, input.sessionId);
        const row = this.#transaction
            .delete(authChallenges)
            .where(
                and(
                    eq(authChallenges.id, input.id),
                    eq(authChallenges.authenticationVersion, input.authenticationVersion),
                    eq(authChallenges.challenge, input.challenge),
                    eq(authChallenges.configFingerprint, input.configFingerprint),
                    eq(authChallenges.createdAt, input.createdAt),
                    eq(authChallenges.expiresAt, input.expiresAt),
                    eq(authChallenges.purpose, input.purpose),
                    pendingLoginBinding,
                    sessionBinding,
                    lte(authChallenges.createdAt, input.checkedAt),
                    gt(authChallenges.expiresAt, input.checkedAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseWebAuthnChallenge(row);
    }

    deleteOtherSessions(userId: string, retainedSessionId: string): number {
        return this.sessions.deleteOtherSessions(userId, retainedSessionId);
    }

    deletePendingLogin(
        userId: string,
        pendingLoginId: string
    ): MfaPendingLoginRecord | undefined {
        const row = this.#transaction
            .delete(authPendingLogins)
            .where(
                and(
                    eq(authPendingLogins.id, pendingLoginId),
                    eq(authPendingLogins.userId, userId)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parsePendingLogin(row);
    }

    deletePendingLoginsForUser(userId: string): number {
        return this.#transaction
            .delete(authPendingLogins)
            .where(eq(authPendingLogins.userId, userId))
            .run().changes;
    }

    deletePendingTotpFactorsForUser(userId: string): number {
        return this.#transaction
            .delete(userTotpFactors)
            .where(
                and(
                    eq(userTotpFactors.userId, userId),
                    isNull(userTotpFactors.confirmedAt)
                )
            )
            .run().changes;
    }

    deleteRateLimitBucket(bucketKey: string): void {
        this.rateLimits.deleteRateLimitBucket(bucketKey);
    }

    deleteRateLimitBuckets(kind: AuthenticationRateLimitKind): number {
        return this.rateLimits.deleteRateLimitBuckets(kind);
    }

    deleteRecoveryCodesForUser(userId: string): number {
        return this.#transaction
            .delete(userRecoveryCodes)
            .where(eq(userRecoveryCodes.userId, userId))
            .run().changes;
    }

    deleteSession(userId: string, sessionId: string): MfaSessionRecord | undefined {
        return this.sessions.deleteSession(userId, sessionId);
    }

    deleteSessionForRotation(
        input: DeleteSessionForRotationInput
    ): MfaSessionRecord | undefined {
        return this.sessions.deleteSessionForRotation(input);
    }

    deleteTotpFactor(userId: string, factorId: string): MfaTotpFactorRecord | undefined {
        const row = this.#transaction
            .delete(userTotpFactors)
            .where(
                and(eq(userTotpFactors.id, factorId), eq(userTotpFactors.userId, userId))
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseTotpFactor(row);
    }

    deleteTotpFactorsForUser(userId: string): number {
        return this.#transaction
            .delete(userTotpFactors)
            .where(eq(userTotpFactors.userId, userId))
            .run().changes;
    }

    deleteWebAuthnCredential(
        userId: string,
        id: string
    ): MfaWebAuthnCredentialRecord | undefined {
        const row = this.#transaction
            .delete(userWebAuthnCredentials)
            .where(
                and(
                    eq(userWebAuthnCredentials.id, id),
                    eq(userWebAuthnCredentials.userId, userId)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseWebAuthnCredential(row);
    }

    deleteWebAuthnCredentialsForUser(userId: string): number {
        return this.#transaction
            .delete(userWebAuthnCredentials)
            .where(eq(userWebAuthnCredentials.userId, userId))
            .run().changes;
    }

    incrementPendingLoginAttempt(
        input: IncrementPendingLoginAttemptInput
    ): MfaPendingLoginRecord | undefined {
        const row = this.#transaction
            .update(authPendingLogins)
            .set({
                attemptCount: sql`${authPendingLogins.attemptCount} + 1`,
            })
            .where(
                and(
                    eq(authPendingLogins.id, input.id),
                    eq(authPendingLogins.userId, input.userId),
                    eq(
                        authPendingLogins.authenticationVersion,
                        input.authenticationVersion
                    ),
                    eq(authPendingLogins.validatorHash, input.validatorHash),
                    eq(authPendingLogins.validatorVersion, opaqueTokenValidatorVersion),
                    lte(authPendingLogins.createdAt, input.failedAt),
                    gt(authPendingLogins.expiresAt, input.failedAt),
                    lt(authPendingLogins.attemptCount, pendingLoginAttemptMaximum)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parsePendingLogin(row);
    }

    insertAuditEvent(
        event: Parameters<SecurityAuditWriter["insertAuditEvent"]>[0]
    ): void {
        this.#auditEvents.insertAuditEvent(event);
    }

    insertPendingLogin(input: MfaPendingLoginInsert): MfaPendingLoginRecord {
        const row = this.#transaction
            .insert(authPendingLogins)
            .values(v.parse(authPendingLoginInsertSchema, input))
            .returning()
            .get();
        return parsePendingLogin(requiredMfaRow(row, "pending-login insert"));
    }

    insertRecoveryCode(input: MfaRecoveryCodeInsert): MfaRecoveryCodeRecord {
        const row = this.#transaction
            .insert(userRecoveryCodes)
            .values(v.parse(userRecoveryCodeInsertSchema, input))
            .returning()
            .get();
        return parseRecoveryCode(requiredMfaRow(row, "recovery-code insert"));
    }

    insertSession(input: BrowserSessionInsert): BrowserSessionRecord {
        return this.sessions.insertSession(input);
    }

    insertTotpFactor(input: MfaTotpFactorInsert): MfaTotpFactorRecord {
        const row = this.#transaction
            .insert(userTotpFactors)
            .values(v.parse(userTotpFactorInsertSchema, input))
            .returning()
            .get();
        return parseTotpFactor(requiredMfaRow(row, "TOTP-factor insert"));
    }

    insertWebAuthnCredential(
        input: MfaWebAuthnCredentialInsert
    ): MfaWebAuthnCredentialRecord {
        const row = this.#transaction
            .insert(userWebAuthnCredentials)
            .values(v.parse(userWebAuthnCredentialInsertSchema, input))
            .returning()
            .get();
        return parseWebAuthnCredential(requiredMfaRow(row, "WebAuthn credential insert"));
    }

    insertWebAuthnCredentialIfAvailable(
        input: MfaWebAuthnCredentialInsert
    ): MfaWebAuthnCredentialRecord | undefined {
        const row = this.#transaction
            .insert(userWebAuthnCredentials)
            .values(v.parse(userWebAuthnCredentialInsertSchema, input))
            .onConflictDoNothing({ target: userWebAuthnCredentials.credentialId })
            .returning()
            .get();
        return row === undefined ? undefined : parseWebAuthnCredential(row);
    }

    pruneRateLimitBuckets(input: PruneAuthenticationRateLimitBucketsInput): number {
        if (!Number.isSafeInteger(input.maximumBuckets) || input.maximumBuckets < 1) {
            throw new RangeError("Maximum MFA rate-limit bucket count is invalid");
        }
        return this.rateLimits.pruneRateLimitBuckets(input);
    }

    pruneSessions(input: PruneMfaSessionsInput): number {
        if (!Number.isSafeInteger(input.maximumSessions) || input.maximumSessions < 1) {
            throw new RangeError("Maximum MFA session count is invalid");
        }
        return this.sessions.pruneSessions(input);
    }

    replaceWebAuthnChallenge(
        input: MfaWebAuthnChallengeInsert
    ): MfaWebAuthnChallengeRecord {
        const parsed = v.parse(authChallengeInsertSchema, input);
        let binding;
        if (parsed.pendingLoginId === null) {
            if (parsed.sessionId === null) {
                throw new Error("WebAuthn challenge binding is inconsistent");
            }
            binding = eq(authChallenges.sessionId, parsed.sessionId);
        } else {
            binding = eq(authChallenges.pendingLoginId, parsed.pendingLoginId);
        }
        this.#transaction
            .delete(authChallenges)
            .where(and(binding, eq(authChallenges.purpose, parsed.purpose)))
            .run();
        const row = this.#transaction
            .insert(authChallenges)
            .values(parsed)
            .returning()
            .get();
        return parseWebAuthnChallenge(requiredMfaRow(row, "WebAuthn challenge replace"));
    }

    updateUserMfaState(input: UpdateUserMfaStateInput): MfaUserRecord | undefined {
        return this.users.updateMfaState(input);
    }

    upsertRateLimitBucket(input: AuthRateLimitBucketInsert): AuthRateLimitBucket {
        return this.rateLimits.upsertRateLimitBucket(input);
    }
}
