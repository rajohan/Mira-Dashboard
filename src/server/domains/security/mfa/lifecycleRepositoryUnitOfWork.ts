import { and, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import * as v from "valibot";

import { authPendingLogins } from "../../../database/schema/authPendingLogins.ts";
import type { AuthenticationRateLimitKind } from "../../../database/schema/authRateLimitBuckets.ts";
import { userRecoveryCodes } from "../../../database/schema/userRecoveryCodes.ts";
import { userTotpFactors } from "../../../database/schema/userTotpFactors.ts";
import { authPendingLoginInsertSchema } from "../../../database/validation/authPendingLogins.ts";
import { userRecoveryCodeInsertSchema } from "../../../database/validation/userRecoveryCodes.ts";
import { userTotpFactorInsertSchema } from "../../../database/validation/userTotpFactors.ts";
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
    requiredMfaRow,
} from "./lifecycleRepositoryRecords.ts";
import {
    pendingLoginAttemptMaximum,
    type AdvanceTotpLastUsedStepInput,
    type ConfirmTotpFactorInput,
    type ConsumePendingLoginInput,
    type ConsumeRecoveryCodeInput,
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
        const methodAllowed =
            input.method === "recovery"
                ? eq(authPendingLogins.allowsRecovery, true)
                : eq(authPendingLogins.allowsTotp, true);
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

    updateUserMfaState(input: UpdateUserMfaStateInput): MfaUserRecord | undefined {
        return this.users.updateMfaState(input);
    }

    upsertRateLimitBucket(input: AuthRateLimitBucketInsert): AuthRateLimitBucket {
        return this.rateLimits.upsertRateLimitBucket(input);
    }
}
