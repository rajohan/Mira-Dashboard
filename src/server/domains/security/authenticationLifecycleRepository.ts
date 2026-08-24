import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import type { AuthenticationRateLimitKind } from "../../database/schema/authRateLimitBuckets.ts";
import { DrizzleAuthenticationRateLimitStore } from "./authenticationRateLimitStore.ts";
import { DrizzleBrowserSessionStore } from "./browserSessionStore.ts";
import {
    DrizzlePasswordResetTokenStore,
    type PasswordResetTokenInsert,
    type PasswordResetTokenRecord,
} from "./passwordResetTokenStore.ts";
import { DrizzlePendingLoginStore } from "./pendingLoginStore.ts";
import {
    DrizzleSecurityAuditStore,
    type SecurityAuditWriter,
} from "./securityAuditStore.ts";
import type {
    AuthenticationRateLimitUnitOfWork,
    AuthenticationSessionListInput,
    AuthRateLimitBucket,
    AuthRateLimitBucketInsert,
    BrowserSessionInsert,
    BrowserSessionRecord,
    BrowserSessionWriter,
    PruneAuthenticationRateLimitBucketsInput,
    PruneBrowserSessionsInput,
    SecurityTransaction,
    SecurityUserInsert,
    SecurityUserEmailUpdateInput,
    SecurityUserPasswordUpdateInput,
    SecurityUserPasswordResetInput,
    SecurityUserRecord,
    SynchronousResult,
} from "./securityPersistenceTypes.ts";
import { DrizzleSecurityUserStore } from "./securityUserStore.ts";

export type {
    AuthenticationSessionListInput,
    AuthRateLimitBucket,
    AuthRateLimitBucketInsert,
    BrowserSessionInsert,
    BrowserSessionRecord,
    SecurityUserInsert,
    SecurityUserRecord,
} from "./securityPersistenceTypes.ts";

export interface AuthenticationLifecycleReader {
    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined;
    findUserById(userId: string): SecurityUserRecord | undefined;
    findUserByUsername(username: string): SecurityUserRecord | undefined;
    findPasswordResetToken(prefix: string): PasswordResetTokenRecord | undefined;
    findPasswordResetTokenForUserPurpose(
        userId: string,
        purpose: PasswordResetTokenRecord["purpose"]
    ): PasswordResetTokenRecord | undefined;
    listSessions(input: AuthenticationSessionListInput): BrowserSessionRecord[];
}

export interface AuthenticationLifecycleUnitOfWork
    extends
        AuthenticationLifecycleReader,
        AuthenticationRateLimitUnitOfWork,
        BrowserSessionWriter,
        SecurityAuditWriter {
    countUsers(): number;
    deleteAllSessions(userId: string): number;
    deleteOtherSessions(userId: string, retainedSessionId: string): number;
    deletePendingLoginsForUser(userId: string): number;
    deleteRateLimitBuckets(kind: AuthenticationRateLimitKind): number;
    deleteSession(userId: string, sessionId: string): boolean;
    deletePasswordResetTokensForUser(userId: string): number;
    deletePasswordResetTokensForUserPurpose(
        userId: string,
        purpose: PasswordResetTokenRecord["purpose"]
    ): number;
    deletePasswordResetToken(prefix: string): number;
    insertPasswordResetToken(input: PasswordResetTokenInsert): PasswordResetTokenRecord;
    insertUser(input: SecurityUserInsert): SecurityUserRecord;
    pruneUserSessions(input: PruneBrowserSessionsInput): number;
    touchSession(
        userId: string,
        sessionId: string,
        touchedAt: Date,
        writeBefore: Date
    ): BrowserSessionRecord | undefined;
    updateUserPassword(
        input: SecurityUserPasswordUpdateInput
    ): SecurityUserRecord | undefined;
    resetUserPassword(
        input: SecurityUserPasswordResetInput
    ): SecurityUserRecord | undefined;
    updateUserEmail(input: SecurityUserEmailUpdateInput): SecurityUserRecord | undefined;
}

