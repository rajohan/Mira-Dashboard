import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import {
    authRateLimitBuckets,
    type AuthenticationRateLimitKind,
} from "../../database/schema/authRateLimitBuckets.ts";
import { authSessions } from "../../database/schema/authSessions.ts";
import { users } from "../../database/schema/users.ts";
import { auditEventInsertSchema } from "../../database/validation/auditEvents.ts";
import {
    authRateLimitBucketInsertSchema,
    authRateLimitBucketSelectSchema,
} from "../../database/validation/authRateLimitBuckets.ts";
import {
    authSessionInsertSchema,
    authSessionSelectSchema,
} from "../../database/validation/authSessions.ts";
import { userInsertSchema, userSelectSchema } from "../../database/validation/users.ts";
import type { SecurityAuditEvent } from "./audit.ts";

export type AuthRateLimitBucket = v.InferOutput<typeof authRateLimitBucketSelectSchema>;
export type AuthRateLimitBucketInsert = v.InferOutput<
    typeof authRateLimitBucketInsertSchema
>;
export type BrowserSessionRecord = v.InferOutput<typeof authSessionSelectSchema>;
export type BrowserSessionInsert = v.InferOutput<typeof authSessionInsertSchema>;
export type SecurityUserRecord = v.InferOutput<typeof userSelectSchema>;
export type SecurityUserInsert = v.InferOutput<typeof userInsertSchema>;

export interface AuthenticationSessionListInput {
    readonly authenticationVersion: number;
    readonly checkedAt: Date;
    readonly idleAfter: Date;
    readonly limit: number;
    readonly userId: string;
}

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type SecurityTransaction = Parameters<TransactionCallback>[0];
type SynchronousResult<T> = T extends Promise<unknown> ? never : T;

export interface AuthenticationLifecycleReader {
    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined;
    findUserById(userId: string): SecurityUserRecord | undefined;
    listSessions(input: AuthenticationSessionListInput): BrowserSessionRecord[];
}

export interface AuthenticationLifecycleUnitOfWork extends AuthenticationLifecycleReader {
    countUsers(): number;
    deleteOtherSessions(userId: string, retainedSessionId: string): number;
    deleteRateLimitBucket(bucketKey: string): void;
    deleteRateLimitBuckets(kind: AuthenticationRateLimitKind): number;
    deleteSession(userId: string, sessionId: string): boolean;
    findRateLimitBucket(bucketKey: string): AuthRateLimitBucket | undefined;
    insertAuditEvent(event: SecurityAuditEvent): void;
    insertSession(input: BrowserSessionInsert): BrowserSessionRecord;
    insertUser(input: SecurityUserInsert): SecurityUserRecord;
    pruneRateLimitBuckets(input: {
        kind: AuthenticationRateLimitKind;
        maximumBuckets: number;
        retainedBucketKey: string;
        staleBefore: Date;
    }): number;
    pruneUserSessions(input: {
        checkedAt: Date;
        expectedAuthenticationVersion: number;
        idleBefore: Date;
        maximumSessions: number;
        retainedSessionId: string;
        userId: string;
    }): number;
    touchSession(
        userId: string,
        sessionId: string,
        touchedAt: Date,
        writeBefore: Date
    ): BrowserSessionRecord | undefined;
    updateUserPassword(input: {
        expectedAuthenticationVersion: number;
        expectedPasswordHash: string;
        passwordHash: string;
        updatedAt: Date;
        userId: string;
    }): SecurityUserRecord | undefined;
    upsertRateLimitBucket(input: AuthRateLimitBucketInsert): AuthRateLimitBucket;
}

export interface AuthenticationLifecycleRepository {
    countUsers(): number;
    findRateLimitBucket(bucketKey: string): AuthRateLimitBucket | undefined;
    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined;
    findUserById(userId: string): SecurityUserRecord | undefined;
    findUserByUsername(username: string): SecurityUserRecord | undefined;
    listSessions(input: AuthenticationSessionListInput): BrowserSessionRecord[];
    withReadTransaction<T>(
        callback: (reader: AuthenticationLifecycleReader) => SynchronousResult<T>
    ): T;
    withImmediateTransaction<T>(
        callback: (unit: AuthenticationLifecycleUnitOfWork) => SynchronousResult<T>
    ): T;
}

