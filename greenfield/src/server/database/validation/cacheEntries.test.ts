import { describe, expect, test } from "bun:test";

import { addMinutes, subMilliseconds } from "date-fns";
import * as v from "valibot";

import { cacheEntryInsertSchema, cacheEntrySelectSchema } from "./cacheEntries.ts";

const attemptAt = new Date(1000);
const validCacheEntry = Object.freeze({
    consecutiveFailures: 0,
    expiresAt: addMinutes(attemptAt, 1),
    failureCode: null,
    failureMessage: null,
    key: "system.host",
    lastAttemptAt: attemptAt,
    lastAttemptDurationMs: 25,
    lastAttemptNumber: 1,
    lastAttemptRunId: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
    lastAttemptStatus: "succeeded" as const,
    lastSuccessAt: attemptAt,
    metadataJson: '{"provider":"node"}',
    payloadJson: '{"hostname":"dashboard"}',
    schemaId: "system.host.v1",
    source: "system.host",
    updatedAt: attemptAt,
});

describe("cache entry row schemas", () => {
    test("accepts successful, missing-failed, and stale-failed rows", () => {
        expect(v.parse(cacheEntryInsertSchema, validCacheEntry)).toBeDefined();
        expect(v.parse(cacheEntrySelectSchema, validCacheEntry)).toBeDefined();

        const failed = {
            ...validCacheEntry,
            consecutiveFailures: 1,
            failureCode: "system.host/unavailable",
            failureMessage: "Host projection is temporarily unavailable.",
            lastAttemptAt: addMinutes(attemptAt, 2),
            lastAttemptRunId: "019fc968-1a9b-7766-9f1b-d5b863b0e7b4",
            lastAttemptStatus: "failed" as const,
            updatedAt: addMinutes(attemptAt, 2),
        };
        expect(v.parse(cacheEntryInsertSchema, failed)).toBeDefined();

        expect(
            v.parse(cacheEntryInsertSchema, {
                ...failed,
                expiresAt: null,
                lastSuccessAt: null,
                metadataJson: null,
                payloadJson: null,
                schemaId: null,
                source: null,
            })
        ).toBeDefined();
    });

    test("rejects partial projections and attempt/outcome disagreement", () => {
        for (const overrides of [
            { metadataJson: null },
            { consecutiveFailures: 1 },
            { failureCode: "system.host/failed" },
            { lastAttemptAt: addMinutes(attemptAt, 1) },
            { expiresAt: attemptAt },
            { updatedAt: subMilliseconds(attemptAt, 1) },
            { payloadJson: "[]" },
        ]) {
            expect(
                v.safeParse(cacheEntryInsertSchema, {
                    ...validCacheEntry,
                    ...overrides,
                }).success
            ).toBeFalse();
        }
    });

    test("reserves the larger persisted payload budget only for Delivery", () => {
        const payloadJson = JSON.stringify({ value: "x".repeat(300 * 1024) });
        expect(
            v.safeParse(cacheEntryInsertSchema, {
                ...validCacheEntry,
                key: "system.host",
                payloadJson,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(cacheEntryInsertSchema, {
                ...validCacheEntry,
                key: "delivery.overview.pull-requests",
                payloadJson,
                schemaId: "delivery.overview.pull-requests.v2",
                source: "github.delivery.pull-requests",
            }).success
        ).toBeTrue();
    });
});
