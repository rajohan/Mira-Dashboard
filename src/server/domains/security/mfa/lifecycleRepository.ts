import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../../database/immediateWriteAdmission.ts";
import type {
    SecurityTransaction,
    SynchronousResult,
} from "../securityPersistenceTypes.ts";
import { DrizzleMfaLifecycleReader } from "./lifecycleRepositoryReader.ts";
import type {
    MfaLifecycleReader,
    MfaLifecycleRepository,
    MfaLifecycleUnitOfWork,
} from "./lifecycleRepositoryTypes.ts";
import { DrizzleMfaLifecycleUnitOfWork } from "./lifecycleRepositoryUnitOfWork.ts";

export { pendingLoginAttemptMaximum } from "./lifecycleRepositoryTypes.ts";
export type {
    AdvanceTotpLastUsedStepInput,
    AdvanceWebAuthnCredentialInput,
    ConfirmTotpFactorInput,
    ConsumePendingLoginInput,
    ConsumeRecoveryCodeInput,
    ConsumeWebAuthnChallengeInput,
    DeleteSessionForRotationInput,
    IncrementPendingLoginAttemptInput,
    MfaLifecycleReader,
    MfaLifecycleRepository,
    MfaLifecycleUnitOfWork,
    MfaPendingLoginInsert,
    MfaPendingLoginRecord,
    MfaRateLimitBucket,
    MfaRateLimitBucketInsert,
    MfaRecoveryCodeInsert,
    MfaRecoveryCodeRecord,
    MfaSessionInsert,
    MfaSessionRecord,
    MfaTotpFactorInsert,
    MfaTotpFactorRecord,
    MfaUserRecord,
    MfaWebAuthnChallengeInsert,
    MfaWebAuthnChallengeRecord,
    MfaWebAuthnCredentialInsert,
    MfaWebAuthnCredentialRecord,
    PruneMfaRateLimitBucketsInput,
    PruneMfaSessionsInput,
    UpdateUserMfaStateInput,
} from "./lifecycleRepositoryTypes.ts";

/**
 * Creates the validated persistence boundary for password-first MFA lifecycle state.
 * Immediate callbacks are deliberately synchronous so no expensive cryptography can
 * retain the SQLite write lock across an await.
 * @param database Process-owned Drizzle SQLite database.
 * @param writeAdmission Process-owned bounded immediate-write admission.
 * @returns MFA repository with deferred reads and admitted async writes.
 */
export function createMfaLifecycleRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): MfaLifecycleRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: SecurityTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;

    const reader = new DrizzleMfaLifecycleReader(database);
    return Object.freeze({
        countConfirmedTotpFactors: reader.countConfirmedTotpFactors.bind(reader),
        countTotpFactors: reader.countTotpFactors.bind(reader),
        countUnusedRecoveryCodes: reader.countUnusedRecoveryCodes.bind(reader),
        countWebAuthnCredentials: reader.countWebAuthnCredentials.bind(reader),
        findConfirmedTotpFactor: reader.findConfirmedTotpFactor.bind(reader),
        findPendingLogin: reader.findPendingLogin.bind(reader),
        findPendingLoginWebAuthnChallenge:
            reader.findPendingLoginWebAuthnChallenge.bind(reader),
        findRateLimitBucket: reader.findRateLimitBucket.bind(reader),
        findRecoveryCode: reader.findRecoveryCode.bind(reader),
        findSession: reader.findSession.bind(reader),
        findTotpFactor: reader.findTotpFactor.bind(reader),
        findUserById: reader.findUserById.bind(reader),
        findSessionWebAuthnChallenge: reader.findSessionWebAuthnChallenge.bind(reader),
        findWebAuthnCredential: reader.findWebAuthnCredential.bind(reader),
        findWebAuthnCredentialById: reader.findWebAuthnCredentialById.bind(reader),
        listConfirmedTotpFactors: reader.listConfirmedTotpFactors.bind(reader),
        listRecoveryCodes: reader.listRecoveryCodes.bind(reader),
        listWebAuthnCredentials: reader.listWebAuthnCredentials.bind(reader),
        withImmediateTransaction<T>(
            callback: (unit: MfaLifecycleUnitOfWork) => SynchronousResult<T> | never
        ): Promise<T> {
            return writeAdmission.run((markTransactionStarted) =>
                runTransaction(
                    (transaction): T => {
                        markTransactionStarted();
                        return callback(new DrizzleMfaLifecycleUnitOfWork(transaction));
                    },
                    { behavior: "immediate" }
                )
            );
        },
        withReadTransaction<T>(
            callback: (reader: MfaLifecycleReader) => SynchronousResult<T> | never
        ): T {
            return runTransaction(
                (transaction): T =>
                    callback(new DrizzleMfaLifecycleReader(transaction)) as T,
                { behavior: "deferred" }
            );
        },
    });
}
