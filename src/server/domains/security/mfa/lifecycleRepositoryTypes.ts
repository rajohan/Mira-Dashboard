import * as v from "valibot";

import type { MultiFactorAuthenticationMethod } from "../../../../contracts/security.ts";
import type { AuthenticationRateLimitKind } from "../../../database/schema/authRateLimitBuckets.ts";
import {
    authPendingLoginInsertSchema,
    authPendingLoginSelectSchema,
} from "../../../database/validation/authPendingLogins.ts";
import {
    userRecoveryCodeInsertSchema,
    userRecoveryCodeSelectSchema,
} from "../../../database/validation/userRecoveryCodes.ts";
import {
    userTotpFactorInsertSchema,
    userTotpFactorSelectSchema,
} from "../../../database/validation/userTotpFactors.ts";
import type { SecurityAuditWriter } from "../securityAuditStore.ts";
import type {
    AuthenticationRateLimitReader,
    AuthenticationRateLimitUnitOfWork,
    AuthRateLimitBucket,
    AuthRateLimitBucketInsert,
    BrowserSessionInsert,
    BrowserSessionRecord,
    BrowserSessionWriter,
    DeleteBrowserSessionForRotationInput,
    PruneAuthenticationRateLimitBucketsInput,
    PruneBrowserSessionsInput,
    SecurityUserMfaStateUpdateInput,
    SecurityUserRecord,
    SynchronousResult,
} from "../securityPersistenceTypes.ts";

/** Maximum failed proofs retained by one pending-login token. */
export const pendingLoginAttemptMaximum = 8;

export type MfaPendingLoginRecord = v.InferOutput<typeof authPendingLoginSelectSchema>;
export type MfaPendingLoginInsert = v.InferOutput<typeof authPendingLoginInsertSchema>;
export type MfaTotpFactorRecord = v.InferOutput<typeof userTotpFactorSelectSchema>;
export type MfaTotpFactorInsert = v.InferOutput<typeof userTotpFactorInsertSchema>;
export type MfaRecoveryCodeRecord = v.InferOutput<typeof userRecoveryCodeSelectSchema>;
export type MfaRecoveryCodeInsert = v.InferOutput<typeof userRecoveryCodeInsertSchema>;
export type MfaSessionRecord = BrowserSessionRecord;
export type MfaSessionInsert = BrowserSessionInsert;
export type MfaUserRecord = SecurityUserRecord;
export type MfaRateLimitBucket = AuthRateLimitBucket;
export type MfaRateLimitBucketInsert = AuthRateLimitBucketInsert;

export interface ConsumePendingLoginInput {
    readonly authenticationVersion: number;
    readonly checkedAt: Date;
    readonly id: string;
    readonly method: MultiFactorAuthenticationMethod;
    readonly userId: string;
    readonly validatorHash: string;
}

export interface IncrementPendingLoginAttemptInput {
    readonly authenticationVersion: number;
    readonly failedAt: Date;
    readonly id: string;
    readonly userId: string;
    readonly validatorHash: string;
}

export interface ConfirmTotpFactorInput {
    readonly confirmedAt: Date;
    readonly expectedCreatedAt: Date;
    readonly expectedEncryptedSecret: string;
    readonly expectedEnrollmentExpiresAt: Date;
    readonly expectedSecretKeyId: string;
    readonly factorId: string;
    readonly lastUsedStep: number;
    readonly userId: string;
}

export interface AdvanceTotpLastUsedStepInput {
    readonly expectedConfirmedAt: Date;
    readonly expectedEncryptedSecret: string;
    readonly expectedLastUsedStep: number;
    readonly expectedSecretKeyId: string;
    readonly factorId: string;
    readonly lastUsedStep: number;
    readonly userId: string;
}

export interface ConsumeRecoveryCodeInput {
    readonly codeId: string;
    readonly expectedCreatedAt: Date;
    readonly expectedValidatorHash: string;
    readonly selector: string;
    readonly usedAt: Date;
    readonly userId: string;
}

