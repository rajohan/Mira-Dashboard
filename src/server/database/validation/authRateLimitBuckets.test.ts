import { describe, expect, test } from "bun:test";

import { addMilliseconds, subMilliseconds } from "date-fns";
import * as v from "valibot";

import {
    authRateLimitBucketInsertSchema,
    authRateLimitBucketSelectSchema,
} from "./authRateLimitBuckets.ts";

const firstFailedAt = new Date("2026-08-05T09:00:00.000Z");
const updatedAt = addMilliseconds(firstFailedAt, 1000);
const validBucket = Object.freeze({
    blockedUntil: addMilliseconds(updatedAt, 15_000),
    bucketKey: "a".repeat(64),
    failureCount: 3,
    firstFailedAt,
    kind: "login-password-source" as const,
    updatedAt,
});

describe("authentication rate-limit row schemas", () => {
    test("accepts a canonical persisted cooldown bucket", () => {
        expect(v.parse(authRateLimitBucketInsertSchema, validBucket)).toEqual(
            validBucket
        );
        expect(v.parse(authRateLimitBucketSelectSchema, validBucket)).toEqual(
            validBucket
        );
        expect(
            v.parse(authRateLimitBucketInsertSchema, {
                ...validBucket,
                blockedUntil: null,
                failureCount: 1,
            })
        ).toBeDefined();
    });

    test.each([
        { bucketKey: "A".repeat(64) },
        { bucketKey: `${"a".repeat(64)}\0suffix` },
        { failureCount: 0 },
        { failureCount: Number.MAX_SAFE_INTEGER + 1 },
        { kind: "password" },
        { updatedAt: subMilliseconds(firstFailedAt, 1) },
        { blockedUntil: updatedAt },
    ])("rejects invalid throttle state %#", (replacement) => {
        expect(() =>
            v.parse(authRateLimitBucketInsertSchema, {
                ...validBucket,
                ...replacement,
            })
        ).toThrow();
    });
});
