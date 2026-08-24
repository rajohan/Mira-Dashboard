import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import type { AuthenticationRateLimitKind } from "../../database/schema/authRateLimitBuckets.ts";
import {
    authRateLimitBucketInsertSchema,
    authRateLimitBucketSelectSchema,
} from "../../database/validation/authRateLimitBuckets.ts";
import {
    authSessionInsertSchema,
    authSessionSelectSchema,
} from "../../database/validation/authSessions.ts";
import { userInsertSchema, userSelectSchema } from "../../database/validation/users.ts";

export type AuthRateLimitBucket = v.InferOutput<typeof authRateLimitBucketSelectSchema>;
export type AuthRateLimitBucketInsert = v.InferOutput<
    typeof authRateLimitBucketInsertSchema
>;
export type BrowserSessionRecord = v.InferOutput<typeof authSessionSelectSchema>;
export type BrowserSessionInsert = v.InferOutput<typeof authSessionInsertSchema>;
export type SecurityUserRecord = v.InferOutput<typeof userSelectSchema>;
export type SecurityUserInsert = v.InferOutput<typeof userInsertSchema>;

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];

export type SecurityTransaction = Parameters<TransactionCallback>[0];
export type SecurityPersistenceDatabase = SecurityTransaction | SQLiteBunDatabase;
export type SynchronousResult<T> = T extends Promise<unknown> ? never : T;

export interface AuthenticationSessionListInput {
    readonly authenticationVersion: number;
    readonly checkedAt: Date;
    readonly idleAfter: Date;
    readonly limit: number;
    readonly userId: string;
}

export interface DeleteBrowserSessionForRotationInput {
    readonly expectedAuthenticationVersion: number;
    readonly expectedValidatorHash: string;
    readonly sessionId: string;
    readonly userId: string;
}

export interface PruneAuthenticationRateLimitBucketsInput {
    readonly kind: AuthenticationRateLimitKind;
    readonly maximumBuckets: number;
    readonly retainedBucketKey: string;
    readonly staleBefore: Date;
}

export interface PruneBrowserSessionsInput {
    readonly checkedAt: Date;
    readonly expectedAuthenticationVersion: number;
    readonly idleBefore: Date;
    readonly maximumSessions: number;
    readonly retainedSessionId: string;
    readonly userId: string;
}

export interface SecurityUserMfaStateUpdateInput {
    readonly expectedAuthenticationVersion: number;
    readonly expectedMfaEnabledAt: Date | null;
    readonly mfaEnabledAt: Date | null;
    readonly updatedAt: Date;
    readonly userId: string;
}

export interface SecurityUserPasswordUpdateInput {
    readonly expectedAuthenticationVersion: number;
    readonly expectedPasswordHash: string;
    readonly passwordHash: string;
    readonly updatedAt: Date;
    readonly userId: string;
}

export interface AuthenticationRateLimitReader {
    findRateLimitBucket(bucketKey: string): AuthRateLimitBucket | undefined;
}

export interface AuthenticationRateLimitUnitOfWork extends AuthenticationRateLimitReader {
    deleteRateLimitBucket(bucketKey: string): void;
    pruneRateLimitBuckets(input: PruneAuthenticationRateLimitBucketsInput): number;
    upsertRateLimitBucket(input: AuthRateLimitBucketInsert): AuthRateLimitBucket;
}

export interface BrowserSessionWriter {
    insertSession(input: BrowserSessionInsert): BrowserSessionRecord;
}
