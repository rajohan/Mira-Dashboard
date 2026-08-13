import { describe, expect, test } from "bun:test";

import type { CacheEntryRecord } from "../cache/repository.ts";
import { createDeliveryOverviewSnapshotRepository } from "./snapshotRepository.ts";

const record = {
    consecutiveFailures: 0,
    expiresAt: new Date(6400),
    failureCode: null,
    failureMessage: null,
    key: "delivery.overview.pull-requests",
    lastAttemptAt: new Date(2000),
    lastAttemptDurationMs: 25,
    lastAttemptNumber: 1,
    lastAttemptRunId: "018f0000-0000-7000-8000-000000000001",
    lastAttemptStatus: "succeeded",
    lastSuccessAt: new Date(2000),
    metadataJson: "{}",
    payloadJson: '{"sourceRevision":"value"}',
    schemaId: "delivery.overview.pull-requests.v1",
    source: "github.delivery.pull-requests",
    updatedAt: new Date(2000),
} as const satisfies CacheEntryRecord;

describe("Delivery overview snapshot repository", () => {
    test("reads only the exact Delivery cache key", () => {
        const keys: string[] = [];
        const repository = createDeliveryOverviewSnapshotRepository({
            findEntry(key) {
                keys.push(key);
                return record;
            },
        });
        expect(repository.read("pull-requests")).toEqual({
            expiresAtMs: 6400,
            key: "delivery.overview.pull-requests",
            lastAttemptAtMs: 2000,
            lastAttemptStatus: "succeeded",
            lastSuccessAtMs: 2000,
            payload: { sourceRevision: "value" },
            schemaId: "delivery.overview.pull-requests.v1",
            source: "github.delivery.pull-requests",
        });
        expect(keys).toEqual(["delivery.overview.pull-requests"]);
    });

    test("contains malformed JSON inside the domain adapter", () => {
        expect(
            createDeliveryOverviewSnapshotRepository({
                findEntry: () => ({ ...record, payloadJson: "{" }),
            }).read("pull-requests")
        ).toMatchObject({ payload: undefined });
    });
});
