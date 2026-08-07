import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import * as v from "valibot";

import {
    authRateLimitBuckets,
    type AuthenticationRateLimitKind,
} from "../../database/schema/authRateLimitBuckets.ts";
import {
    authRateLimitBucketInsertSchema,
    authRateLimitBucketSelectSchema,
} from "../../database/validation/authRateLimitBuckets.ts";
import type {
    AuthRateLimitBucket,
    AuthRateLimitBucketInsert,
    PruneAuthenticationRateLimitBucketsInput,
    SecurityPersistenceDatabase,
} from "./securityPersistenceTypes.ts";

function parseRateLimitBucket(row: unknown): AuthRateLimitBucket {
    return v.parse(authRateLimitBucketSelectSchema, row);
}

/** Focused validated persistence for authentication rate-limit buckets. */
export class DrizzleAuthenticationRateLimitStore {
    readonly #database: SecurityPersistenceDatabase;

    constructor(database: SecurityPersistenceDatabase) {
        this.#database = database;
    }

    deleteRateLimitBucket(bucketKey: string): void {
        this.#database
            .delete(authRateLimitBuckets)
            .where(eq(authRateLimitBuckets.bucketKey, bucketKey))
            .run();
    }

    deleteRateLimitBuckets(kind: AuthenticationRateLimitKind): number {
        return this.#database
            .delete(authRateLimitBuckets)
            .where(eq(authRateLimitBuckets.kind, kind))
            .run().changes;
    }

    findRateLimitBucket(bucketKey: string): AuthRateLimitBucket | undefined {
        const row = this.#database
            .select()
            .from(authRateLimitBuckets)
            .where(eq(authRateLimitBuckets.bucketKey, bucketKey))
            .get();
        return row === undefined ? undefined : parseRateLimitBucket(row);
    }

    pruneRateLimitBuckets(input: PruneAuthenticationRateLimitBucketsInput): number {
        if (!Number.isSafeInteger(input.maximumBuckets) || input.maximumBuckets < 1) {
            throw new RangeError("Maximum rate-limit bucket count is invalid");
        }
        const staleChanges = this.#database
            .delete(authRateLimitBuckets)
            .where(
                and(
                    eq(authRateLimitBuckets.kind, input.kind),
                    ne(authRateLimitBuckets.bucketKey, input.retainedBucketKey),
                    lte(authRateLimitBuckets.updatedAt, input.staleBefore)
                )
            )
            .run().changes;
        const excessBucketKeys = this.#database
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
        const overflowChanges = this.#database
            .delete(authRateLimitBuckets)
            .where(inArray(authRateLimitBuckets.bucketKey, excessBucketKeys))
            .run().changes;
        return staleChanges + overflowChanges;
    }

    upsertRateLimitBucket(input: AuthRateLimitBucketInsert): AuthRateLimitBucket {
        const parsed = v.parse(authRateLimitBucketInsertSchema, input);
        const row = this.#database
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
        if (row === undefined) {
            throw new Error("Authentication rate-limit upsert returned no row");
        }
        return parseRateLimitBucket(row);
    }
}
