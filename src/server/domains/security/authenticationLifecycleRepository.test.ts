import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addMilliseconds } from "date-fns";
import { drizzle } from "drizzle-orm/bun-sqlite";

import {
    securityUserId,
    sessionSelector,
    validAuthSessionInsert,
    validUserInsert,
} from "../../database/validation/testSupport/securityRows.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createAuthenticationLifecycleRepository } from "./authenticationLifecycleRepository.ts";

describe("authentication lifecycle repository", () => {
    test("acquires the SQLite write lock before an immediate callback runs", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-auth-repository-"));
        const databasePath = path.join(directory, "dashboard.sqlite");
        const primary = new Database(databasePath, { create: true, strict: true });
        const competing = new Database(databasePath, { strict: true });
        competing.run("PRAGMA busy_timeout = 0");
        const repository = createAuthenticationLifecycleRepository(
            drizzle({ client: primary })
        );

        try {
            let deferredCompetingWriterAcquired = false;
            repository.withReadTransaction(() => {
                competing.run("BEGIN IMMEDIATE");
                deferredCompetingWriterAcquired = true;
                competing.run("ROLLBACK");
            });
            expect(deferredCompetingWriterAcquired).toBeTrue();

            let immediateCompetingWriterFailure: unknown;
            repository.withImmediateTransaction(() => {
                try {
                    competing.run("BEGIN IMMEDIATE");
                    competing.run("ROLLBACK");
                } catch (error) {
                    immediateCompetingWriterFailure = error;
                }
            });

            expect(immediateCompetingWriterFailure).toBeInstanceOf(Error);
            expect(String(immediateCompetingWriterFailure)).toContain(
                "database is locked"
            );
            competing.run("BEGIN IMMEDIATE");
            competing.run("ROLLBACK");
        } finally {
            competing.close(true);
            primary.close(true);
            await rm(directory, { force: true, recursive: true });
        }
    });

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

    test("adapts shared session deletion to boolean lifecycle semantics", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createAuthenticationLifecycleRepository(database.orm);

        try {
            repository.withImmediateTransaction((unit) => {
                unit.insertUser(validUserInsert);
                unit.insertSession(validAuthSessionInsert);
                expect(unit.deleteSession(securityUserId, sessionSelector)).toBeTrue();
                expect(unit.deleteSession(securityUserId, sessionSelector)).toBeFalse();
            });
        } finally {
            database.sqlite.close(true);
        }
    });
});
