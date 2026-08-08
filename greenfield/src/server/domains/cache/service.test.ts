import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createJobRepository } from "../jobs/repository.ts";
import { reconcileJobSchedules } from "../jobs/service.ts";
import { CacheConflictError, CacheNotFoundError } from "./errors.ts";
import type { CacheEntryRecord, CacheRepository } from "./repository.ts";
import { createCacheRepository } from "./repository.ts";
import { createCacheService } from "./service.ts";

function uuid(index: number): string {
    return `019fdf40-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function principal(index: number): AuthenticatedPrincipal {
    return {
        authenticatorId: "a".repeat(32),
        authorizationVersion: 1,
        capabilities: ["cache:read", "cache:write"],
        id: uuid(index),
        kind: "session",
    };
}

const record: CacheEntryRecord = {
    consecutiveFailures: 1,
    expiresAt: new Date(5000),
    failureCode: "provider/system-host-unavailable",
    failureMessage: "System host projection could not be collected.",
    key: "system.host",
    lastAttemptAt: new Date(4000),
    lastAttemptDurationMs: 7,
    lastAttemptNumber: 2,
    lastAttemptRunId: uuid(20),
    lastAttemptStatus: "failed",
    lastSuccessAt: new Date(3000),
    metadataJson: '{"kind":"host"}',
    payloadJson:
        '{"architecture":"x64","disk":{"freeBytes":500,"path":"/","totalBytes":1000},"hostname":"dashboard-host","memory":{"freeBytes":400,"totalBytes":1000},"platform":"linux","release":"6.8.0","uptimeSeconds":12}',
    schemaId: "system.host.v1",
    source: "system.host",
    updatedAt: new Date(4000),
};

function readOnlyCacheRepository(entry: CacheEntryRecord): CacheRepository {
    return {
        commitAttempt: () => Promise.reject(new Error("Unexpected cache write")),
        findEntry: (key) => (key === entry.key ? entry : undefined),
        readStatus: () => ({ entries: [entry], totalCount: 129 }),
    };
}

describe("cache service", () => {
    test("derives freshness independently from a failed latest attempt", async () => {
        let currentTime = 4500;
        const service = createCacheService({
            cacheRepository: readOnlyCacheRepository(record),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => currentTime,
        });
        const fresh = await Effect.runPromise(service.getEntry({ key: "system.host" }));
        expect(fresh).toMatchObject({
            freshness: "fresh",
            lastAttemptStatus: "failed",
            manualRunAvailable: true,
        });
        currentTime = 5000;
        expect(
            await Effect.runPromise(service.getEntry({ key: "system.host" }))
        ).toMatchObject({ freshness: "stale", lastAttemptStatus: "failed" });
        expect(await Effect.runPromise(service.getStatus())).toMatchObject({
            entries: [{ freshness: "stale", key: "system.host" }],
            generatedAtMs: 5000,
            totalCount: 129,
            truncated: true,
        });
        currentTime = 3500;
        expect(await Effect.runPromise(service.getStatus())).toMatchObject({
            entries: [{ freshness: "fresh", key: "system.host" }],
            generatedAtMs: 4000,
        });
        const missingFailure = {
            ...record,
            expiresAt: null,
            lastSuccessAt: null,
            metadataJson: null,
            payloadJson: null,
            schemaId: null,
            source: null,
        };
        const missingService = createCacheService({
            cacheRepository: readOnlyCacheRepository(missingFailure),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 6000,
        });
        const missing = await Effect.runPromise(
            missingService.getEntry({ key: "system.host" })
        );
        expect(missing).toMatchObject({
            freshness: "missing",
            lastAttemptStatus: "failed",
        });
        expect("payload" in missing).toBe(false);
        const regressedClockService = createCacheService({
            cacheRepository: readOnlyCacheRepository({
                ...record,
                expiresAt: new Date(3800),
            }),
            jobRepository: Object.freeze({}) as never,
            nowMs: () => 3500,
        });
        expect(
            await Effect.runPromise(
                regressedClockService.getEntry({ key: "system.host" })
            )
        ).toMatchObject({ freshness: "stale", updatedAtMs: 4000 });
        expect(
            Effect.runPromise(service.getEntry({ key: "missing" }))
        ).rejects.toBeInstanceOf(CacheNotFoundError);
    });

    test("replays before mutable provider and schedule lookups with caller isolation", async () => {
        const database = await openFreshMigratedDatabase();
        const jobRepository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        let nextId = 100;
        const generateId = () => uuid(nextId++);
        try {
            await reconcileJobSchedules({
                generateId,
                nowMs: () => 1000,
                repository: jobRepository,
            });
            const service = createCacheService({
                cacheRepository: createCacheRepository(
                    database.orm,
                    testImmediateDatabaseWriteAdmission
                ),
                generateId,
                jobRepository,
                nowMs: () => 2000,
            });
            const input = {
                idempotencyKey: "b".repeat(32),
                key: "system.host",
            };
            const first = await Effect.runPromise(
                service.refreshEntry(principal(1), input)
            );
            expect(first).toMatchObject({
                actionKey: "cache.refresh.system-host",
                state: "queued",
            });

            const throwingLookupRepository = {
                ...jobRepository,
                findSchedule() {
                    throw new Error("Replay performed a mutable schedule lookup");
                },
            };
            const replayService = createCacheService({
                cacheRepository: createCacheRepository(
                    database.orm,
                    testImmediateDatabaseWriteAdmission
                ),
                generateId,
                jobRepository: throwingLookupRepository,
                nowMs: () => 3000,
            });
            expect(
                await Effect.runPromise(replayService.refreshEntry(principal(1), input))
            ).toEqual(first);
            expect(
                Effect.runPromise(
                    replayService.refreshEntry(principal(1), {
                        idempotencyKey: input.idempotencyKey,
                        key: "unknown.provider",
                    })
                )
            ).rejects.toBeInstanceOf(CacheConflictError);
            expect(
                Effect.runPromise(
                    service.refreshEntry(principal(2), {
                        idempotencyKey: input.idempotencyKey,
                        key: "unknown.provider",
                    })
                )
            ).rejects.toBeInstanceOf(CacheNotFoundError);
        } finally {
            database.sqlite.close(true);
        }
    });
});