function requiredRow<T>(row: T | undefined, operation: string): T {
    if (row === undefined) {
        throw new Error(`Authentication repository ${operation} returned no row`);
    }
    return row;
}

function parseUser(row: unknown): SecurityUserRecord {
    return v.parse(userSelectSchema, row);
}

function parseSession(row: unknown): BrowserSessionRecord {
    return v.parse(authSessionSelectSchema, row);
}

function parseRateLimitBucket(row: unknown): AuthRateLimitBucket {
    return v.parse(authRateLimitBucketSelectSchema, row);
}

function listSessionsFromDatabase(
    database: SecurityTransaction | SQLiteBunDatabase,
    input: AuthenticationSessionListInput
): BrowserSessionRecord[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
        throw new RangeError("Browser session list limit is invalid");
    }
    return database
        .select()
        .from(authSessions)
        .where(
            and(
                eq(authSessions.userId, input.userId),
                eq(authSessions.authenticationVersion, input.authenticationVersion),
                gt(authSessions.expiresAt, input.checkedAt),
                gt(authSessions.lastSeenAt, input.idleAfter)
            )
        )
        .orderBy(
            desc(authSessions.lastSeenAt),
            desc(authSessions.createdAt),
            desc(authSessions.id)
        )
        .limit(input.limit)
        .all()
        .map((row) => parseSession(row));
}

class DrizzleAuthenticationLifecycleUnitOfWork implements AuthenticationLifecycleUnitOfWork {
    readonly #transaction: SecurityTransaction;

    constructor(transaction: SecurityTransaction) {
        this.#transaction = transaction;
    }

