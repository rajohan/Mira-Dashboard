import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    cacheEntrySchema,
    cacheStatusMaximumEntries,
    cacheStatusResultSchema,
    refreshCacheEntryInputSchema,
    systemHostCachePayloadSchema,
} from "./cache.ts";

const runId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";

const successfulEntry = Object.freeze({
    consecutiveFailures: 0,
    expiresAtMs: 61_000,
    freshness: "fresh" as const,
    key: "system.host",
    lastAttemptAtMs: 1000,
    lastAttemptDurationMs: 25,
    lastAttemptNumber: 1,
    lastAttemptRunId: runId,
    lastAttemptStatus: "succeeded" as const,
    lastSuccessAtMs: 1000,
    manualRunAvailable: true,
    metadata: { provider: "node" },
    payload: { hostname: "dashboard" },
    schemaId: "system.host.v1",
    source: "system.host",
    updatedAtMs: 1000,
});

describe("cache contracts", () => {
    test("keeps freshness separate from the latest refresh outcome", () => {
        expect(v.parse(cacheEntrySchema, successfulEntry)).toEqual(successfulEntry);

        const staleAfterFailure = {
            ...successfulEntry,
            consecutiveFailures: 1,
            failureCode: "system.host/unavailable",
            failureMessage: "Host projection is temporarily unavailable.",
            freshness: "stale",
            lastAttemptAtMs: 62_000,
            lastAttemptRunId: "019fc968-1a9b-7766-9f1b-d5b863b0e7b4",
            lastAttemptStatus: "failed",
            updatedAtMs: 62_000,
        } as const;
        expect(v.parse(cacheEntrySchema, staleAfterFailure)).toEqual(staleAfterFailure);

        const missingAfterFailure = {
            consecutiveFailures: 1,
            failureCode: "system.host/unavailable",
            failureMessage: "Host projection is temporarily unavailable.",
            freshness: "missing",
            key: "system.host",
            lastAttemptAtMs: 1000,
            lastAttemptDurationMs: 25,
            lastAttemptNumber: 1,
            lastAttemptRunId: runId,
            lastAttemptStatus: "failed",
            manualRunAvailable: true,
            updatedAtMs: 1000,
        } as const;
        expect(v.parse(cacheEntrySchema, missingAfterFailure)).toEqual(
            missingAfterFailure
        );
    });

    test("rejects partial last-known-good state and inconsistent attempt fields", () => {
        for (const entry of [
            { ...successfulEntry, metadata: undefined },
            { ...successfulEntry, consecutiveFailures: 1 },
            { ...successfulEntry, freshness: "missing" },
            {
                ...successfulEntry,
                failureCode: "system.host/failed",
                failureMessage: "Failed.",
            },
            { ...successfulEntry, expiresAtMs: 1000 },
        ]) {
            expect(v.safeParse(cacheEntrySchema, entry).success).toBeFalse();
        }
    });

    test("caps status at 128 rows with an explicit total and truncation marker", () => {
        const entry = (({ payload: _payload, ...status }) => status)(successfulEntry);
        expect(
            v.parse(cacheStatusResultSchema, {
                entries: [entry],
                generatedAtMs: 1000,
                totalCount: 2,
                truncated: true,
            })
        ).toBeDefined();

        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: [entry],
                generatedAtMs: 1000,
                totalCount: 1,
                truncated: true,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: [entry],
                generatedAtMs: 61_000,
                totalCount: 1,
                truncated: false,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: [{ ...entry, freshness: "stale" }],
                generatedAtMs: 1000,
                totalCount: 1,
                truncated: false,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(cacheStatusResultSchema, {
                entries: Array.from(
                    { length: cacheStatusMaximumEntries + 1 },
                    () => entry
                ),
                generatedAtMs: 1000,
                totalCount: cacheStatusMaximumEntries + 1,
                truncated: false,
            }).success
        ).toBeFalse();
    });

    test("accepts only canonical lost-response-safe refresh requests", () => {
        expect(
            v.parse(refreshCacheEntryInputSchema, {
                idempotencyKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                key: "system.host",
            })
        ).toBeDefined();
        for (const key of ["System.Host", "system/host", " system.host"] as const) {
            expect(
                v.safeParse(refreshCacheEntryInputSchema, {
                    idempotencyKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                    key,
                }).success
            ).toBeFalse();
        }
    });

    test("locks the worker-only system.host projection to safe public scalars", () => {
        const payload = {
            architecture: "x64",
            disk: { freeBytes: 500, path: "/", totalBytes: 1000 },
            hostname: "dashboard",
            memory: { freeBytes: 1000, totalBytes: 2000 },
            platform: "linux",
            release: "6.8.0",
            uptimeSeconds: 60,
        };
        expect(v.parse(systemHostCachePayloadSchema, payload)).toEqual(payload);
        for (const invalid of [
            { ...payload, uptimeSeconds: 0.5 },
            { ...payload, memory: { freeBytes: 2001, totalBytes: 2000 } },
            { ...payload, disk: { freeBytes: 500, path: "/tmp", totalBytes: 1000 } },
            { ...payload, hostname: "host\nforged" },
        ]) {
            expect(
                v.safeParse(systemHostCachePayloadSchema, invalid).success
            ).toBeFalse();
        }
    });
});
