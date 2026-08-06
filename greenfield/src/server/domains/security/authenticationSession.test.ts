import { describe, expect, test } from "bun:test";

import { addHours, addMinutes, subMinutes } from "date-fns";

import { browserSessionIsActive } from "./authenticationSession.ts";
import type { BrowserSessionRecord } from "./securityPersistenceTypes.ts";

const now = new Date("2026-08-05T09:00:00.000Z");
const activeSession = {
    authenticatedAt: subMinutes(now, 2),
    authenticationVersion: 1,
    authMethod: "password",
    createdAt: subMinutes(now, 2),
    expiresAt: addHours(now, 1),
    id: "a".repeat(32),
    lastSeenAt: now,
    mfaVerifiedAt: null,
    passwordVerifiedAt: subMinutes(now, 2),
    userAgent: null,
    userId: "019882a0-7000-7000-8000-000000000001",
    validatorHash: "b".repeat(64),
    validatorVersion: 1,
} satisfies BrowserSessionRecord;

describe("browser session activity policy", () => {
    test("fails closed when persisted session time is ahead of the process clock", () => {
        expect(browserSessionIsActive(activeSession, now, 30 * 60 * 1000)).toBeTrue();
        expect(
            browserSessionIsActive(
                {
                    ...activeSession,
                    createdAt: addMinutes(now, 1),
                    lastSeenAt: addMinutes(now, 1),
                },
                now,
                30 * 60 * 1000
            )
        ).toBeFalse();
        expect(
            browserSessionIsActive(
                { ...activeSession, lastSeenAt: addMinutes(now, 1) },
                now,
                30 * 60 * 1000
            )
        ).toBeFalse();
    });
});
