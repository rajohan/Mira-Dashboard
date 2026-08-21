import { describe, expect, test } from "bun:test";

import type { CacheEntryRecord } from "../cache/repository.ts";
import { createDockerOverviewSnapshotRepository } from "./snapshotRepository.ts";

const record = {
    consecutiveFailures: 1,
    expiresAt: new Date(6400),
    failureCode: "provider/unavailable",
    failureMessage: "Redacted failure",
    key: "docker.overview",
    lastAttemptAt: new Date(2000),
    lastAttemptDurationMs: 25,
    lastAttemptNumber: 2,
    lastAttemptRunId: "018f0000-0000-7000-8000-000000000001",
    lastAttemptStatus: "failed",
    lastSuccessAt: new Date(1000),
    metadataJson: "{}",
    payloadJson: '{"containers":[]}',
    schemaId: "docker.overview.v1",
    source: "docker-engine.compose",
    updatedAt: new Date(2000),
} as const satisfies CacheEntryRecord;

describe("Docker overview snapshot repository", () => {
    test("reads only the exact Docker cache key", () => {
        const keys: string[] = [];
        const repository = createDockerOverviewSnapshotRepository({
            findEntry(key) {
                keys.push(key);
                return record;
            },
        });

        expect(repository.read()).toEqual({
            expiresAtMs: 6400,
            key: "docker.overview",
            lastAttemptAtMs: 2000,
            lastAttemptStatus: "failed",
            lastSuccessAtMs: 1000,
            payload: { containers: [] },
            schemaId: "docker.overview.v1",
            source: "docker-engine.compose",
        });
        expect(keys).toEqual(["docker.overview"]);
        expect(Object.keys(repository)).toEqual(["read"]);
    });

    test("returns missing and treats malformed JSON as untrusted payload", () => {
        expect(
            createDockerOverviewSnapshotRepository({ findEntry: () => {} }).read()
        ).toBeUndefined();
        expect(
            createDockerOverviewSnapshotRepository({
                findEntry: () => ({ ...record, payloadJson: "{" }),
            }).read()
        ).toMatchObject({ payload: undefined });
    });
});
