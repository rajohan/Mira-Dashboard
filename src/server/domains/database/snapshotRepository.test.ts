import { describe, expect, test } from "bun:test";

import type { CacheEntryRecord } from "../cache/repository.ts";
import { createDatabaseObservabilitySnapshotRepository } from "./snapshotRepository.ts";

const record = {
    consecutiveFailures: 1,
    expiresAt: new Date(6400),
    failureCode: "provider/unavailable",
    failureMessage: "Redacted failure",
    key: "database.observability",
    lastAttemptAt: new Date(2000),
    lastAttemptDurationMs: 25,
    lastAttemptNumber: 2,
    lastAttemptRunId: "018f0000-0000-7000-8000-000000000001",
    lastAttemptStatus: "failed",
    lastSuccessAt: new Date(1000),
    metadataJson: "{}",
    payloadJson: '{"databases":[]}',
    schemaId: "database.observability.v1",
    source: "postgresql.pgbouncer",
    updatedAt: new Date(2000),
} as const satisfies CacheEntryRecord;

describe("database observability snapshot repository", () => {
    test("reads only the exact external database cache key", () => {
        const keys: string[] = [];
        const repository = createDatabaseObservabilitySnapshotRepository({
            findEntry: (key) => {
                keys.push(key);
                return record;
            },
        });

        expect(repository.read()).toEqual({
            expiresAtMs: 6400,
            key: "database.observability",
            lastAttemptAtMs: 2000,
            lastAttemptStatus: "failed",
            lastSuccessAtMs: 1000,
            payload: { databases: [] },
            schemaId: "database.observability.v1",
            source: "postgresql.pgbouncer",
        });
        expect(keys).toEqual(["database.observability"]);
    });

    test("returns missing without exposing generic cache enumeration", () => {
        const repository = createDatabaseObservabilitySnapshotRepository({
            findEntry: () => {},
        });
        expect(repository.read()).toBeUndefined();
        expect(Object.keys(repository)).toEqual(["read"]);
    });

    test("passes malformed JSON as untrusted missing payload for service validation", () => {
        const repository = createDatabaseObservabilitySnapshotRepository({
            findEntry: () => ({ ...record, payloadJson: "{" }),
        });
        expect(repository.read()).toMatchObject({ payload: undefined });
    });
});
