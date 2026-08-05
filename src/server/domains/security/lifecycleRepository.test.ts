import { describe, expect, test } from "bun:test";

import { addMilliseconds } from "date-fns";

import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createAuthenticationLifecycleRepository } from "./lifecycleRepository.ts";

describe("authentication lifecycle repository", () => {
    test("prunes stale and excess source rate-limit buckets transactionally", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createAuthenticationLifecycleRepository(database.orm);
        const startedAt = new Date("2026-08-05T09:00:00.000Z");

        try {
            repository.withImmediateTransaction((unit) => {
                const staleAt = addMilliseconds(startedAt, -2);
                unit.upsertRateLimitBucket({
                    blockedUntil: null,
                    bucketKey: "f".repeat(64),
                    failureCount: 1,
                    firstFailedAt: staleAt,
                    kind: "login-password-source",
                    updatedAt: staleAt,
                });
                for (let index = 0; index < 5; index += 1) {
                    const updatedAt = addMilliseconds(startedAt, index);
                    const bucketKey = index.toString(16).padStart(64, "0");
                    unit.upsertRateLimitBucket({
                        blockedUntil: null,
                        bucketKey,
                        failureCount: 1,
                        firstFailedAt: updatedAt,
                        kind: "login-password-source",
                        updatedAt,
                    });
                    unit.pruneRateLimitBuckets({
                        kind: "login-password-source",
                        maximumBuckets: 3,
                        retainedBucketKey: bucketKey,
                        staleBefore: addMilliseconds(startedAt, -1),
                    });
                }
            });

            expect(
                database.sqlite
                    .query<{ bucketKey: string }, []>(`
                        SELECT bucket_key AS "bucketKey"
                        FROM auth_rate_limit_buckets
                        ORDER BY updated_at DESC
                    `)
                    .all()
                    .map(({ bucketKey }) => bucketKey)
            ).toEqual([4, 3, 2].map((value) => value.toString(16).padStart(64, "0")));
        } finally {
            database.sqlite.close(true);
        }
    });
});
