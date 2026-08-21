import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    bulkNotificationResultSchema,
    notificationPageMaximum,
} from "./notifications.ts";

const completedAtMs = 1_800_000_000_000;

describe("notification procedure contracts", () => {
    test("bounds every bulk acknowledgement to one notification page", () => {
        expect(
            v.parse(bulkNotificationResultSchema, {
                affectedCount: notificationPageMaximum,
                completedAtMs,
                remaining: false,
            }).affectedCount
        ).toBe(notificationPageMaximum);
        expect(
            v.safeParse(bulkNotificationResultSchema, {
                affectedCount: notificationPageMaximum + 1,
                completedAtMs,
                remaining: false,
            }).success
        ).toBeFalse();
    });

    test("allows continuation only after one complete bounded page", () => {
        expect(
            v.parse(bulkNotificationResultSchema, {
                affectedCount: notificationPageMaximum,
                completedAtMs,
                remaining: true,
            }).remaining
        ).toBeTrue();
        expect(
            v.safeParse(bulkNotificationResultSchema, {
                affectedCount: notificationPageMaximum - 1,
                completedAtMs,
                remaining: true,
            }).success
        ).toBeFalse();
    });
});