export interface AuthenticationLifecycleRepository {
    countUsers(): number;
    findRateLimitBucket(bucketKey: string): AuthRateLimitBucket | undefined;
    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined;
    findUserById(userId: string): SecurityUserRecord | undefined;
    findUserByUsername(username: string): SecurityUserRecord | undefined;
    findPasswordResetToken(prefix: string): PasswordResetTokenRecord | undefined;
    findPasswordResetTokenForUserPurpose(
        userId: string,
        purpose: PasswordResetTokenRecord["purpose"]
    ): PasswordResetTokenRecord | undefined;
    listSessions(input: AuthenticationSessionListInput): BrowserSessionRecord[];
    withReadTransaction<T>(
        callback: (reader: AuthenticationLifecycleReader) => SynchronousResult<T>
    ): T;
    withImmediateTransaction<T>(
        callback: (unit: AuthenticationLifecycleUnitOfWork) => SynchronousResult<T>
    ): Promise<T>;
}

class DrizzleAuthenticationLifecycleUnitOfWork implements AuthenticationLifecycleUnitOfWork {
    readonly #auditEvents: DrizzleSecurityAuditStore;
    readonly #pendingLogins: DrizzlePendingLoginStore;
    readonly #passwordResetTokens: DrizzlePasswordResetTokenStore;
    readonly #rateLimits: DrizzleAuthenticationRateLimitStore;
    readonly #sessions: DrizzleBrowserSessionStore;
    readonly #users: DrizzleSecurityUserStore;

    constructor(transaction: SecurityTransaction) {
        this.#auditEvents = new DrizzleSecurityAuditStore(transaction);
        this.#pendingLogins = new DrizzlePendingLoginStore(transaction);
        this.#passwordResetTokens = new DrizzlePasswordResetTokenStore(transaction);
        this.#rateLimits = new DrizzleAuthenticationRateLimitStore(transaction);
        this.#sessions = new DrizzleBrowserSessionStore(transaction);
        this.#users = new DrizzleSecurityUserStore(transaction);
    }

    countUsers(): number {
        return this.#users.countUsers();
    }

    deleteAllSessions(userId: string): number {
        return this.#sessions.deleteAllSessions(userId);
    }

    deleteOtherSessions(userId: string, retainedSessionId: string): number {
        return this.#sessions.deleteOtherSessions(userId, retainedSessionId);
    }

    deletePasswordResetTokensForUser(userId: string): number {
        return this.#passwordResetTokens.deleteForUser(userId);
    }

    deletePasswordResetTokensForUserPurpose(
        userId: string,
        purpose: PasswordResetTokenRecord["purpose"]
    ): number {
        return this.#passwordResetTokens.deleteForUserPurpose(userId, purpose);
    }

    deletePasswordResetToken(prefix: string): number {
        return this.#passwordResetTokens.deleteByPrefix(prefix);
    }

    deletePendingLoginsForUser(userId: string): number {
        return this.#pendingLogins.deleteAllForUser(userId);
    }

    deleteRateLimitBucket(bucketKey: string): void {
        this.#rateLimits.deleteRateLimitBucket(bucketKey);
    }

    deleteRateLimitBuckets(kind: AuthenticationRateLimitKind): number {
        return this.#rateLimits.deleteRateLimitBuckets(kind);
    }

    deleteSession(userId: string, sessionId: string): boolean {
        return this.#sessions.deleteSession(userId, sessionId) !== undefined;
    }

    findRateLimitBucket(bucketKey: string): AuthRateLimitBucket | undefined {
        return this.#rateLimits.findRateLimitBucket(bucketKey);
    }

    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined {
        return this.#sessions.findSession(userId, sessionId);
    }

    findPasswordResetToken(prefix: string): PasswordResetTokenRecord | undefined {
        return this.#passwordResetTokens.findByPrefix(prefix);
    }

    findPasswordResetTokenForUserPurpose(
        userId: string,
        purpose: PasswordResetTokenRecord["purpose"]
    ): PasswordResetTokenRecord | undefined {
        return this.#passwordResetTokens.findByUserPurpose(userId, purpose);
    }

    findUserById(userId: string): SecurityUserRecord | undefined {
        return this.#users.findUserById(userId);
    }

    findUserByUsername(username: string): SecurityUserRecord | undefined {
        return this.#users.findUserByUsername(username);
    }