export type DeleteSessionForRotationInput = DeleteBrowserSessionForRotationInput;
export type UpdateUserMfaStateInput = SecurityUserMfaStateUpdateInput;
export type PruneMfaRateLimitBucketsInput = PruneAuthenticationRateLimitBucketsInput;
export type PruneMfaSessionsInput = PruneBrowserSessionsInput;

/** Consistent read surface used before expensive MFA cryptography. */
export interface MfaLifecycleReader extends AuthenticationRateLimitReader {
    countConfirmedTotpFactors(userId: string): number;
    countTotpFactors(userId: string): number;
    countUnusedRecoveryCodes(userId: string): number;
    findConfirmedTotpFactor(
        userId: string,
        factorId: string
    ): MfaTotpFactorRecord | undefined;
    findPendingLogin(id: string): MfaPendingLoginRecord | undefined;
    findRecoveryCode(userId: string, selector: string): MfaRecoveryCodeRecord | undefined;
    findSession(userId: string, sessionId: string): MfaSessionRecord | undefined;
    findTotpFactor(userId: string, factorId: string): MfaTotpFactorRecord | undefined;
    findUserById(userId: string): MfaUserRecord | undefined;
    listConfirmedTotpFactors(userId: string, limit: number): MfaTotpFactorRecord[];
    listRecoveryCodes(userId: string, limit: number): MfaRecoveryCodeRecord[];
}

/**
 * Synchronous write surface for one SQLite IMMEDIATE transaction.
 * A failed conditional write returns undefined; callers throw when earlier writes
 * must roll back with that failed transition.
 */
export interface MfaLifecycleUnitOfWork
    extends
        MfaLifecycleReader,
        AuthenticationRateLimitUnitOfWork,
        BrowserSessionWriter,
        SecurityAuditWriter {
    advanceTotpLastUsedStep(
        input: AdvanceTotpLastUsedStepInput
    ): MfaTotpFactorRecord | undefined;
    confirmTotpFactor(input: ConfirmTotpFactorInput): MfaTotpFactorRecord | undefined;
    consumePendingLogin(
        input: ConsumePendingLoginInput
    ): MfaPendingLoginRecord | undefined;
    consumeRecoveryCode(
        input: ConsumeRecoveryCodeInput
    ): MfaRecoveryCodeRecord | undefined;
    deleteOtherSessions(userId: string, retainedSessionId: string): number;
    deletePendingLogin(
        userId: string,
        pendingLoginId: string
    ): MfaPendingLoginRecord | undefined;
    deletePendingLoginsForUser(userId: string): number;
    deletePendingTotpFactorsForUser(userId: string): number;
    deleteRateLimitBuckets(kind: AuthenticationRateLimitKind): number;
    deleteRecoveryCodesForUser(userId: string): number;
    deleteSession(userId: string, sessionId: string): MfaSessionRecord | undefined;
    deleteSessionForRotation(
        input: DeleteSessionForRotationInput
    ): MfaSessionRecord | undefined;
    deleteTotpFactor(userId: string, factorId: string): MfaTotpFactorRecord | undefined;
    deleteTotpFactorsForUser(userId: string): number;
    incrementPendingLoginAttempt(
        input: IncrementPendingLoginAttemptInput
    ): MfaPendingLoginRecord | undefined;
    insertPendingLogin(input: MfaPendingLoginInsert): MfaPendingLoginRecord;
    insertRecoveryCode(input: MfaRecoveryCodeInsert): MfaRecoveryCodeRecord;
    insertTotpFactor(input: MfaTotpFactorInsert): MfaTotpFactorRecord;
    pruneSessions(input: PruneMfaSessionsInput): number;
    updateUserMfaState(input: UpdateUserMfaStateInput): MfaUserRecord | undefined;
}

/** Validated SQLite MFA repository with deferred reads and immediate writes. */
export interface MfaLifecycleRepository extends MfaLifecycleReader {
    withImmediateTransaction<T>(
        callback: (unit: MfaLifecycleUnitOfWork) => SynchronousResult<T>
    ): T;
    withReadTransaction<T>(
        callback: (reader: MfaLifecycleReader) => SynchronousResult<T>
    ): T;
}
