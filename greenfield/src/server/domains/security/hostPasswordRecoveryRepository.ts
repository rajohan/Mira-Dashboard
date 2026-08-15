import { and, eq, isNull } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { authSessions } from "../../database/schema/authSessions.ts";
import { userRecoveryCodes } from "../../database/schema/userRecoveryCodes.ts";
import { userTotpFactors } from "../../database/schema/userTotpFactors.ts";
import { userWebAuthnCredentials } from "../../database/schema/userWebAuthnCredentials.ts";
import { DrizzleAuthenticationRateLimitStore } from "./authenticationRateLimitStore.ts";
import { DrizzlePendingLoginStore } from "./pendingLoginStore.ts";
import {
    DrizzleSecurityAuditStore,
    type SecurityAuditWriter,
} from "./securityAuditStore.ts";
import type {
    SecurityPersistenceDatabase,
    SecurityTransaction,
    SecurityUserPasswordResetInput,
    SecurityUserRecord,
    SynchronousResult,
} from "./securityPersistenceTypes.ts";
import { DrizzleSecurityUserStore } from "./securityUserStore.ts";

export interface HostPasswordRecoveryUnitOfWork extends SecurityAuditWriter {
    deleteAllSessions(userId: string): number;
    deletePendingLoginsForUser(userId: string): number;
    deletePendingTotpFactorsForUser(userId: string): number;
    deleteRateLimitBucket(bucketKey: string): void;
    deleteRecoveryCodesForUser(userId: string): number;
    deleteTotpFactorsForUser(userId: string): number;
    deleteWebAuthnCredentialsForUser(userId: string): number;
    resetUserPassword(
        input: SecurityUserPasswordResetInput
    ): SecurityUserRecord | undefined;
}

export interface HostPasswordRecoveryRepository {
    findUserByUsername(username: string): SecurityUserRecord | undefined;
    withImmediateTransaction<T>(
        callback: (unit: HostPasswordRecoveryUnitOfWork) => SynchronousResult<T>
    ): Promise<T>;
}

class DrizzleHostPasswordRecoveryUnitOfWork implements HostPasswordRecoveryUnitOfWork {
    readonly #auditEvents: DrizzleSecurityAuditStore;
    readonly #database: SecurityPersistenceDatabase;
    readonly #pendingLogins: DrizzlePendingLoginStore;
    readonly #rateLimits: DrizzleAuthenticationRateLimitStore;
    readonly #users: DrizzleSecurityUserStore;

    constructor(transaction: SecurityTransaction) {
        this.#auditEvents = new DrizzleSecurityAuditStore(transaction);
        this.#database = transaction;
        this.#pendingLogins = new DrizzlePendingLoginStore(transaction);
        this.#rateLimits = new DrizzleAuthenticationRateLimitStore(transaction);
        this.#users = new DrizzleSecurityUserStore(transaction);
    }

    deleteAllSessions(userId: string): number {
        return this.#database
            .delete(authSessions)
            .where(eq(authSessions.userId, userId))
            .returning({ id: authSessions.id })
            .all().length;
    }

    deletePendingLoginsForUser(userId: string): number {
        return this.#pendingLogins.deleteAllForUser(userId);
    }

    deletePendingTotpFactorsForUser(userId: string): number {
        return this.#database
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
        this.#rateLimits.deleteRateLimitBucket(bucketKey);
    }

    deleteRecoveryCodesForUser(userId: string): number {
        return this.#database
            .delete(userRecoveryCodes)
            .where(eq(userRecoveryCodes.userId, userId))
            .run().changes;
    }

    deleteTotpFactorsForUser(userId: string): number {
        return this.#database
            .delete(userTotpFactors)
            .where(eq(userTotpFactors.userId, userId))
            .run().changes;
    }

    deleteWebAuthnCredentialsForUser(userId: string): number {
        return this.#database
            .delete(userWebAuthnCredentials)
            .where(eq(userWebAuthnCredentials.userId, userId))
            .run().changes;
    }

    insertAuditEvent(
        event: Parameters<SecurityAuditWriter["insertAuditEvent"]>[0]
    ): void {
        this.#auditEvents.insertAuditEvent(event);
    }

    resetUserPassword(
        input: SecurityUserPasswordResetInput
    ): SecurityUserRecord | undefined {
        return this.#users.resetPassword(input);
    }
}

/**
 * Creates the validated SQLite boundary for one host-local password recovery.
 * @returns Repository with synchronous lookup and admitted immediate writes.
 */
export function createHostPasswordRecoveryRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): HostPasswordRecoveryRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: SecurityTransaction) => T,
        config: { behavior: "immediate" }
    ) => T;
    const users = new DrizzleSecurityUserStore(database);

    return Object.freeze({
        findUserByUsername: users.findUserByUsername.bind(users),
        withImmediateTransaction<T>(
            callback: (
                unit: HostPasswordRecoveryUnitOfWork
            ) => SynchronousResult<T> | never
        ): Promise<T> {
            return writeAdmission.run((markTransactionStarted) =>
                runTransaction(
                    (transaction): T => {
                        markTransactionStarted();
                        return callback(
                            new DrizzleHostPasswordRecoveryUnitOfWork(transaction)
                        );
                    },
                    { behavior: "immediate" }
                )
            );
        },
    });
}