    insertAuditEvent(
        event: Parameters<SecurityAuditWriter["insertAuditEvent"]>[0]
    ): void {
        this.#auditEvents.insertAuditEvent(event);
    }

    insertSession(input: BrowserSessionInsert): BrowserSessionRecord {
        return this.#sessions.insertSession(input);
    }

    insertPasswordResetToken(input: PasswordResetTokenInsert): PasswordResetTokenRecord {
        return this.#passwordResetTokens.insert(input);
    }

    insertUser(input: SecurityUserInsert): SecurityUserRecord {
        return this.#users.insertUser(input);
    }

    listSessions(input: AuthenticationSessionListInput): BrowserSessionRecord[] {
        return this.#sessions.listSessions(input);
    }

    pruneRateLimitBuckets(input: PruneAuthenticationRateLimitBucketsInput): number {
        return this.#rateLimits.pruneRateLimitBuckets(input);
    }

    pruneUserSessions(input: PruneBrowserSessionsInput): number {
        return this.#sessions.pruneSessions(input);
    }

    touchSession(
        userId: string,
        sessionId: string,
        touchedAt: Date,
        writeBefore: Date
    ): BrowserSessionRecord | undefined {
        return this.#sessions.touchSession(userId, sessionId, touchedAt, writeBefore);
    }

    updateUserPassword(
        input: SecurityUserPasswordUpdateInput
    ): SecurityUserRecord | undefined {
        return this.#users.updatePassword(input);
    }

    resetUserPassword(
        input: SecurityUserPasswordResetInput
    ): SecurityUserRecord | undefined {
        return this.#users.resetPassword(input);
    }

    updateUserEmail(input: SecurityUserEmailUpdateInput): SecurityUserRecord | undefined {
        return this.#users.updateEmail(input);
    }

    upsertRateLimitBucket(input: AuthRateLimitBucketInsert): AuthRateLimitBucket {
        return this.#rateLimits.upsertRateLimitBucket(input);
    }
}

/**
 * Creates the validated SQLite boundary for mutable browser authentication state.
 * Deferred and immediate callbacks remain synchronous so no asynchronous work can
 * retain a SQLite transaction lock; immediate admission and completion are awaited.
 * @param database Process-owned Drizzle SQLite database.
 * @param writeAdmission Process-owned bounded immediate-write admission.
 * @returns Authentication repository with synchronous callbacks and async writes.
 */
export function createAuthenticationLifecycleRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): AuthenticationLifecycleRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: SecurityTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    const rateLimits = new DrizzleAuthenticationRateLimitStore(database);
    const passwordResetTokens = new DrizzlePasswordResetTokenStore(database);
    const sessions = new DrizzleBrowserSessionStore(database);
    const users = new DrizzleSecurityUserStore(database);

    return Object.freeze({
        countUsers: users.countUsers.bind(users),
        findRateLimitBucket: rateLimits.findRateLimitBucket.bind(rateLimits),
        findSession: sessions.findSession.bind(sessions),
        findPasswordResetToken:
            passwordResetTokens.findByPrefix.bind(passwordResetTokens),
        findPasswordResetTokenForUserPurpose:
            passwordResetTokens.findByUserPurpose.bind(passwordResetTokens),
        findUserById: users.findUserById.bind(users),
        findUserByUsername: users.findUserByUsername.bind(users),
        listSessions: sessions.listSessions.bind(sessions),
        withReadTransaction<T>(
            callback: (
                reader: AuthenticationLifecycleReader
            ) => SynchronousResult<T> | never
        ): T {
            return runTransaction(
                (transaction): T =>
                    callback(
                        new DrizzleAuthenticationLifecycleUnitOfWork(transaction)
                    ) as T,
                { behavior: "deferred" }
            );
        },
        withImmediateTransaction<T>(
            callback: (
                unit: AuthenticationLifecycleUnitOfWork
            ) => SynchronousResult<T> | never
        ): Promise<T> {
            return writeAdmission.run((markTransactionStarted) =>
                runTransaction(
                    (transaction): T => {
                        markTransactionStarted();
                        return callback(
                            new DrizzleAuthenticationLifecycleUnitOfWork(transaction)
                        );
                    },
                    { behavior: "immediate" }
                )
            );
        },
    });
}