    countUsers(): number {
        const row = this.#transaction
            .select({ count: sql<number>`count(*)` })
            .from(users)
            .get();
        const count = requiredRow(row, "user count").count;
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error("Authentication repository returned an invalid user count");
        }
        return count;
    }

    deleteOtherSessions(userId: string, retainedSessionId: string): number {
        return this.#transaction
            .delete(authSessions)
            .where(
                and(
                    eq(authSessions.userId, userId),
                    ne(authSessions.id, retainedSessionId)
                )
            )
            .run().changes;
    }

    deleteRateLimitBucket(bucketKey: string): void {
        this.#transaction
            .delete(authRateLimitBuckets)
            .where(eq(authRateLimitBuckets.bucketKey, bucketKey))
            .run();
    }

    deleteRateLimitBuckets(kind: AuthenticationRateLimitKind): number {
        return this.#transaction
            .delete(authRateLimitBuckets)
            .where(eq(authRateLimitBuckets.kind, kind))
            .run().changes;
    }

    deleteSession(userId: string, sessionId: string): boolean {
        return (
            this.#transaction
                .delete(authSessions)
                .where(
                    and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId))
                )
                .run().changes === 1
        );
    }

    findRateLimitBucket(bucketKey: string): AuthRateLimitBucket | undefined {
        const row = this.#transaction
            .select()
            .from(authRateLimitBuckets)
            .where(eq(authRateLimitBuckets.bucketKey, bucketKey))
            .get();
        return row === undefined
            ? undefined
            : v.parse(authRateLimitBucketSelectSchema, row);
    }

    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined {
        const row = this.#transaction
            .select()
            .from(authSessions)
            .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
            .get();
        return row === undefined ? undefined : parseSession(row);
    }

    findUserById(userId: string): SecurityUserRecord | undefined {
        const row = this.#transaction
            .select()
            .from(users)
            .where(eq(users.id, userId))
            .get();
        return row === undefined ? undefined : parseUser(row);
    }

    insertAuditEvent(event: SecurityAuditEvent): void {
        this.#transaction
            .insert(auditEvents)
            .values(v.parse(auditEventInsertSchema, event))
            .run();
    }

    insertSession(input: BrowserSessionInsert): BrowserSessionRecord {
        const row = this.#transaction
            .insert(authSessions)
            .values(v.parse(authSessionInsertSchema, input))
            .returning()
            .get();
        return parseSession(requiredRow(row, "session insert"));
    }

    insertUser(input: SecurityUserInsert): SecurityUserRecord {
        const row = this.#transaction
            .insert(users)
            .values(v.parse(userInsertSchema, input))
            .returning()
            .get();
        return parseUser(requiredRow(row, "user insert"));
    }

    listSessions(input: AuthenticationSessionListInput): BrowserSessionRecord[] {
        return listSessionsFromDatabase(this.#transaction, input);
    }

    pruneRateLimitBuckets(input: {
        kind: AuthenticationRateLimitKind;
        maximumBuckets: number;
        retainedBucketKey: string;
        staleBefore: Date;
    }): number {
        if (!Number.isSafeInteger(input.maximumBuckets) || input.maximumBuckets < 1) {
            throw new RangeError("Maximum rate-limit bucket count is invalid");
        }
        const staleChanges = this.#transaction
            .delete(authRateLimitBuckets)
            .where(
                and(
                    eq(authRateLimitBuckets.kind, input.kind),
                    ne(authRateLimitBuckets.bucketKey, input.retainedBucketKey),
                    lte(authRateLimitBuckets.updatedAt, input.staleBefore)
                )
            )
            .run().changes;
        const excessBucketKeys = this.#transaction
            .select({ bucketKey: authRateLimitBuckets.bucketKey })
            .from(authRateLimitBuckets)
            .where(
                and(
                    eq(authRateLimitBuckets.kind, input.kind),
                    ne(authRateLimitBuckets.bucketKey, input.retainedBucketKey)
                )
            )
            .orderBy(
                desc(authRateLimitBuckets.updatedAt),
                desc(authRateLimitBuckets.bucketKey)
            )
            .limit(2_147_483_647)
            .offset(input.maximumBuckets - 1);
        const overflowChanges = this.#transaction
            .delete(authRateLimitBuckets)
            .where(inArray(authRateLimitBuckets.bucketKey, excessBucketKeys))
            .run().changes;
        return staleChanges + overflowChanges;
    }

    pruneUserSessions(input: {
        checkedAt: Date;
        expectedAuthenticationVersion: number;
        idleBefore: Date;
        maximumSessions: number;
        retainedSessionId: string;
        userId: string;
    }): number {
        if (!Number.isSafeInteger(input.maximumSessions) || input.maximumSessions < 1) {
            throw new RangeError("Maximum browser session count is invalid");
        }
        const belongsToUser = eq(authSessions.userId, input.userId);
        const isExpired = lte(authSessions.expiresAt, input.checkedAt);
        const isIdle = lte(authSessions.lastSeenAt, input.idleBefore);
        const hasStaleAuthenticationVersion = ne(
            authSessions.authenticationVersion,
            input.expectedAuthenticationVersion
        );
        const isInactive = or(isExpired, isIdle, hasStaleAuthenticationVersion);
        const inactiveChanges = this.#transaction
            .delete(authSessions)
            .where(and(belongsToUser, isInactive))
            .run().changes;
        const excessSessionIds = this.#transaction
            .select({ id: authSessions.id })
            .from(authSessions)
            .where(
                and(
                    eq(authSessions.userId, input.userId),
                    ne(authSessions.id, input.retainedSessionId)
                )
            )
            .orderBy(
                desc(authSessions.lastSeenAt),
                desc(authSessions.createdAt),
                desc(authSessions.id)
            )
            .limit(2_147_483_647)
            .offset(input.maximumSessions - 1);
        const overflowChanges = this.#transaction
            .delete(authSessions)
            .where(inArray(authSessions.id, excessSessionIds))
            .run().changes;
        return inactiveChanges + overflowChanges;
    }

    touchSession(
        userId: string,
        sessionId: string,
        touchedAt: Date,
        writeBefore: Date
    ): BrowserSessionRecord | undefined {
        const row = this.#transaction
            .update(authSessions)
            .set({ lastSeenAt: touchedAt })
            .where(
                and(
                    eq(authSessions.id, sessionId),
                    eq(authSessions.userId, userId),
                    lte(authSessions.lastSeenAt, writeBefore),
                    gt(authSessions.expiresAt, touchedAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseSession(row);
    }

    updateUserPassword(input: {
        expectedAuthenticationVersion: number;
        expectedPasswordHash: string;
        passwordHash: string;
        updatedAt: Date;
        userId: string;
    }): SecurityUserRecord | undefined {
        const row = this.#transaction
            .update(users)
            .set({
                authenticationVersion: sql`${users.authenticationVersion} + 1`,
                passwordHash: input.passwordHash,
                updatedAt: input.updatedAt,
            })
            .where(
                and(
                    eq(users.id, input.userId),
                    eq(users.authenticationVersion, input.expectedAuthenticationVersion),
                    eq(users.passwordHash, input.expectedPasswordHash),
                    isNull(users.disabledAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseUser(row);
    }

    upsertRateLimitBucket(input: AuthRateLimitBucketInsert): AuthRateLimitBucket {
        const parsed = v.parse(authRateLimitBucketInsertSchema, input);
        const row = this.#transaction
            .insert(authRateLimitBuckets)
            .values(parsed)
            .onConflictDoUpdate({
                set: {
                    blockedUntil: parsed.blockedUntil,
                    failureCount: parsed.failureCount,
                    firstFailedAt: parsed.firstFailedAt,
                    kind: parsed.kind,
                    updatedAt: parsed.updatedAt,
                },
                target: authRateLimitBuckets.bucketKey,
            })
            .returning()
            .get();
        return v.parse(
            authRateLimitBucketSelectSchema,
            requiredRow(row, "rate-limit upsert")
        );
    }
}

/**
 * Creates the validated SQLite boundary for mutable browser authentication state.
 * @param database Process-owned Drizzle SQLite database.
 * @returns A synchronous authentication lifecycle repository.
 */
export function createAuthenticationLifecycleRepository(
    database: SQLiteBunDatabase
): AuthenticationLifecycleRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: SecurityTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;

    return Object.freeze({
        countUsers() {
            const row = database
                .select({ count: sql<number>`count(*)` })
                .from(users)
                .get();
            const count = requiredRow(row, "user count").count;
            if (!Number.isSafeInteger(count) || count < 0) {
                throw new Error(
                    "Authentication repository returned an invalid user count"
                );
            }
            return count;
        },
        findRateLimitBucket(bucketKey: string) {
            const row = database
                .select()
                .from(authRateLimitBuckets)
                .where(eq(authRateLimitBuckets.bucketKey, bucketKey))
                .get();
            return row === undefined ? undefined : parseRateLimitBucket(row);
        },
        findSession(userId: string, sessionId: string) {
            const row = database
                .select()
                .from(authSessions)
                .where(
                    and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId))
                )
                .get();
            return row === undefined ? undefined : parseSession(row);
        },
        findUserById(userId: string) {
            const row = database.select().from(users).where(eq(users.id, userId)).get();
            return row === undefined ? undefined : parseUser(row);
        },
        findUserByUsername(username: string) {
            const row = database
                .select()
                .from(users)
                .where(eq(users.username, username))
                .get();
            return row === undefined ? undefined : parseUser(row);
        },
        listSessions(input: AuthenticationSessionListInput) {
            return listSessionsFromDatabase(database, input);
        },
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
        ): T {
            return runTransaction(
                (transaction): T =>
                    callback(
                        new DrizzleAuthenticationLifecycleUnitOfWork(transaction)
                    ) as T,
                { behavior: "immediate" }
            );
        },
    });
}
